import { keys } from '../query/keys';

import type { RecordCache } from './edit-controller';
import type { RecordDto, RecordListResponse } from '@cellhive/contracts';
import type { QueryClient } from '@tanstack/react-query';

/**
 * One record as every screen of a table holds it (FRONTEND §3.2): the
 * record query (`keys.record`, record panel) and every cached grid block
 * (`keys.recordBlocks`). A change made outside the grid (panel edit, value
 * revert) goes through here so the grid redraws the same values.
 */

/** The copy with the higher `version` (the other one is stale); `a` on a tie. */
export function newerRecord(
  a: RecordDto | undefined,
  b: RecordDto | undefined,
): RecordDto | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return b.version > a.version ? b : a;
}

/** The newest cached copy of a record: the record query or any grid block of the table. */
export function cachedRecord(
  queryClient: QueryClient,
  tableId: string,
  recordId: string,
): RecordDto | undefined {
  let found = queryClient.getQueryData<RecordDto>(keys.record(tableId, recordId));
  for (const [, data] of queryClient.getQueriesData<RecordListResponse>({
    queryKey: keys.recordBlocks(tableId),
  })) {
    found = newerRecord(
      found,
      data?.records.find((record) => record.id === recordId),
    );
  }
  return found;
}

/** Applies `update` to the record wherever it is cached (record query and grid blocks). */
export function updateCachedRecord(
  queryClient: QueryClient,
  tableId: string,
  recordId: string,
  update: (record: RecordDto) => RecordDto,
): void {
  queryClient.setQueryData<RecordDto>(keys.record(tableId, recordId), (record) =>
    record === undefined ? record : update(record),
  );
  queryClient.setQueriesData<RecordListResponse>(
    { queryKey: keys.recordBlocks(tableId) },
    (data) => {
      if (data === undefined) return data;
      const index = data.records.findIndex((record) => record.id === recordId);
      const current = data.records[index];
      if (current === undefined) return data;
      const records = [...data.records];
      records[index] = update(current);
      return { ...data, records };
    },
  );
}

/** Puts a record as the server returned it, wherever it is cached. */
export function putCachedRecord(queryClient: QueryClient, tableId: string, record: RecordDto) {
  queryClient.setQueryData<RecordDto>(keys.record(tableId, record.id), record);
  updateCachedRecord(queryClient, tableId, record.id, () => record);
}

/**
 * The record is gone for the user (deleted, out of reach): the grid blocks
 * reload and the record query is dropped (the panel closes).
 */
export function forgetCachedRecord(queryClient: QueryClient, tableId: string, recordId: string) {
  queryClient.removeQueries({ queryKey: keys.record(tableId, recordId), exact: true });
  void queryClient.invalidateQueries({ queryKey: keys.recordBlocks(tableId) });
}

/**
 * The edit flow's view of a record outside the grid (record panel,
 * FRONTEND §10.1): reads and writes go to the record query and to the grid
 * blocks at once. `onRemoved` hears about a record that left.
 */
export function queryRecordCache(
  queryClient: QueryClient,
  tableId: string,
  onRemoved: (recordIds: readonly string[]) => void,
): RecordCache {
  return {
    get: (recordId) => cachedRecord(queryClient, tableId, recordId),
    patch: (recordId, fields) => {
      updateCachedRecord(queryClient, tableId, recordId, (record) => ({
        ...record,
        fields: { ...record.fields, ...fields },
      }));
    },
    replace: (record) => {
      putCachedRecord(queryClient, tableId, record);
    },
    // The panel never creates records.
    append: () => null,
    remove: (recordIds) => {
      for (const recordId of recordIds) forgetCachedRecord(queryClient, tableId, recordId);
      onRemoved(recordIds);
    },
  };
}
