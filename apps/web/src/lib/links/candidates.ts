import { DEFAULT_LINK_CANDIDATE_LIMIT } from '@cellhive/contracts';
import { infiniteQueryOptions, type QueryClient } from '@tanstack/react-query';

import { linksApi } from '../api/links';
import { keys } from '../query/keys';

/** What a page of link candidates is asked with, without its offset. */
export interface CandidatesBody {
  readonly search: string | null;
  readonly record_id: string | null;
  readonly ids: readonly string[] | null;
}

/**
 * Pages of `POST /fields/:id/link-candidates` (CONTRACTS §2, T402), 50 at a
 * time, keyed under the linked table (`keys.linkCandidates`): the picker
 * (T413) reads them, the grid starts the first page as the picker opens.
 */
export function linkCandidatesQuery(fieldId: string, linkTable: string, body: CandidatesBody) {
  return infiniteQueryOptions({
    queryKey: keys.linkCandidates(linkTable, fieldId, body as unknown as Record<string, unknown>),
    queryFn: ({ pageParam, signal }) =>
      linksApi.candidates(
        fieldId,
        { ...body, offset: pageParam, limit: DEFAULT_LINK_CANDIDATE_LIMIT },
        { signal },
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.has_more ? last.offset + last.limit : undefined),
    staleTime: 30_000,
    retry: 1,
  });
}

/**
 * Starts the first page the picker of a cell shows (no search, the cell's
 * record) while its component mounts (T413: first results < 500 ms).
 */
export function prefetchLinkCandidates(
  queryClient: QueryClient,
  fieldId: string,
  linkTable: string,
  recordId: string | null,
  search = '',
): void {
  const trimmed = search.trim();
  queryClient
    .infiniteQuery(
      linkCandidatesQuery(fieldId, linkTable, {
        search: trimmed === '' ? null : trimmed,
        record_id: recordId,
        ids: null,
      }),
    )
    .catch(() => {
      // The picker shows the error (and retries) itself.
    });
}
