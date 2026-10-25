import {
  httpAllowlistEntrySchema,
  httpAllowlistSchema,
  secretWithValueSchema,
  type CreateHttpAllowlistEntryInput,
  type CreateSecretInput,
  type UpdateSecretRequest,
} from '@cellhive/contracts';
import { queryOptions } from '@tanstack/react-query';

import { apiRequest, apiRequestVoid } from '../../../lib/api/client';

const id = encodeURIComponent;

/**
 * Query keys of the page (kept here, not in `lib/query/keys.ts`, which the
 * app shell bundles). The secrets list reuses `keys.orgSecrets` (T516).
 */
export const integrationKeys = {
  allowlist: (orgId: string) => ['org', orgId, 'http-allowlist'] as const,
};

/** The organization's outbound HTTP allowlist (CONTRACTS §25.4, BACKLOG T600). */
export const httpAllowlistApi = {
  list: (orgId: string, signal?: AbortSignal) =>
    apiRequest(`/orgs/${id(orgId)}/http-allowlist`, httpAllowlistSchema, { signal }),
  create: (orgId: string, body: CreateHttpAllowlistEntryInput) =>
    apiRequest(`/orgs/${id(orgId)}/http-allowlist`, httpAllowlistEntrySchema, {
      method: 'POST',
      body,
    }),
  remove: (entryId: string) =>
    apiRequestVoid(`/http-allowlist/${id(entryId)}`, { method: 'DELETE' }),
};

export const allowlistQuery = (orgId: string, enabled: boolean) =>
  queryOptions({
    queryKey: integrationKeys.allowlist(orgId),
    queryFn: ({ signal }) => httpAllowlistApi.list(orgId, signal),
    enabled,
  });

/**
 * Create / change an HTTP secret (CONTRACTS §24, T606): the response may
 * carry the generated `value` (`generate: true`) — once. `lib/api/secrets`
 * reads the plain `Secret` schema, which drops it in development builds.
 */
export const httpSecretsApi = {
  create: (orgId: string, body: CreateSecretInput) =>
    apiRequest(`/orgs/${id(orgId)}/secrets`, secretWithValueSchema, { method: 'POST', body }),
  update: (secretId: string, body: UpdateSecretRequest) =>
    apiRequest(`/secrets/${id(secretId)}`, secretWithValueSchema, { method: 'PATCH', body }),
};
