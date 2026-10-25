import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../../../lib/api';
import { stableQueryHash } from '../../../lib/query/keys';

import type { ConvertFieldPreviewRequest } from '@cellhive/contracts';

/** A choice is previewed this long after the last change (typing truthy values, a name). */
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

/** Query key of a conversion preview (not shared: always fetched fresh). */
export function conversionPreviewKey(fieldId: string, body: ConvertFieldPreviewRequest | null) {
  return ['field', fieldId, 'convert-preview', stableQueryHash(body)] as const;
}

/**
 * `POST /fields/:id/convert-preview` for the definition being edited (T414):
 * debounced, and a request for an older choice is cancelled (its query is
 * left: the signal aborts it). The last answer stays on screen while the
 * next one loads (`isPlaceholderData`). `body = null`: nothing to preview.
 */
export function useConversionPreview(fieldId: string, body: ConvertFieldPreviewRequest | null) {
  const debounced = useDebounced(body, PREVIEW_DEBOUNCE_MS);
  // Nothing to preview any more: no request, whatever the debounce still holds.
  const current = body === null ? null : debounced;
  const settling = body !== null && stableQueryHash(body) !== stableQueryHash(debounced);
  const query = useQuery({
    queryKey: conversionPreviewKey(fieldId, current),
    queryFn: ({ signal }) => {
      if (current === null) throw new Error('nothing to preview');
      return api.fields.convertPreview(fieldId, current, signal);
    },
    enabled: current !== null,
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  return {
    preview: current === null ? undefined : query.data,
    /** A newer choice is waiting or loading: the preview shown is an older one. */
    stale: settling || query.isPlaceholderData || query.isFetching,
    error: query.error,
    loading:
      body !== null && (current === null || query.data === undefined) && query.error === null,
    retry: () => {
      void query.refetch();
    },
  };
}
