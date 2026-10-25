import { queryOptions } from '@tanstack/react-query';

/**
 * The incoming webhooks of a base (CONTRACTS §25.1), shared by their
 * settings page (T611), the automation list (hook names) and the builder's
 * `webhook.received` trigger (T612). Base admins only — callers enable the
 * query for them. Not in `keys.ts`: the public share page bundles that file
 * and must not grow (T611).
 */
export const incomingWebhookKeys = {
  /** `GET /bases/:id/incoming-webhooks`; prefix of every query of a hook (requests, sample). */
  list: (baseId: string) => ['base', baseId, 'incoming-webhooks'] as const,
};

/**
 * No realtime for hooks: pages refetch on focus and after their own
 * changes; `staleTime 0` because another admin may change them at any time.
 * The API module (with its zod schema) loads on first use.
 */
export function incomingWebhooksQuery(baseId: string) {
  return queryOptions({
    queryKey: incomingWebhookKeys.list(baseId),
    queryFn: async ({ signal }) =>
      (await import('../api/incoming-webhooks')).listIncomingWebhooks(baseId, signal),
    staleTime: 0,
  });
}
