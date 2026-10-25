import { keepPreviousData, queryOptions } from '@tanstack/react-query';

import { recordTreeApi } from '../../lib/api/record-tree';
import { keys } from '../../lib/query/keys';

import type { RecordListResponse } from '@cellhive/contracts';

/**
 * Sub-records in the record panel (T417, SPEC §5.7): the parent path, the
 * list of children and their queries. The keys sit under `keys.record` so
 * that invalidating the record (realtime, schema change, parent change)
 * refreshes them too.
 */

/** Most levels of a sub-record tree (CONTRACTS §1.4); the root is level 1. */
export const MAX_TREE_LEVELS = 10;
/** Children listed in the panel (S4 decision #4: "50 / N" beyond). */
export const CHILDREN_LIMIT = 50;

/** The parent of a record: the `id` of its `parent` cell (`{ id, title }` or `null`). */
export function parentIdOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

/** Parent path of a record, root first; refetched when its parent or version changes. */
export const ancestorsQuery = (
  tableId: string,
  recordId: string,
  parentId: string | null,
  version: number | undefined,
) =>
  queryOptions({
    queryKey: [...keys.record(tableId, recordId), 'ancestors', parentId, version ?? null] as const,
    queryFn: ({ signal }) => recordTreeApi.ancestors(tableId, recordId, { signal }),
    placeholderData: keepPreviousData,
  });

/** Prefix of the children lists of a record. */
export const childrenKey = (tableId: string, recordId: string) =>
  [...keys.record(tableId, recordId), 'children'] as const;

export const childrenQuery = (tableId: string, recordId: string) =>
  queryOptions({
    queryKey: childrenKey(tableId, recordId),
    queryFn: ({ signal }) =>
      recordTreeApi.children(tableId, recordId, { signal, offset: 0, limit: CHILDREN_LIMIT }),
  });

/** Number of children: the total when counted, else what the page holds. */
export function childCountOf(list: RecordListResponse): number {
  if ('total' in list) return list.total;
  if ('total_estimate' in list) return list.total_estimate;
  return list.records.length;
}
