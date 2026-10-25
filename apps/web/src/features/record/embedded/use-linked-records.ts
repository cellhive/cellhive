import { isId, tableChannel, type RecordListResponse } from '@cellhive/contracts';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../../lib/api';
import { keys, stableQueryHash } from '../../../lib/query/keys';
import { useRealtimeChannel } from '../../../lib/realtime/channels';
import { applyRecordPatch, keepPendingCells } from '../../../lib/records/realtime-merge';

import type { ChannelMessage } from '../../../lib/realtime/socket';

/**
 * The linked records a sub-table shows (T416): one `records/query` of the
 * linked table by `ids` (≤ 50, or ≤ 500 expanded), all fields the viewer
 * reads, cached as a record block of that table (`keys.recordBlocks`
 * prefix, hash `linked:…`) so that edits of the panel's sub-table, the
 * grid and realtime patches all reach it (`record-sync`, `realtime-merge`).
 * Records the viewer cannot read are simply absent (P20).
 */
export function linkedRecordsKey(
  linkTable: string,
  fieldId: string,
  recordId: string,
  ids: readonly string[],
  permissionVersion: number,
) {
  return keys.recordBlock(
    linkTable,
    `linked:${fieldId}:${recordId}:${stableQueryHash(ids)}`,
    permissionVersion,
    0,
  );
}

export interface LinkedRecordsOptions {
  readonly linkTable: string;
  readonly fieldId: string;
  readonly recordId: string;
  /** Linked records to fetch, in link order (readable ones only). */
  readonly ids: readonly string[];
  readonly permissionVersion: number;
  /** The viewer reads the linked table (else nothing is asked, FRONTEND §10.2). */
  readonly enabled: boolean;
}

export function useLinkedRecords({
  linkTable,
  fieldId,
  recordId,
  ids,
  permissionVersion,
  enabled,
}: LinkedRecordsOptions) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: linkedRecordsKey(linkTable, fieldId, recordId, ids, permissionVersion),
    queryFn: async ({ signal, client }): Promise<RecordListResponse> => {
      const data = await api.records.query(
        linkTable,
        { ids: [...ids], limit: Math.max(1, ids.length), include_total: false },
        { signal },
      );
      // Cells being written keep their optimistic value (FRONTEND §5).
      const records = keepPendingCells(client, linkTable, data.records);
      return records === data.records ? data : { ...data, records: [...records] };
    },
    enabled: enabled && ids.length > 0,
    // New ids (a link added or removed): the rows stay while the next list loads.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  // Realtime of the linked table (FRONTEND §5): edits of shown records are
  // patched in place; anything else that may change the rows refetches them.
  const shown = new Set(ids);
  const refetch = () => {
    if (enabled && ids.length > 0) void query.refetch();
  };
  const onMessage = (message: ChannelMessage) => {
    switch (message.type) {
      case 'record.updated':
        if (!shown.has(message.record_id)) return;
        // An older version than the cached copy (this tab's own write) changes nothing.
        applyRecordPatch(queryClient, linkTable, message.record_id, {
          fields: message.fields,
          version: message.version,
          recomputed: message.event_id === null,
        });
        return;
      case 'record.deleted':
      case 'record.restored':
        if (message.record_ids.some((id) => shown.has(id))) refetch();
        return;
      case 'record.batch':
        refetch();
        return;
      default:
        return;
    }
  };
  useRealtimeChannel(enabled && isId('tbl', linkTable) ? tableChannel(linkTable) : null, {
    onMessage,
    onReconnect: refetch,
  });
  return query;
}
