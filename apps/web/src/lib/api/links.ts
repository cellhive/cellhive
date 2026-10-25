import { linkCandidatesResponseSchema } from '@cellhive/contracts';

import { apiRequest } from './client';

const id = encodeURIComponent;

/** Body of `POST /fields/:id/link-candidates` (`linkCandidatesRequestSchema`, every key optional). */
export interface LinkCandidatesBody {
  readonly search?: string | null;
  readonly offset?: number;
  readonly limit?: number;
  readonly record_id?: string | null;
  readonly ids?: readonly string[] | null;
}

/**
 * Link fields (CONTRACTS §2, T402): the records a link picker offers
 * (`POST /fields/:fieldId/link-candidates`). Used by the link picker (T413)
 * and later by the record panel sub-table (T416) and form questions. Not in
 * the shared `api` index: the app shell does not load it.
 */
export const linksApi = {
  /**
   * A page of candidates (search without accents on the primary field of
   * the linked table, `record_filter` applied), or exactly `ids` in their
   * order ("selected only", recent picks, the hover card). `404` when the
   * caller cannot read the field or the linked table.
   */
  candidates: (
    fieldId: string,
    body: LinkCandidatesBody,
    options: { signal?: AbortSignal | undefined } = {},
  ) =>
    apiRequest(`/fields/${id(fieldId)}/link-candidates`, linkCandidatesResponseSchema, {
      method: 'POST',
      body,
      signal: options.signal,
    }),
};
