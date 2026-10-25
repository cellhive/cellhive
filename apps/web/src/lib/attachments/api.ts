import {
  attachmentSchema,
  createUploadResponseSchema,
  type CreateUploadRequest,
} from '@cellhive/contracts';

import { apiRequest } from '../api/client';

const id = encodeURIComponent;

/**
 * Attachment uploads (CONTRACTS §20): `createUpload` gives a presigned
 * `PUT` (signed for the exact type and size, valid 10 minutes), the file
 * goes straight to storage (`transfer.ts`), then `complete` checks it and
 * returns the attachment to write into the cell (`[{ id }]`).
 */
export const attachmentsApi = {
  createUpload: (body: CreateUploadRequest, signal?: AbortSignal) =>
    apiRequest('/files/uploads', createUploadResponseSchema, { method: 'POST', body, signal }),
  complete: (attachmentId: string, signal?: AbortSignal) =>
    apiRequest(`/files/uploads/${id(attachmentId)}/complete`, attachmentSchema, {
      method: 'POST',
      signal,
    }),
};
