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

import { tableUndo } from '../../grid/undo/table-undo';
import { api } from '../../lib/api';
import { canAddRecord, canEditField } from '../../lib/permissions/access';
import { keys } from '../../lib/query/keys';
import { useOnline } from '../../lib/realtime/connection';
import { RecordEditController } from '../../lib/records/edit-controller';
import { cellKey } from '../../lib/records/edit-state';
import { cellErrorMessage, createEditNotifier, type NotifyContext } from '../../lib/records/notify';
import { cachedRecord, queryRecordCache } from '../../lib/records/record-sync';
import { showErrorToast, showToast } from '../../lib/toast/toast';

import { shiftCount, type KanbanColumnDef } from './board';
import { Latest } from './latest';
import { groupCountsQuery, pinArrivals, type BoardQuery } from './queries';

import type { BoardRefresher } from './refresh';
import type { GridField } from '../../grid/types';
import type { BaseDetail, RecordDto, RecordGroupCountsResponse } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

export interface KanbanEditingOptions {
  readonly base: BaseDetail;
  readonly query: BoardQuery;
  readonly groupField: GridField;
  /** Every field of the table (texts of the conflict toast). */
  readonly fields: readonly GridField[];
  readonly locale: LocaleContext;
  readonly refresher: BoardRefresher;
  readonly columnOf: (record: RecordDto) => string;
  /** Records that went away while written (deleted, out of reach). */
  readonly onGone: (recordIds: readonly string[]) => void;
  /** Below 768 px the board is read-only (FRONTEND §9.4). */
  readonly readOnly: boolean;
}

/** Why cards cannot be moved (the card menu says so instead of listing columns). */
export type MoveBlock = 'narrow' | 'offline' | 'locked' | 'readOnly';

export interface KanbanEditing {
  readonly controller: RecordEditController;
  /** Cards may be moved: the group field is editable for this user (rights, online, width). */
  readonly canMove: boolean;
  /** Why {@link canMove} is `false`; `null` when cards can be moved. */
  readonly moveBlocked: MoveBlock | null;
  /** "Add card" in a column: `add` on the table and the group field writable on create. */
  readonly canAdd: boolean;
  /** Moves a card to another column (a `PATCH` of the group field, optimistic). */
  readonly move: (recordId: string, to: KanbanColumnDef) => Promise<void>;
  /** Creates a record in a column (group value filled in); resolves its id, or `null`. */
  readonly create: (column: KanbanColumnDef) => Promise<string | null>;
  /** A card whose move is on its way. */
  readonly isMoving: (recordId: string) => boolean;
}

interface LatestContext extends NotifyContext {
  readonly onGone: (recordIds: readonly string[]) => void;
}

function idempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

/**
 * Moving and adding cards (T314). A move is a cell write of the group
 * field through `RecordEditController` (FRONTEND §4.1): optimistic, sent
 * with the record's `version`, `409` → conflict toast, `403` → toast, the
 * card goes back on any refusal, and a success is an undo step of the
 * table (T205). The group counts move at once and are fetched again once
 * the write settles, with the column the card left.
 */
export function useKanbanEditing({
  base,
  query,
  groupField,
  fields,
  locale,
  refresher,
  columnOf,
  onGone,
  readOnly,
}: KanbanEditingOptions): KanbanEditing {
  const { i18n, t } = useTranslation(['kanban', 'grid']);
  const queryClient = useQueryClient();
  const online = useOnline();
  const { tableId } = query;
  const access = base.access;

  // Texts, fields and callbacks change while the controller lives.
  const [latest] = useState(() => new Latest<LatestContext>({ i18n, fields, locale, onGone }));
  useLayoutEffect(() => {
    latest.set({ i18n, fields, locale, onGone });
  });

  const controller = useMemo(
    () =>
      new RecordEditController({
        tableId,
        api: api.records,
        cache: queryRecordCache(queryClient, tableId, (recordIds) => {
          latest.get().onGone(recordIds);
        }),
        notify: createEditNotifier(() => latest.get()),
        onCommand: (command) => {
          tableUndo(tableId).hooks.push(command);
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

  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const groupFieldId = groupField.field.id;

  // A refused value (`422`: option removed meanwhile…) has no cell to mark on a board: toast.
  useEffect(() => {
    const suffix = cellKey('', groupFieldId);
    for (const [key, status] of state.cells) {
      if (status.status !== 'error' || !key.endsWith(suffix)) continue;
      const recordId = key.slice(0, -suffix.length);
      showToast({
        variant: 'error',
        message: t('kanban:move.refused', { reason: cellErrorMessage(i18n, status.error) }),
      });
      controller.clearError(recordId, groupFieldId);
    }
  }, [state.cells, groupFieldId, controller, i18n, t]);

  const moveBlocked: MoveBlock | null = readOnly
    ? 'narrow'
    : !online
      ? 'offline'
      : state.schemaLocked
        ? 'locked'
        : // Select and user fields are writable types; `config: null` is a type the client cannot edit.
          groupField.config === null || !canEditField(access, tableId, groupFieldId)
          ? 'readOnly'
          : null;
  const canMove = moveBlocked === null;
  const canAdd =
    !readOnly &&
    online &&
    canAddRecord(access, tableId) &&
    canEditField(access, tableId, groupFieldId, 'create');

  const shift = useCallback(
    (from: string | null, to: KanbanColumnDef) => {
      queryClient.setQueryData<RecordGroupCountsResponse>(
        groupCountsQuery(query).queryKey,
        (data) =>
          data === undefined ? data : shiftCount(data, groupField.field, query.kind, { from, to }),
      );
    },
    [queryClient, query, groupField],
  );

  const move = useCallback(
    async (recordId: string, to: KanbanColumnDef) => {
      const record = cachedRecord(queryClient, tableId, recordId);
      if (record === undefined) return;
      const from = columnOf(record);
      if (from === to.key) return;
      // Stays on the board in its new column even once the old column is reloaded.
      pinArrivals(queryClient, query, [record]);
      shift(from, to);
      await controller.commit({
        recordId,
        fieldId: groupFieldId,
        value: to.writeValue,
        display: to.display,
      });
      refresher.columns([from]);
    },
    [queryClient, tableId, columnOf, query, shift, controller, groupFieldId, refresher],
  );

  const create = useCallback(
    async (column: KanbanColumnDef) => {
      let created: RecordDto | undefined;
      try {
        const response = await api.records.create(
          tableId,
          [{ fields: column.kind === 'empty' ? {} : { [groupFieldId]: column.writeValue } }],
          { idempotencyKey: idempotencyKey() },
        );
        created = response.records[0];
      } catch (error) {
        showErrorToast(error);
        return null;
      }
      refresher.counts();
      // Created but not readable by the user (record rules): nothing to show.
      if (created === undefined) return null;
      pinArrivals(queryClient, query, [created]);
      shift(null, column);
      tableUndo(tableId).hooks.push({ kind: 'create', tableId, recordIds: [created.id] });
      return created.id;
    },
    [tableId, groupFieldId, refresher, queryClient, query, shift],
  );

  const cells = state.cells;
  const isMoving = useCallback(
    (recordId: string) => cells.get(cellKey(recordId, groupFieldId))?.status === 'pending',
    [cells, groupFieldId],
  );

  return { controller, canMove, moveBlocked, canAdd, move, create, isMoving };
}
