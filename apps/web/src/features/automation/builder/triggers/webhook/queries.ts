import { queryOptions } from '@tanstack/react-query';

import { incomingWebhookKeys } from '../../../../../lib/query/incoming-webhooks';

/**
 * Key of a hook's sample: under the hooks of the base, so refreshing the
 * list refreshes it too.
 */
export const sampleKey = (baseId: string, hookId: string) =>
  [...incomingWebhookKeys.list(baseId), hookId, 'sample'] as const;

/**
 * The sample and the open window of a hook (CONTRACTS §25.3); read again
 * when the window gets the focus back. The API module loads on first use.
 */
export function sampleQuery(baseId: string, hookId: string) {
  return queryOptions({
    queryKey: sampleKey(baseId, hookId),
    queryFn: async ({ signal }) => (await import('./api')).webhookSampleApi.sample(hookId, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
