import {
  incomingWebhookListSchema,
  incomingWebhookRequestListSchema,
  incomingWebhookSchema,
  incomingWebhookWithSecretsSchema,
  type CreateIncomingWebhookRequest,
  type UpdateIncomingWebhookRequest,
} from '@cellhive/contracts';

import { apiRequest, apiRequestVoid } from '../../../lib/api/client';

const id = encodeURIComponent;

/**
 * Incoming webhook management (CONTRACTS §25.1, BACKLOG T611) — base admins
 * only. The signing secret and the Bearer token only come back from the call
 * that issues them (`create`, `rotateSecret`, `setBearer`); nothing reads
 * them again. Calls that issue a secret send an `Idempotency-Key`: a retry
 * after a lost answer replays the same secret instead of issuing a second one.
 */
export const incomingWebhooksApi = {
  list: (baseId: string, signal?: AbortSignal) =>
    apiRequest(`/bases/${id(baseId)}/incoming-webhooks`, incomingWebhookListSchema, { signal }),
  create: (baseId: string, body: CreateIncomingWebhookRequest, idempotencyKey: string) =>
    apiRequest(`/bases/${id(baseId)}/incoming-webhooks`, incomingWebhookWithSecretsSchema, {
      method: 'POST',
      body,
      idempotencyKey,
    }),
  update: (hookId: string, body: UpdateIncomingWebhookRequest) =>
    apiRequest(`/incoming-webhooks/${id(hookId)}`, incomingWebhookSchema, {
      method: 'PATCH',
      body,
    }),
  remove: (hookId: string) =>
    apiRequestVoid(`/incoming-webhooks/${id(hookId)}`, { method: 'DELETE' }),
  rotateSecret: (hookId: string, idempotencyKey: string) =>
    apiRequest(`/incoming-webhooks/${id(hookId)}/rotate-secret`, incomingWebhookWithSecretsSchema, {
      method: 'POST',
      idempotencyKey,
    }),
  regenerateToken: (hookId: string) =>
    apiRequest(`/incoming-webhooks/${id(hookId)}/regenerate-token`, incomingWebhookSchema, {
      method: 'POST',
    }),
  setBearer: (hookId: string) =>
    apiRequest(`/incoming-webhooks/${id(hookId)}/bearer`, incomingWebhookWithSecretsSchema, {
      method: 'PUT',
    }),
  removeBearer: (hookId: string) =>
    apiRequest(`/incoming-webhooks/${id(hookId)}/bearer`, incomingWebhookSchema, {
      method: 'DELETE',
    }),
  requests: (
    hookId: string,
    page: { readonly cursor?: string | undefined; readonly limit?: number },
    signal?: AbortSignal,
  ) =>
    apiRequest(`/incoming-webhooks/${id(hookId)}/requests`, incomingWebhookRequestListSchema, {
      query: { cursor: page.cursor, limit: page.limit },
      signal,
    }),
};
