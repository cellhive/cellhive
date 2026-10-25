import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { incomingWebhookKeys } from '../../../lib/query/incoming-webhooks';

import type {
  IncomingWebhookDto,
  IncomingWebhookList,
  IncomingWebhookWithSecretsDto,
} from '@cellhive/contracts';

/**
 * Query keys of the feature (F§3.2 shape, under the base like
 * `keys.baseEmailIdentities`). Kept here rather than in `lib/query/keys.ts`,
 * which the public share page bundles: this page must not grow it (T611).
 */
export const hookKeys = {
  /** `GET /bases/:id/incoming-webhooks` (CONTRACTS §25.1); prefix of a hook's requests. */
  list: incomingWebhookKeys.list,
  /** `GET /incoming-webhooks/:id/requests` pages (the request log). */
  requests: (baseId: string, hookId: string) =>
    ['base', baseId, 'incoming-webhooks', hookId, 'requests'] as const,
};

/** The hooks of a base: shared with the automation builder and list (T612). */
export { incomingWebhooksQuery } from '../../../lib/query/incoming-webhooks';

/** Puts a hook returned by a mutation into the list (no secret is ever cached), then refetches. */
export function useHookCache(baseId: string) {
  const queryClient = useQueryClient();
  const put = useCallback(
    (hook: IncomingWebhookDto) => {
      // Never cache `signing_secret` / `bearer_token` of a response that issued them.
      const stored: IncomingWebhookDto = { ...hook };
      delete (stored as Partial<IncomingWebhookWithSecretsDto>).signing_secret;
      delete (stored as Partial<IncomingWebhookWithSecretsDto>).bearer_token;
      queryClient.setQueryData<IncomingWebhookList>(hookKeys.list(baseId), (list) => {
        if (list === undefined) return list;
        const exists = list.items.some((item) => item.id === stored.id);
        return {
          items: exists
            ? list.items.map((item) => (item.id === stored.id ? stored : item))
            : [...list.items, stored],
        };
      });
      void queryClient.invalidateQueries({ queryKey: hookKeys.list(baseId) });
    },
    [baseId, queryClient],
  );
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: hookKeys.list(baseId) });
  }, [baseId, queryClient]);
  return { put, refresh };
}
