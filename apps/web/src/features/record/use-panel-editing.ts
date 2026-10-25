import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';

import { isEditableField } from '../../grid/editors/index';
import { api } from '../../lib/api';
import { createCellWriter, type CellWriter } from '../../lib/attachments/writer';
import { linkTargetDeleted } from '../../lib/links/values';
import {
  canCreateSelectOption,
  canEditField,
  canPickLinks,
  tableAccessOf,
} from '../../lib/permissions/access';
import { keys } from '../../lib/query/keys';
import { useOnline } from '../../lib/realtime/connection';
import { RecordEditController } from '../../lib/records/edit-controller';
import { cellKey } from '../../lib/records/edit-state';
import { cellErrorMessage, createEditNotifier, type NotifyContext } from '../../lib/records/notify';
import { cachedRecord, queryRecordCache } from '../../lib/records/record-sync';
import { locksFieldValues } from '../../lib/schema/conversion';

import type { EditorCommit, EditorContext, EditorIssue } from '../../grid/editors/types';
import type { GridField } from '../../grid/types';
import type { CommandSink } from '../../lib/records/commands';
import type { BaseDetail } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

export interface PanelEditingOptions {
  readonly base: BaseDetail;
  readonly tableId: string;
  readonly fields: readonly GridField[];
  readonly locale: LocaleContext;
  /** The record went away (deleted, out of reach): the panel closes. */
  readonly onGone: () => void;
  /** Successful edits as undo steps of the table (T205). */
  readonly onCommand?: CommandSink | undefined;
}

/** Pending write or refusal of a field of the panel. */
export type FieldState =
  | { readonly status: 'pending' }
  | { readonly status: 'error'; readonly message: string }
  | undefined;

export interface PanelEditing {
  /** Whether the field of the open record may be edited now (type, rights, lock, offline). */
  readonly canEdit: (field: GridField) => boolean;
  readonly fieldState: (recordId: string, fieldId: string) => FieldState;
  readonly commit: (recordId: string, fieldId: string, commit: EditorCommit) => void;
  readonly markInvalid: (recordId: string, fieldId: string, issue: EditorIssue) => void;
  readonly clearError: (recordId: string, fieldId: string) => void;
  readonly editorContext: EditorContext;
  /** Why nothing can be edited at the moment, or `null`. */
  readonly lockedReason: 'offline' | 'schemaLocked' | null;
  /** Attachment fields (T418): writes of the section, finished uploads appended. */
  readonly files: CellWriter;
}

interface LatestContext extends NotifyContext {
  readonly onGone: () => void;
  readonly onCommand: CommandSink | undefined;
}

/** The latest texts and callbacks for a long-lived controller. */
class Latest {
  #value: LatestContext;

  constructor(value: LatestContext) {
    this.#value = value;
  }

  get(): LatestContext {
    return this.#value;
  }

  set(value: LatestContext): void {
    this.#value = value;
  }
}

/**
 * Field editing in the record panel (FRONTEND §10.1): the same edit flow as
 * the grid (`RecordEditController`, FRONTEND §4.1: optimistic value,
 * `version`, conflict toast, error table), on the record query and the grid
 * blocks at once, so both show the same values.
 */
export function usePanelEditing({
  base,
  tableId,
  fields,
  locale,
  onGone,
  onCommand,
}: PanelEditingOptions): PanelEditing {
  const { t, i18n } = useTranslation(['record', 'grid']);
  const queryClient = useQueryClient();
  const online = useOnline();
  const access = base.access;

  // Texts, fields and the callbacks change while the controller lives.
  const [latest] = useState(() => new Latest({ i18n, fields, locale, onGone, onCommand }));
  useLayoutEffect(() => {
    latest.set({ i18n, fields, locale, onGone, onCommand });
  });

  const controller = useMemo(
    () =>
      new RecordEditController({
        tableId,
        api: api.records,
        cache: queryRecordCache(queryClient, tableId, () => {
          latest.get().onGone();
        }),
        notify: createEditNotifier(() => latest.get()),
        onCommand: (command) => {
          latest.get().onCommand?.(command);
        },
        onSchemaTouched: () => {
          void queryClient.invalidateQueries({ queryKey: keys.fields(tableId) });
        },
      }),
    [tableId, queryClient, latest],
  );

  useEffect(() => {
    controller.attach();
    return () => {
      controller.detach();
    };
  }, [controller]);

  const files = useMemo(
    () =>
      createCellWriter({
        tableId,
        controller,
        findRecord: (recordId) => cachedRecord(queryClient, tableId, recordId),
        attachFailed: () => t('grid:files.attachFailed'),
      }),
    [tableId, controller, queryClient, t],
  );

  // New fields (`schema.changed`) end a schema lock.
  useEffect(() => {
    controller.unlock();
  }, [controller, fields]);

  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const writable = tableAccessOf(access, tableId) !== undefined;
  const lockedReason = !online ? 'offline' : state.schemaLocked ? 'schemaLocked' : null;

  const canEdit = useCallback(
    (field: GridField) =>
      lockedReason === null &&
      writable &&
      isEditableField(field) &&
      // Link (T413): the picker needs the linked table (else locked chips only, P20).
      (field.link === undefined ||
        (canPickLinks(access, field.link.link_table) && !linkTargetDeleted(field.field))) &&
      // T414: a field whose values are being converted is read-only meanwhile.
      !locksFieldValues(field.field) &&
      canEditField(access, tableId, field.field.id),
    [lockedReason, writable, access, tableId],
  );

  const cells = state.cells;
  const fieldState = useCallback(
    (recordId: string, fieldId: string): FieldState => {
      const status = cells.get(cellKey(recordId, fieldId));
      if (status === undefined) return undefined;
      if (status.status === 'pending') return status;
      return { status: 'error', message: cellErrorMessage(i18n, status.error) };
    },
    [cells, i18n],
  );

  const editorContext = useMemo<EditorContext>(
    () => ({
      locale,
      orgId: base.organization_id,
      canCreateOption: (fieldId) => canCreateSelectOption(access, tableId, fieldId),
    }),
    [locale, base.organization_id, access, tableId],
  );

  return {
    canEdit,
    fieldState,
    commit: (recordId, fieldId, commit) => {
      void controller.commit({
        recordId,
        fieldId,
        value: commit.value,
        display: commit.display,
        typecast: commit.typecast,
      });
    },
    markInvalid: (recordId, fieldId, issue) => {
      controller.markInvalid(recordId, fieldId, issue);
    },
    clearError: (recordId, fieldId) => {
      controller.clearError(recordId, fieldId);
    },
    editorContext,
    lockedReason,
    files,
  };
}
