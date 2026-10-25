import { queryOptions, type QueryClient } from '@tanstack/react-query';

import { api } from '../../lib/api';
import { keys, recordQueryHash } from '../../lib/query/keys';
import { keepPendingCells } from '../../lib/records/realtime-merge';

import { columnFilter, type GroupFieldKind } from './board';

import type { RecordDto, RecordListResponse } from '@cellhive/contracts';

/**
 * Data of a kanban board (FRONTEND §11.1: never every record). Each column
 * loads pages of {@link KANBAN_PAGE_SIZE} cards through the view (`view_id`)
 * with a filter on its group value; the counts come from
 * `POST …/records/group-counts`. Pages live under `keys.recordBlocks` like
 * grid blocks, so edits of the record panel, the edit flow and realtime
 * patches (`lib/records`) reach the cards without extra wiring.
 */

/** Cards per page of a column. */
export const KANBAN_PAGE_SIZE = 50;

export interface BoardQuery {
  readonly tableId: string;
  readonly viewId: string;
  readonly permissionVersion: number;
  readonly groupFieldId: string;
  readonly kind: GroupFieldKind;
  /** Effective sort of the view (saved ⊕ temporary), sent like the grid does. */
  readonly sort: readonly { readonly field: string; readonly direction: 'asc' | 'desc' }[];
}

/** Hash part of the page keys of one column (prefix `['table', id, 'records', hash]`). */
export function columnHash(query: BoardQuery, column: string): string {
  return `kanban:${recordQueryHash({
    view_id: query.viewId,
    filter: columnFilter(query.groupFieldId, query.kind, column),
    sort: query.sort,
  })}`;
}

/** Query-key prefix of every page of one column (every permission version). */
export function columnPrefix(query: BoardQuery, column: string) {
  return [...keys.recordBlocks(query.tableId), columnHash(query, column)] as const;
}

/** Whether a record-block key is a page of a kanban board (not a grid block). */
export function isKanbanKey(queryKey: readonly unknown[]): boolean {
  const hash = queryKey[3];
  return typeof hash === 'string' && hash.startsWith('kanban');
}

export const kanbanPageQuery = (query: BoardQuery, column: string, index: number) =>
  queryOptions({
    queryKey: keys.recordBlock(
      query.tableId,
      columnHash(query, column),
      query.permissionVersion,
      index,
    ),
    queryFn: async ({ signal, client }): Promise<RecordListResponse> => {
      const data = await api.records.query(
        query.tableId,
        {
          view_id: query.viewId,
          filter: columnFilter(query.groupFieldId, query.kind, column),
          sort: query.sort.length === 0 ? null : query.sort.map((item) => ({ ...item })),
          offset: index * KANBAN_PAGE_SIZE,
          limit: KANBAN_PAGE_SIZE,
          include_total: false,
        },
        { signal },
      );
      // Cells being written keep their optimistic value (FRONTEND §5).
      const records = keepPendingCells(client, query.tableId, data.records);
      return records === data.records ? data : { ...data, records: [...records] };
    },
  });

/** Hash of the group counts of a board (view + group field). */
export function countsHash(query: BoardQuery): string {
  return recordQueryHash({
    view_id: query.viewId,
    group: [{ field: query.groupFieldId, direction: 'asc' }],
  });
}

export const groupCountsQuery = (query: BoardQuery) =>
  queryOptions({
    queryKey: keys.groupCounts(query.tableId, countsHash(query), query.permissionVersion),
    queryFn: ({ signal }) =>
      api.records.groupCounts(
        query.tableId,
        { view_id: query.viewId, group: [{ field: query.groupFieldId, direction: 'asc' }] },
        { signal },
      ),
  });

/**
 * Records moved or added during the session (drag, realtime, "add card"):
 * a record-block entry of its own, so every copy of the record stays in
 * sync, shown at the top of its column (`placeCards`).
 */
export function arrivalsKey(query: BoardQuery) {
  return keys.recordBlock(
    query.tableId,
    `kanban-arrivals:${query.viewId}:${query.groupFieldId}`,
    query.permissionVersion,
    0,
  );
}

const NO_ARRIVALS: RecordListResponse = { records: [], offset: 0, limit: KANBAN_PAGE_SIZE };

export const arrivalsQuery = (query: BoardQuery) =>
  queryOptions({
    queryKey: arrivalsKey(query),
    // Nothing to fetch: the entry is written by the board (a refetch keeps it).
    queryFn: ({ client }) =>
      client.getQueryData<RecordListResponse>(arrivalsKey(query)) ?? NO_ARRIVALS,
    staleTime: Infinity,
    gcTime: Infinity,
  });

/** Puts records at the top of the arrivals (a newer copy replaces an older one). */
export function pinArrivals(
  queryClient: QueryClient,
  query: BoardQuery,
  records: readonly RecordDto[],
): void {
  if (records.length === 0) return;
  queryClient.setQueryData<RecordListResponse>(arrivalsKey(query), (data) => {
    const ids = new Set(records.map((record) => record.id));
    const rest = (data?.records ?? []).filter((record) => !ids.has(record.id));
    return { ...(data ?? NO_ARRIVALS), records: [...records, ...rest] };
  });
}

/** Drops records from every page and the arrivals of the table's boards (deleted, out of view). */
export function dropBoardRecords(
  queryClient: QueryClient,
  tableId: string,
  recordIds: readonly string[],
): void {
  if (recordIds.length === 0) return;
  const ids = new Set(recordIds);
  queryClient.setQueriesData<RecordListResponse>(
    { queryKey: keys.recordBlocks(tableId), predicate: (item) => isKanbanKey(item.queryKey) },
    (data) => {
      if (data === undefined || !data.records.some((record) => ids.has(record.id))) return data;
      return { ...data, records: data.records.filter((record) => !ids.has(record.id)) };
    },
  );
}
