import { computedPreviewResponseSchema, type ComputedPreviewRequest } from '@cellhive/contracts';

import { apiRequest } from '../../lib/api/client';

const id = encodeURIComponent;

/**
 * `POST /tables/:tableId/computed-preview` (CONTRACTS §13, T456): the
 * definition checked like a save, computed on the first 5 records the
 * caller reads. Nothing is stored.
 */
export const lookupApi = {
  preview: (tableId: string, body: ComputedPreviewRequest, signal?: AbortSignal) =>
    apiRequest(`/tables/${id(tableId)}/computed-preview`, computedPreviewResponseSchema, {
      method: 'POST',
      body,
      signal,
    }),
};
