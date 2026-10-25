import {
  incomingWebhookListenResponseSchema,
  incomingWebhookSampleResponseSchema,
} from '@cellhive/contracts';

import { apiRequest, apiRequestVoid } from '../../../../../lib/api/client';

const id = encodeURIComponent;

/**
 * "Listen for a sample request" (CONTRACTS §25.3, BACKLOG T612) — base
 * admins only. `listen` opens a 180 s window and drops the previous sample;
 * the first valid request in the window becomes the sample and the server
 * says so with `incoming_webhook.sample_captured` on `user:<me>`. Loaded
 * with the trigger editor (its zod schemas stay out of the builder chunk).
 */
export const webhookSampleApi = {
  listen: (hookId: string) =>
    apiRequest(`/incoming-webhooks/${id(hookId)}/listen`, incomingWebhookListenResponseSchema, {
      method: 'POST',
    }),
  stop: (hookId: string) =>
    apiRequestVoid(`/incoming-webhooks/${id(hookId)}/listen`, { method: 'DELETE' }),
  sample: (hookId: string, signal?: AbortSignal) =>
    apiRequest(`/incoming-webhooks/${id(hookId)}/sample`, incomingWebhookSampleResponseSchema, {
      signal,
    }),
};
