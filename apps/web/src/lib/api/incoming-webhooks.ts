import { incomingWebhookListSchema } from '@cellhive/contracts';

import { apiRequest } from './client';

/**
 * `GET /bases/:id/incoming-webhooks` (CONTRACTS §25.1) with its zod schema:
 * loaded on first use by `lib/query/incoming-webhooks.ts`, so the pages that
 * only may need hook names (automation list, builder) do not carry it.
 */
export function listIncomingWebhooks(baseId: string, signal?: AbortSignal) {
  return apiRequest(
    `/bases/${encodeURIComponent(baseId)}/incoming-webhooks`,
    incomingWebhookListSchema,
    { signal },
  );
}
