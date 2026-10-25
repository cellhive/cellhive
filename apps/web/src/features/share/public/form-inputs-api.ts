import {
  createUploadResponseSchema,
  shareFormUploadSchema,
  shareLinkCandidatesSchema,
  type ShareFormUploadRequest,
} from '@cellhive/contracts';

import { apiRequest } from '../../../lib/api/client';

import type { ShareApi } from './api';

/**
 * Link and file questions of a form link (T410, CONTRACTS §17), loaded with
 * the form only (the share page's first load stays small).
 */

function path(api: ShareApi, rest: string): string {
  return `/shares/${encodeURIComponent(api.token)}${rest}`;
}

/** `GET /shares/:token/link-candidates/:fieldId`: records a link question of an `org` form link offers. */
export function linkCandidates(
  api: ShareApi,
  fieldId: string,
  query: { readonly search: string; readonly offset: number },
  signal?: AbortSignal,
) {
  return apiRequest(
    path(api, `/link-candidates/${encodeURIComponent(fieldId)}`),
    shareLinkCandidatesSchema,
    {
      query: { ...(query.search === '' ? {} : { search: query.search }), offset: query.offset },
      signal,
    },
  );
}

/** `POST /shares/:token/uploads`: a file of an attachment question, bound to the submit token. */
export function createUpload(api: ShareApi, body: ShareFormUploadRequest, signal?: AbortSignal) {
  return apiRequest(path(api, '/uploads'), createUploadResponseSchema, {
    method: 'POST',
    body,
    signal,
    headers: api.csrfHeaders(),
  });
}

/** `POST /shares/:token/uploads/:attachmentId/complete`. */
export function completeUpload(
  api: ShareApi,
  attachmentId: string,
  submitToken: string | undefined,
  signal?: AbortSignal,
) {
  return apiRequest(
    path(api, `/uploads/${encodeURIComponent(attachmentId)}/complete`),
    shareFormUploadSchema,
    {
      method: 'POST',
      body: submitToken === undefined ? {} : { submit_token: submitToken },
      signal,
      headers: api.csrfHeaders(),
    },
  );
}
