import {
  MAX_LIST_LIMIT,
  viewListSchema,
  viewSchema,
  type createViewRequestSchema,
  type DuplicateViewRequest,
  type UpdateViewRequest,
} from '@cellhive/contracts';

import { apiRequest, apiRequestVoid, UNCHECKED_SCHEMA } from './client';

import type { z } from 'zod';

/** Responses are checked in development only (FRONTEND §3.1); production builds drop the schemas (T700). */
const DEV = import.meta.env.DEV;
const id = encodeURIComponent;

/** `POST /tables/:id/views` body as sent (`is_personal` defaults to `false`). */
export type CreateViewBody = z.input<typeof createViewRequestSchema>;

/** Saved views (CONTRACTS §15). Views the caller cannot see are absent (and `404`). */
export const viewsApi = {
  /** Shared views by `position`, then the caller's personal views (at most 200 per table). */
  list: (tableId: string, signal?: AbortSignal) =>
    apiRequest(`/tables/${id(tableId)}/views`, DEV ? viewListSchema : UNCHECKED_SCHEMA, {
      query: { offset: 0, limit: MAX_LIST_LIMIT },
      signal,
    }),
  get: (viewId: string, signal?: AbortSignal) =>
    apiRequest(`/views/${id(viewId)}`, DEV ? viewSchema : UNCHECKED_SCHEMA, { signal }),
  create: (tableId: string, body: CreateViewBody) =>
    apiRequest(`/tables/${id(tableId)}/views`, DEV ? viewSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
    }),
  update: (viewId: string, body: UpdateViewRequest) =>
    apiRequest(`/views/${id(viewId)}`, DEV ? viewSchema : UNCHECKED_SCHEMA, {
      method: 'PATCH',
      body,
    }),
  duplicate: (viewId: string, body: DuplicateViewRequest = {}) =>
    apiRequest(`/views/${id(viewId)}/duplicate`, DEV ? viewSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
    }),
  remove: (viewId: string) => apiRequestVoid(`/views/${id(viewId)}`, { method: 'DELETE' }),
};
