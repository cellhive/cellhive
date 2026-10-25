import { meIdentityListSchema, oidcLinkStartResponseSchema } from '@cellhive/contracts';
import { queryOptions } from '@tanstack/react-query';

import { apiRequest, apiRequestVoid } from '../../../lib/api/client';
import { keys } from '../../../lib/query/keys';

/** Connected accounts of the signed-in user (CONTRACTS §27.3); session only. */
export const connectionsApi = {
  list: (signal?: AbortSignal) => apiRequest('/me/identities', meIdentityListSchema, { signal }),
  /** `POST` with `X-CSRF-Token` (added by the client): where the browser goes next. */
  startLink: (provider: string) =>
    apiRequest(
      `/me/identities/${encodeURIComponent(provider)}/start`,
      oidcLinkStartResponseSchema,
      { method: 'POST', retryOnRateLimit: false },
    ),
  remove: (identityId: string) =>
    apiRequestVoid(`/me/identities/${encodeURIComponent(identityId)}`, { method: 'DELETE' }),
};

export const meIdentitiesQuery = () =>
  queryOptions({
    queryKey: keys.meIdentities(),
    queryFn: ({ signal }) => connectionsApi.list(signal),
  });
