import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../../lib/api';
import { keys, stableQueryHash } from '../../lib/query/keys';
import { tableQuery } from '../../lib/query/queries';

import { lookupApi } from './api';

import type { ComputedPreviewRequest } from '@cellhive/contracts';

/** A definition is previewed this long after the last change (BACKLOG T466/T467). */
export const PREVIEW_DEBOUNCE_MS = 300;

/** `value`, once it stopped changing for `delay` ms (compared by content). */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  const hash = stableQueryHash(value);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(value);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
    // The hash stands for the value: a new object with the same content is not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, delay]);
  return debounced;
}

/**
 * `POST /tables/:id/computed-preview` for the definition being edited:
 * debounced; a request for an older definition is cancelled (its query
 * loses its observer, TanStack aborts the signal). The last answer stays
 * on screen, marked stale, while the next one loads. `body = null`: the
 * definition is not complete, nothing to preview.
 */
export function useLookupPreview(tableId: string, body: ComputedPreviewRequest | null) {
  const debounced = useDebounced(body, PREVIEW_DEBOUNCE_MS);
  const current = body === null ? null : debounced;
  const settling = body !== null && stableQueryHash(body) !== stableQueryHash(debounced);
  const query = useQuery({
    queryKey: keys.computedPreview(tableId, stableQueryHash(current)),
    queryFn: ({ signal }) => {
      if (current === null) throw new Error('nothing to preview');
      return lookupApi.preview(tableId, current, signal);
    },
    enabled: current !== null,
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  return {
    preview: current === null ? undefined : query.data,
    /** A newer definition is waiting or loading: the preview shown is an older one. */
    stale: settling || query.isPlaceholderData || query.isFetching,
    /** Error of the current definition (not of an older one). */
    error: current === null || settling ? null : query.error,
    loading:
      body !== null && (current === null || query.data === undefined) && query.error === null,
    retry: () => {
      void query.refetch();
    },
  };
}

/**
 * Titles (primary field as text) of the preview's records, with the
 * caller's rights: one `records/query { ids }`.
 */
export function useRecordTitles(tableId: string, ids: readonly string[]) {
  const table = useQuery(tableQuery(tableId));
  const primary = table.data?.primary_field_id;
  const unique = useMemo(() => [...new Set(ids)].sort(), [ids]);
  const titles = useQuery({
    queryKey: [...keys.recordBlocks(tableId), 'titles', primary ?? '', unique] as const,
    queryFn: ({ signal }) =>
      api.records.query(
        tableId,
        { ids: unique, fields: [primary ?? ''], limit: unique.length, include_total: false },
        { signal, cellFormat: 'text' },
      ),
    enabled: primary !== undefined && unique.length > 0,
    staleTime: 30_000,
  });
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const record of titles.data?.records ?? []) {
      const value = primary === undefined ? undefined : record.fields[primary];
      map.set(record.id, typeof value === 'string' ? value : '');
    }
    return map;
  }, [titles.data, primary]);
}
