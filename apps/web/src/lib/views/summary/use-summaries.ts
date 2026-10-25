import { keepPreviousData, queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { api } from '../../api';
import { keys, stableQueryHash, type EffectiveRecordQuery } from '../../query/keys';
import { sameValue } from '../config';

import type { ChannelMessage } from '../../realtime/socket';
import type { RecordSummariesRequest, SummaryFunction } from '@cellhive/contracts';

/**
 * Data of the summary bar (T472, FRONTEND §3.3 "thanh thống kê"): `POST
 * …/records/summaries` with the grid's view, filter, search and group, and
 * the summaries when they differ from the saved ones (a temporary change,
 * S4b decision 8). Realtime record messages and recomputed values of the
 * table ask again after a 500 ms window (not per message); the numbers on
 * screen stay until the new ones arrive (`keepPreviousData`), so nothing
 * flickers.
 */
export const SUMMARY_REFRESH_MS = 500;

export interface SummaryRequestInput {
  /** The grid's effective record query (`viewRecordQuery`). */
  readonly query: EffectiveRecordQuery;
  /** Summaries on screen (saved ⊕ temporary), and the saved ones. */
  readonly summaries: Readonly<Record<string, SummaryFunction>>;
  readonly saved: Readonly<Record<string, SummaryFunction>> | undefined;
}

/** The body of `records/summaries` for the grid (field ids, JSON values). */
export function summaryRequestOf({
  query,
  summaries,
  saved,
}: SummaryRequestInput): RecordSummariesRequest {
  return {
    view_id: query.view_id ?? null,
    ...(query.filter === undefined || query.filter === null ? {} : { filter: query.filter }),
    ...(query.filter_mode === undefined ? {} : { filter_mode: query.filter_mode }),
    ...(query.search === undefined || query.search === null || query.search === ''
      ? {}
      : { search: query.search }),
    ...(query.group === undefined || query.group === null
      ? {}
      : {
          group: query.group.map((item) => ({
            field: item.field,
            direction: item.direction ?? ('asc' as const),
          })),
        }),
    // Unchanged: the saved ones (the server skips entries no longer valid).
    ...(sameValue(summaries, saved ?? {}) ? {} : { summaries: { ...summaries } }),
  };
}

export const summariesQuery = (
  tableId: string,
  request: RecordSummariesRequest,
  permissionVersion: number,
) =>
  queryOptions({
    queryKey: keys.summaries(tableId, stableQueryHash(request), permissionVersion),
    queryFn: ({ signal }) => api.records.summaries(tableId, request, { signal }),
    placeholderData: keepPreviousData,
    // A timeout is shown in the bar ("—", Retry); no silent retries.
    retry: false,
    staleTime: 30_000,
  });

/** Whether a realtime message of the table may change the summaries. */
export function changesSummaries(message: ChannelMessage): boolean {
  return message.type.startsWith('record.') || message.type === 'computed.recomputing';
}

export interface SummariesOptions {
  readonly tableId: string;
  readonly request: RecordSummariesRequest;
  readonly permissionVersion: number;
  /** Nothing to summarise and no count needed (no bar on screen). */
  readonly enabled?: boolean;
}

export function useSummaries({
  tableId,
  request,
  permissionVersion,
  enabled = true,
}: SummariesOptions) {
  const queryClient = useQueryClient();
  const options = useMemo(
    () => summariesQuery(tableId, request, permissionVersion),
    [tableId, request, permissionVersion],
  );
  const result = useQuery({ ...options, enabled });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const refresh = useCallback(() => {
    // Messages ride along in one window; the fetch after it sees them all.
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void queryClient.invalidateQueries({
        queryKey: keys.summaryLists(tableId),
        refetchType: 'active',
      });
    }, SUMMARY_REFRESH_MS);
  }, [queryClient, tableId]);
  const onMessage = useCallback(
    (message: ChannelMessage) => {
      if (changesSummaries(message)) refresh();
    },
    [refresh],
  );
  return {
    data: result.data,
    /** New numbers are on their way (old ones shown dimmed). */
    busy: result.isFetching,
    error: result.error,
    retry: () => {
      void result.refetch();
    },
    onMessage,
    refresh,
  };
}
