import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { api } from '../api';
import { keepPendingCells } from '../records/realtime-merge';

import { keys, recordQueryHash, type EffectiveRecordQuery } from './keys';

/** Rows per grid block (FRONTEND §3.3). */
export const RECORD_BLOCK_SIZE = 200;

/** `offset`/`limit` of block `index`. */
export function recordBlockRange(index: number): { offset: number; limit: number } {
  return { offset: index * RECORD_BLOCK_SIZE, limit: RECORD_BLOCK_SIZE };
}

/**
 * Shared query options of the data every table screen needs (FRONTEND §3.2).
 * Keys come from `keys`; features spread these into `useQuery` and add their
 * own options (`enabled`, `select`…).
 */
/**
 * A base with `permission_version` and the caller's `access` (CONTRACTS §5A):
 * the permission helpers of `lib/permissions` read it.
 */
export const baseQuery = (baseId: string) =>
  queryOptions({
    queryKey: keys.base(baseId),
    queryFn: ({ signal }) => api.bases.get(baseId, signal),
  });

export const tablesQuery = (baseId: string) =>
  queryOptions({
    queryKey: keys.tables(baseId),
    queryFn: ({ signal }) => api.tables.list(baseId, signal),
  });

/** (T469) Tables of the base in the trash (base admins only: the caller enables it). */
export const tableTrashQuery = (baseId: string) =>
  queryOptions({
    queryKey: keys.tableTrash(baseId),
    queryFn: ({ signal }) => api.tables.trash(baseId, signal),
  });

export const tableQuery = (tableId: string) =>
  queryOptions({
    queryKey: keys.tableMeta(tableId),
    queryFn: ({ signal }) => api.tables.get(tableId, signal),
  });

export const fieldsQuery = (tableId: string) =>
  queryOptions({
    queryKey: keys.fields(tableId),
    queryFn: ({ signal }) => api.fields.list(tableId, signal),
  });

/**
 * Views of a table the caller sees (CONTRACTS §15): shared by position, then
 * personal. Each carries its full config (fields the caller cannot read are
 * left out), so the open view is read from this list.
 */
export const viewsQuery = (tableId: string) =>
  queryOptions({
    queryKey: keys.views(tableId),
    queryFn: ({ signal }) => api.views.list(tableId, signal),
  });

/** Fields of a table with the restorable deleted ones (`deleted_at` set), for schema managers. */
export const fieldTrashQuery = (tableId: string) =>
  queryOptions({
    queryKey: keys.fieldTrash(tableId),
    queryFn: ({ signal }) => api.fields.listWithTrash(tableId, signal),
  });

/**
 * (T320b) How many records of the table the caller reads (read rule only:
 * no view, filter or search), from `records/query` with one row and no
 * field. `estimated` above 100 000 rows (CONTRACTS §1.1). Shared by the
 * sidebar and the footer of a filtered grid, so it is asked once per table,
 * then again when shown and older than 5 min (the footer: 30 s). Decorative
 * and approximate; record messages of the table's `table:` channel ask it
 * again, once per window (T420, `lib/realtime/record-counts.ts`).
 */
export const tableRecordCountQuery = (tableId: string) =>
  queryOptions({
    queryKey: keys.tableRecordCount(tableId),
    queryFn: async ({ signal }) => {
      const page = await api.records.query(tableId, { limit: 1, fields: [] }, { signal });
      if ('total' in page) return { count: page.total, estimated: false };
      if ('total_estimate' in page) return { count: page.total_estimate, estimated: true };
      return { count: page.records.length, estimated: true };
    },
    staleTime: 5 * 60_000,
  });

export const recordQuery = (tableId: string, recordId: string) =>
  queryOptions({
    queryKey: keys.record(tableId, recordId),
    queryFn: async ({ signal, client }) => {
      const record = await api.records.get(tableId, recordId, { signal });
      // Cells being written keep their optimistic value (FRONTEND §5).
      return keepPendingCells(client, tableId, [record])[0] ?? record;
    },
  });

/**
 * One block of rows of the grid (FRONTEND §3.3). The key carries the
 * query hash and the base `permission_version`, so a change of either is a
 * different cache entry. Only block 0 asks for the row count.
 * `group` (a temporary group) replaces the view's for the request (CONTRACTS
 * §1.4); `filter_mode` / `sort_mode` are sent only when set (T311).
 */
export const recordBlockQuery = (
  tableId: string,
  query: EffectiveRecordQuery,
  permissionVersion: number,
  index: number,
) =>
  queryOptions({
    queryKey: keys.recordBlock(tableId, recordQueryHash(query), permissionVersion, index),
    queryFn: async ({ signal, client }) => {
      const data = await api.records.query(
        tableId,
        {
          view_id: query.view_id ?? null,
          filter: query.filter ?? null,
          ...(query.filter_mode === undefined ? {} : { filter_mode: query.filter_mode }),
          sort: query.sort === undefined || query.sort === null ? null : [...query.sort],
          ...(query.sort_mode === undefined ? {} : { sort_mode: query.sort_mode }),
          search: query.search ?? null,
          ...(query.group === undefined || query.group === null ? {} : { group: [...query.group] }),
          fields: query.fields === undefined || query.fields === null ? null : [...query.fields],
          ...recordBlockRange(index),
          include_total: index === 0,
        },
        { signal },
      );
      // Cells being written keep their optimistic value (FRONTEND §5).
      const records = keepPendingCells(client, tableId, data.records);
      return records === data.records ? data : { ...data, records: [...records] };
    },
  });

export const recordHistoryQuery = (tableId: string, recordId: string, fieldId?: string) =>
  infiniteQueryOptions({
    queryKey: keys.recordHistory(recordId, fieldId),
    queryFn: ({ signal, pageParam }) =>
      api.records.history(tableId, recordId, { signal, cursor: pageParam, field: fieldId }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  });

export const recordTrashQuery = (tableId: string) =>
  infiniteQueryOptions({
    queryKey: keys.recordTrash(tableId),
    queryFn: ({ signal, pageParam }) => api.records.trash(tableId, { signal, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  });

/** An organization and its defaults (new currency fields use its currency). */
/** Names of the bases of an organization (`{ id, name }`): settings pages of the organization. */
export const orgBasesQuery = (orgId: string) =>
  queryOptions({
    queryKey: keys.orgBaseNames(orgId),
    queryFn: ({ signal }) => api.orgs.bases(orgId, signal),
    staleTime: 60_000,
  });

export const orgQuery = (orgId: string) =>
  queryOptions({
    queryKey: keys.org(orgId),
    queryFn: ({ signal }) => api.orgs.get(orgId, signal),
    staleTime: 5 * 60_000,
  });

/** Members of an organization for the user pickers; they rarely change during a session. */
export const orgMembersQuery = (orgId: string) =>
  queryOptions({
    queryKey: keys.orgMembers(orgId),
    queryFn: ({ signal }) => api.orgs.members(orgId, signal),
    staleTime: 5 * 60_000,
  });

export const orgGroupsQuery = (orgId: string) =>
  queryOptions({
    queryKey: keys.orgGroups(orgId),
    queryFn: ({ signal }) => api.orgs.groups(orgId, signal),
    staleTime: 5 * 60_000,
  });

export const jobQuery = (jobId: string) =>
  queryOptions({
    queryKey: keys.job(jobId),
    queryFn: ({ signal }) => api.jobs.get(jobId, signal),
  });
