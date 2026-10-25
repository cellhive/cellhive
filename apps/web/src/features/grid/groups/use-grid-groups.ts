import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { keys, recordQueryHash, type EffectiveRecordQuery } from '../../../lib/query/keys';
import { RECORD_BLOCK_SIZE } from '../../../lib/query/queries';
import { PREFETCH_DISTANCE, type RowRange } from '../blocks/block-math';

import { useGroupCollapse, type GroupCollapse } from './collapse';
import { GroupRowModel } from './group-model';
import { gridGroupCountsQuery, groupCountsHash } from './queries';

import type { GridField, GridViewport } from '../../../grid';
import type { ChannelMessage } from '../../../lib/realtime/socket';
import type { BlockSnapshot, RecordBlockLoader } from '../blocks/block-loader';
import type { RecordDto } from '@cellhive/contracts';

/** Realtime changes that move rows between groups are applied this long after the last one. */
export const GROUP_REFRESH_MS = 150;

/** The rows of a grid in data rows (what the grid, clipboard and panel use). */
export interface GroupedRows {
  readonly getRecord: (row: number) => RecordDto | undefined;
  readonly rowOf: (recordId: string) => number | undefined;
  readonly loadRows: (firstRow: number, lastRow: number) => Promise<(RecordDto | undefined)[]>;
  readonly findRecord: (recordId: string) => RecordDto | undefined;
}

export interface GridGroupsOptions {
  readonly tableId: string;
  readonly viewId: string;
  readonly userId: string | null;
  readonly query: EffectiveRecordQuery;
  readonly permissionVersion: number;
  /** Effective group levels of the view (saved ⊕ temporary). */
  readonly levels: readonly { readonly field: string }[];
  /** Every field of the table (the header of a hidden field still shows its value). */
  readonly fields: readonly GridField[];
  readonly loader: RecordBlockLoader;
  readonly snapshot: BlockSnapshot;
  /** Narrow screens list records without headers: nothing stays collapsed there. */
  readonly ignoreCollapse: boolean;
  /** A "+" row ends every expanded group (the user may add records, T320a). */
  readonly addRows?: boolean;
}

export interface GridGroups {
  /** The view groups rows (levels set). */
  readonly active: boolean;
  /** Layout of the grouped rows once counted; `null` when not grouped or still counting. */
  readonly model: GroupRowModel | null;
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: unknown;
  readonly collapse: GroupCollapse;
  /** Data rows of the grouped layout (only meaningful with a `model`). */
  readonly rows: GroupedRows;
  /** The grid's viewport in data rows: loads the server rows it shows. */
  readonly setViewport: (viewport: GridViewport) => void;
  /** Counts the groups again (and so the layout). */
  readonly refresh: () => void;
  /** Realtime messages of the table (`useGridRealtime`'s `onMessage`). */
  readonly onMessage: (message: ChannelMessage) => void;
}

/**
 * Grouped rows of a grid view (T312, FRONTEND §3.3). The group counts of
 * the grid's query give the layout (`GroupRowModel`); the viewport, in data
 * rows, becomes server row ranges for the block loader, so collapsed groups
 * are never fetched. The counts are fetched again whenever the grid's
 * blocks are (realtime batches, removals, reconnects, reloads after an
 * edit), and a realtime change of a group value or a new record refetches
 * the rows shown, so counts and rows move together.
 */
export function useGridGroups({
  tableId,
  viewId,
  userId,
  query,
  permissionVersion,
  levels,
  fields,
  loader,
  snapshot,
  ignoreCollapse,
  addRows = false,
}: GridGroupsOptions): GridGroups {
  const queryClient = useQueryClient();
  const active = levels.length > 0;
  const collapse = useGroupCollapse(userId, viewId);
  const countsHash = groupCountsHash(query);
  const counts = useQuery({
    ...gridGroupCountsQuery(tableId, query, permissionVersion),
    enabled: active,
    // A new permission version counts again: the old layout stays meanwhile.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === countsHash ? previous : undefined,
  });

  const fieldById = useMemo(
    () => new Map(fields.map((field) => [field.field.id, field])),
    [fields],
  );
  const data = active ? counts.data : undefined;
  const truncated = data?.truncated === true;
  // Only a truncated count needs the query's total (the rest group).
  const total = truncated && snapshot.status === 'ready' ? snapshot.rowCount : null;
  const isCollapsed = collapse.isCollapsed;
  const model = useMemo(() => {
    if (data === undefined || data.group.length === 0) return null;
    return new GroupRowModel({
      levels: data.group.map((item) => ({ fieldId: item.field, direction: item.direction })),
      groups: data.groups,
      truncated: data.truncated,
      total,
      fields: fieldById,
      isCollapsed: ignoreCollapse ? () => false : isCollapsed,
      addRows,
    });
  }, [data, total, fieldById, ignoreCollapse, isCollapsed, addRows]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: keys.groupCounts(tableId, countsHash, permissionVersion),
      exact: true,
    });
  }, [queryClient, tableId, countsHash, permissionVersion]);

  // Blocks of this grid fetched again (not loaded for the first time): the
  // rows may have moved, so the groups are counted again.
  const refreshLater = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const blockHash = recordQueryHash(query);
  useEffect(() => {
    if (!active) return;
    const cache = queryClient.getQueryCache();
    const prefix = keys.recordBlocks(tableId);
    const unsubscribe = cache.subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'fetch') return;
      const key = event.query.queryKey as readonly unknown[];
      if (key[0] !== prefix[0] || key[1] !== prefix[1] || key[2] !== prefix[2]) return;
      if (key[3] !== blockHash || event.query.state.data === undefined) return;
      clearTimeout(refreshLater.current);
      refreshLater.current = setTimeout(refresh, 50);
    });
    return () => {
      unsubscribe();
      clearTimeout(refreshLater.current);
    };
  }, [active, queryClient, tableId, blockHash, refresh]);

  // Realtime (FRONTEND §5): a group value changed or a record arrived — the
  // rows shown are fetched again (which counts again): a record lands in its
  // group instead of the "new rows" pill, counts never drift from rows.
  const groupFieldIds = useMemo(() => new Set(data?.group.map((item) => item.field) ?? []), [data]);
  const refetchLater = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(refetchLater.current);
    },
    [],
  );
  const onMessage = useCallback(
    (message: ChannelMessage) => {
      if (model === null) return;
      const moves =
        (message.type === 'record.updated' &&
          Object.keys(message.fields).some((fieldId) => groupFieldIds.has(fieldId))) ||
        message.type === 'record.created' ||
        message.type === 'record.added';
      if (!moves) return;
      clearTimeout(refetchLater.current);
      refetchLater.current = setTimeout(() => {
        loader.refetchVisible(true);
      }, GROUP_REFRESH_MS);
    },
    [model, groupFieldIds, loader],
  );

  // Viewport: data rows → server row ranges (rows of collapsed groups skipped).
  const viewport = useRef<GridViewport | null>(null);
  const apply = useCallback(
    (range: GridViewport, rows: GroupRowModel) => {
      const { firstRow, lastRow, dragging } = range;
      const visible = rows.offsetRanges(firstRow, lastRow);
      const needed = rows.offsetRanges(
        firstRow - RECORD_BLOCK_SIZE,
        lastRow + RECORD_BLOCK_SIZE + PREFETCH_DISTANCE,
      );
      const clamp = (row: number) => Math.min(Math.max(0, row), Math.max(0, rows.dataCount - 1));
      const first = rows.offsetOf(clamp(firstRow)) ?? 0;
      const last = rows.offsetOf(clamp(lastRow)) ?? first;
      const span: RowRange = { firstRow: first, lastRow: Math.max(first, last) };
      loader.setViewport(span, dragging, { visible, needed });
    },
    [loader],
  );
  const setViewport = useCallback(
    (range: GridViewport) => {
      viewport.current = range;
      if (model !== null) {
        apply(range, model);
        return;
      }
      // Not grouped after all (every level on a field the user cannot read): plain rows.
      if (active && data !== undefined && data.group.length === 0) {
        loader.setViewport({ firstRow: range.firstRow, lastRow: range.lastRow }, range.dragging);
      } else if (!active) {
        loader.setViewport({ firstRow: range.firstRow, lastRow: range.lastRow }, range.dragging);
      }
    },
    [model, apply, active, data, loader],
  );
  // The layout arrived or changed: load what the last viewport shows now.
  useEffect(() => {
    if (model !== null && viewport.current !== null) apply(viewport.current, model);
  }, [model, apply]);
  useEffect(() => {
    loader.setServerOrdered(active);
  }, [loader, active]);

  const rows = useMemo<GroupedRows>(
    () => ({
      getRecord: (row) => {
        const offset = model?.offsetOf(row);
        return offset === undefined ? undefined : loader.getRecord(offset);
      },
      rowOf: (recordId) => {
        const offset = loader.rowOf(recordId);
        return offset === undefined ? undefined : model?.dataRowOf(offset);
      },
      loadRows: async (firstRow, lastRow) => {
        if (model === null) return [];
        const ranges = model.offsetRanges(firstRow, lastRow);
        const loaded = await Promise.all(
          ranges.map((range) => loader.loadRows(range.firstRow, range.lastRow)),
        );
        const records = loaded.flat();
        const length = Math.max(0, lastRow - firstRow + 1);
        return Array.from({ length }, (_, index) => records[index]);
      },
      findRecord: (recordId) => loader.findRecord(recordId),
    }),
    // A new block version changes nothing here: the functions read the loader.
    [model, loader],
  );

  const status: GridGroups['status'] = !active
    ? 'ready'
    : counts.data !== undefined
      ? 'ready'
      : counts.isError
        ? 'error'
        : 'loading';
  return {
    active,
    model,
    status,
    error: counts.error,
    collapse,
    rows,
    setViewport,
    refresh,
    onMessage,
  };
}
