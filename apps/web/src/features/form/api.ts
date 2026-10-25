import {
  baseMemberListSchema,
  createUploadResponseSchema,
  formCoverSchema,
  formSubmissionStatusSchema,
  formSubmitResponseSchema,
  type FormCoverUploadRequest,
  type FormSubmitRequest,
} from '@cellhive/contracts';
import { queryOptions } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api/client';
import { keys } from '../../lib/query/keys';

/**
 * Form submissions of members (CONTRACTS §17): `POST /views/:viewId/submit`.
 * One `Idempotency-Key` per submission, so a retried request never adds a
 * second record. The link route (`/shares/:token/submit`) belongs to the
 * share page (T317).
 */
export const formsApi = {
  submit: (viewId: string, body: FormSubmitRequest) =>
    apiRequest(`/views/${encodeURIComponent(viewId)}/submit`, formSubmitResponseSchema, {
      method: 'POST',
      body,
      idempotencyKey: `web-${crypto.randomUUID()}`,
    }),
  /** `GET /views/:viewId/submission-status` (T320): the limit already reached? */
  submissionStatus: (viewId: string, signal?: AbortSignal) =>
    apiRequest(
      `/views/${encodeURIComponent(viewId)}/submission-status`,
      formSubmissionStatusSchema,
      { signal },
    ),
  /** `GET /bases/:baseId/members` (T320): the people who can open the base. */
  baseMembers: (baseId: string, signal?: AbortSignal) =>
    apiRequest(`/bases/${encodeURIComponent(baseId)}/members`, baseMemberListSchema, { signal }),
  /** `POST /views/:viewId/form-cover/uploads` (T419): a presigned `PUT` for a cover image. */
  createCoverUpload: (viewId: string, body: FormCoverUploadRequest, signal?: AbortSignal) =>
    apiRequest(
      `/views/${encodeURIComponent(viewId)}/form-cover/uploads`,
      createUploadResponseSchema,
      { method: 'POST', body, signal },
    ),
  /** `POST /views/:viewId/form-cover/uploads/:id/complete` (T419): the cover, checked. */
  completeCoverUpload: (viewId: string, attachmentId: string, signal?: AbortSignal) =>
    apiRequest(
      `/views/${encodeURIComponent(viewId)}/form-cover/uploads/${encodeURIComponent(attachmentId)}/complete`,
      formCoverSchema,
      { method: 'POST', signal },
    ),
};

/**
 * Whether the member already reached the form's limit: asked when the form
 * opens (never cached across visits: a submission elsewhere changes it).
 */
export const submissionStatusQuery = (viewId: string) =>
  queryOptions({
    queryKey: keys.formSubmissionStatus(viewId),
    queryFn: ({ signal }) => formsApi.submissionStatus(viewId, signal),
    staleTime: 0,
    gcTime: 0,
  });

/**
 * People a `user` question offers: only those who can open the base. Under
 * `['base', id]`, so a permission change (which invalidates the base)
 * refreshes it too.
 */
export const baseMembersQuery = (baseId: string) =>
  queryOptions({
    queryKey: keys.baseMembers(baseId),
    queryFn: ({ signal }) => formsApi.baseMembers(baseId, signal),
    staleTime: 60_000,
  });
