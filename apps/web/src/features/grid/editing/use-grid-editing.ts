import { type LocaleContext } from '@cellhive/field-types';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../lib/api';
import { uploads } from '../../../lib/attachments/uploads';
import { cellFilesOf } from '../../../lib/attachments/value';
import { createCellWriter } from '../../../lib/attachments/writer';
import { linkTargetDeleted } from '../../../lib/links/values';
import {
  canAddRecord,
  canCreateSelectOption,
  canDeleteRecord,
  canDownloadFile,
  canEditField,
  canPickLinks,
  tableAccessOf,
} from '../../../lib/permissions/access';
import { keys } from '../../../lib/query/keys';
import { useOnline } from '../../../lib/realtime/connection';
import { RecordEditController, type RecordCache } from '../../../lib/records/edit-controller';
import { cellKey } from '../../../lib/records/edit-state';
import {
  cellErrorMessage,
  createEditNotifier,
  type NotifyContext,
} from '../../../lib/records/notify';
import { showToast } from '../../../lib/toast/toast';

import { blockRecordCache } from './record-cache';

import type {
  CellEditHooks,
  FileEditorContext,
  FileHooks,
  GridField,
  UndoHooks,
} from '../../../grid';
import type { AttachmentUi } from '../../../lib/attachments/ui';
import type { RecordBlockLoader } from '../blocks/block-loader';
import type { BaseDetail, RecordDto } from '@cellhive/contracts';

export interface GridEditingOptions {
  readonly base: BaseDetail;
  readonly tableId: string;
  readonly fields: readonly GridField[];
  readonly loader: RecordBlockLoader;
  readonly locale: LocaleContext;
  /** T205: every successful change as an undo command. */
  readonly undo?: UndoHooks | undefined;
  /**
   * Where the edit flow reads and writes records instead of the loader's
   * blocks (T417: the levels of a sub-record tree).
   */
  readonly cache?: RecordCache | undefined;
  /** T418: the attachment popover (`features/attachment`, given by the route). */
  readonly attachments?: AttachmentUi | undefined;
  /** T414: fields whose values are being converted: read-only meanwhile. */
  readonly lockedFields?: ReadonlySet<string> | undefined;
  /** T414: why such a field is read-only (shown on Enter, F2, typing). */
  readonly lockedFieldHint?: string | undefined;
}

export interface GridEditing {
  /** The edit flow of this grid; realtime (T204) skips cells it reports `isPending`. */
  readonly controller: RecordEditController;
  /** `undefined` when the user may not write this table (the grid stays read-only). */
  readonly hooks: CellEditHooks | undefined;
  readonly canAdd: boolean;
  readonly canDelete: boolean;
  /** `409 SCHEMA_LOCKED`: editing is locked, a banner explains (FRONTEND §4.1). */
  readonly schemaLocked: boolean;
  readonly unlock: () => void;
  /** Adds a record; resolves with its row (to focus it), or `null`. */
  readonly addRecord: () => Promise<number | null>;
  /** Moves records to the trash; resolves with how many went. */
  readonly deleteRecords: (recordIds: readonly string[]) => Promise<number>;
  /** T418: files dropped on or pasted into attachment cells; `undefined` when none may be edited. */
  readonly fileHooks: FileHooks | undefined;
}

/** Text of a record's primary field (the viewer's header, T418). */
function titleOf(record: RecordDto | undefined, primary: GridField | undefined): string {
  if (record === undefined || primary === undefined) return '';
  const value = record.fields[primary.field.id];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

interface NotifierContext {
  readonly i18n: NotifyContext['i18n'];
  readonly fields: readonly GridField[];
  readonly locale: LocaleContext;
  readonly undo: UndoHooks | undefined;
}

/** The latest texts and fields for callbacks of a long-lived controller. */
class Latest {
  #value: NotifierContext;

  constructor(value: NotifierContext) {
    this.#value = value;
  }

  get(): NotifierContext {
    return this.#value;
  }

  set(value: NotifierContext): void {
    this.#value = value;
  }
}

/** The edit controller of a grid: toasts of the FRONTEND §4.1 error table. */
function createController(
  tableId: string,
  cache: RecordCache,
  queryClient: QueryClient,
  latest: Latest,
): RecordEditController {
  const notify = createEditNotifier(() => latest.get());
  return new RecordEditController({
    tableId,
    api: api.records,
    cache,
    notify,
    onCommand: (command) => {
      latest.get().undo?.push(command);
    },
    onSchemaTouched: () => {
      void queryClient.invalidateQueries({ queryKey: keys.fields(tableId) });
    },
  });
}

/**
 * Cell editing of the grid page (FRONTEND §4.1, §7): the edit controller of
 * `lib/records` on the block cache, the rights of `lib/permissions`, the
 * toasts of the error table and the hooks `GridView` takes.
 */
export function useGridEditing({
  base,
  tableId,
  fields,
  loader,
  locale,
  undo,
  cache,
  attachments,
  lockedFields,
  lockedFieldHint,
}: GridEditingOptions): GridEditing {
  const { t, i18n } = useTranslation('grid');
  const queryClient = useQueryClient();
  const online = useOnline();
  const access = base.access;

  // Texts and fields change while the controller lives: the notifier reads the latest.
  const [latest] = useState(() => new Latest({ i18n, fields, locale, undo }));
  useLayoutEffect(() => {
    latest.set({ i18n, fields, locale, undo });
  });

  const controller = useMemo(
    () => createController(tableId, cache ?? blockRecordCache(loader), queryClient, latest),
    [tableId, loader, cache, queryClient, latest],
  );

  useEffect(() => {
    controller.attach();
    return () => {
      controller.detach();
    };
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  // New fields (`schema.changed`, T204/T207) end a schema lock.
  useEffect(() => {
    controller.unlock();
  }, [controller, fields]);

  const locked = state.schemaLocked || !online;
  const writable = tableAccessOf(access, tableId) !== undefined;
  // Link fields whose linked table the user cannot read: locked chips only (T413, P20).
  const unpickable = useMemo(
    () =>
      new Set<string>(
        fields.flatMap((field) =>
          field.link !== undefined &&
          // The linked table unreadable, or in the trash (T421a): no picker.
          (!canPickLinks(access, field.link.link_table) || linkTargetDeleted(field.field))
            ? [field.field.id]
            : [],
        ),
      ),
    [fields, access],
  );
  const canEditColumn = useCallback(
    (fieldId: string) =>
      !locked &&
      !unpickable.has(fieldId) &&
      lockedFields?.has(fieldId) !== true &&
      canEditField(access, tableId, fieldId),
    [access, tableId, locked, unpickable, lockedFields],
  );
  const canEdit = useCallback(
    (cell: { fieldId: string }) => canEditColumn(cell.fieldId),
    [canEditColumn],
  );
  const anyEditable = fields.some((field) => canEditField(access, tableId, field.field.id));

  // T418: attachment cells write through the same controller, reading the grid's rows.
  const writer = useMemo(
    () =>
      createCellWriter({
        tableId,
        controller,
        findRecord: (recordId) => loader.findRecord(recordId),
        attachFailed: () => t('files.attachFailed'),
      }),
    [tableId, controller, loader, t],
  );
  const primary = fields.find((field) => field.field.is_primary);
  const files = useMemo<FileEditorContext>(
    () => ({
      tableId,
      Editor: attachments?.CellEditor,
      canDownload: (fieldId) => canDownloadFile(access, tableId, fieldId),
      read: (recordId, fieldId) => loader.findRecord(recordId)?.fields[fieldId],
      subscribe: loader.subscribe,
      write: writer.write,
      host: writer.host,
      recordTitle: (recordId) => titleOf(loader.findRecord(recordId), primary),
    }),
    [tableId, attachments, access, loader, writer, primary],
  );
  const fieldsById = useMemo(
    () => new Map<string, GridField>(fields.map((field) => [field.field.id, field])),
    [fields],
  );
  const fileHooks = useMemo<FileHooks | undefined>(() => {
    if (!writable || attachments === undefined) return undefined;
    return {
      accepts: (cell) =>
        fieldsById.get(cell.fieldId)?.config?.type === 'attachment' && canEditColumn(cell.fieldId),
      onFiles: (cell, picked) => {
        const config = fieldsById.get(cell.fieldId)?.config;
        const record = loader.findRecord(cell.recordId);
        if (config?.type !== 'attachment' || record === undefined) return;
        uploads.add(
          { tableId, recordId: cell.recordId, fieldId: cell.fieldId },
          picked,
          config.options,
          cellFilesOf(record.fields[cell.fieldId]).length,
          writer.host(cell.recordId, cell.fieldId),
        );
      },
    };
  }, [writable, attachments, fieldsById, canEditColumn, loader, tableId, writer]);

  const cells = state.cells;
  const hooks = useMemo<CellEditHooks | undefined>(() => {
    if (!writable || !anyEditable) return undefined;
    return {
      canEdit,
      canEditField: canEditColumn,
      onCommit: (cell, value, _record, options) => {
        void controller.commit({
          recordId: cell.recordId,
          fieldId: cell.fieldId,
          value,
          display: options?.display === undefined ? value : options.display,
          typecast: options?.typecast === true,
          ...(options?.baseVersion === undefined ? {} : { baseVersion: options.baseVersion }),
        });
      },
      onInvalid: (cell, issue) => {
        controller.markInvalid(cell.recordId, cell.fieldId, issue);
      },
      cellState: (cell) => {
        const status = cells.get(cellKey(cell.recordId, cell.fieldId));
        if (status === undefined) return undefined;
        if (status.status === 'pending') return status;
        return { status: 'error', message: cellErrorMessage(i18n, status.error) };
      },
      hasCellStates: cells.size > 0,
      editorContext: {
        locale,
        orgId: base.organization_id,
        canCreateOption: (fieldId) => canCreateSelectOption(access, tableId, fieldId),
        files,
      },
      readOnlyHint: t(
        locked ? (online ? 'edit.lockedHint' : 'edit.offlineHint') : 'edit.readOnlyHint',
      ),
      ...(lockedFields === undefined || lockedFields.size === 0 || lockedFieldHint === undefined
        ? {}
        : {
            fieldReadOnlyHint: (fieldId: string) =>
              lockedFields.has(fieldId) ? lockedFieldHint : undefined,
          }),
    };
  }, [
    writable,
    anyEditable,
    canEdit,
    canEditColumn,
    controller,
    cells,
    i18n,
    locale,
    base.organization_id,
    access,
    tableId,
    t,
    locked,
    online,
    files,
    lockedFields,
    lockedFieldHint,
  ]);

  const addRecord = useCallback(async () => {
    const created = await controller.create();
    return created?.row ?? null;
  }, [controller]);

  const deleteRecords = useCallback(
    async (recordIds: readonly string[]) => {
      const count = await controller.remove(recordIds);
      if (count > 0) showToast({ variant: 'success', message: t('edit.deleted', { count }) });
      return count;
    },
    [controller, t],
  );

  return {
    controller,
    hooks,
    canAdd: !locked && canAddRecord(access, tableId),
    canDelete: !locked && canDeleteRecord(access, tableId),
    schemaLocked: state.schemaLocked,
    unlock: () => {
      controller.unlock();
    },
    addRecord,
    deleteRecords,
    fileHooks,
  };
}
