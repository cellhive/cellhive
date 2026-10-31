import {
  apiTokenListSchema,
  apiTokenSchema,
  createdApiTokenSchema,
  DEFAULT_API_TOKEN_POLICY,
  DEFAULT_MCP_POLICY,
  organizationSchema,
  orgApiTokenListSchema,
  type ApiTokenPolicy,
  type ApiTokenStatus,
  type CreateApiTokenRequest,
  type McpPolicy,
  type OrganizationDetailDto,
  type OrganizationDto,
} from '@cellhive/contracts';
import { infiniteQueryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiRequest, apiRequestVoid } from '../../../lib/api/client';
import { keys } from '../../../lib/query/keys';

const id = encodeURIComponent;
const PAGE_SIZE = 50;

/**
 * Query keys of the page (kept here, not in `lib/query/keys.ts`, which the
 * app shell bundles). Lists hold metadata only: a created token's value is
 * never written to the query cache (FRONTEND §12).
 */
export const apiTokenKeys = {
  all: (orgId: string) => ['org', orgId, 'api-tokens'] as const,
  mine: (orgId: string) => [...apiTokenKeys.all(orgId), 'mine'] as const,
  org: (orgId: string, filters: OrgTokenFilters) =>
    [...apiTokenKeys.all(orgId), 'org', filters] as const,
};

/** The two policies of the page in `PATCH /orgs/:id { settings }`: keys left out keep their value. */
export interface PolicySettings {
  readonly api_tokens?: Partial<ApiTokenPolicy>;
  readonly mcp?: Partial<McpPolicy>;
}

export interface OrgTokenFilters {
  readonly user_id?: string | undefined;
  readonly status?: ApiTokenStatus | undefined;
}

/** Personal API tokens (CONTRACTS §26.4, T703): session only. */
export const apiTokensApi = {
  listMine: (orgId: string, cursor: string | undefined, signal?: AbortSignal) =>
    apiRequest(`/orgs/${id(orgId)}/me/api-tokens`, apiTokenListSchema, {
      query: { cursor, limit: PAGE_SIZE },
      signal,
    }),
  listOrg: (
    orgId: string,
    filters: OrgTokenFilters,
    cursor: string | undefined,
    signal?: AbortSignal,
  ) =>
    apiRequest(`/orgs/${id(orgId)}/api-tokens`, orgApiTokenListSchema, {
      query: { ...filters, cursor, limit: PAGE_SIZE },
      signal,
    }),
  create: (orgId: string, body: CreateApiTokenRequest, idempotencyKey: string) =>
    apiRequest(`/orgs/${id(orgId)}/me/api-tokens`, createdApiTokenSchema, {
      method: 'POST',
      body,
      idempotencyKey,
    }),
  rename: (tokenId: string, name: string) =>
    apiRequest(`/api-tokens/${id(tokenId)}`, apiTokenSchema, {
      method: 'PATCH',
      body: { name },
    }),
  revoke: (tokenId: string) => apiRequestVoid(`/api-tokens/${id(tokenId)}`, { method: 'DELETE' }),
  setPolicy: (orgId: string, settings: PolicySettings) =>
    apiRequest(`/orgs/${id(orgId)}`, organizationSchema, {
      method: 'PATCH',
      body: { settings },
    }),
};

export const myTokensQuery = (orgId: string) =>
  infiniteQueryOptions({
    queryKey: apiTokenKeys.mine(orgId),
    queryFn: ({ pageParam, signal }) => apiTokensApi.listMine(orgId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: 0,
  });

export const orgTokensQuery = (orgId: string, filters: OrgTokenFilters) =>
  infiniteQueryOptions({
    queryKey: apiTokenKeys.org(orgId, filters),
    queryFn: ({ pageParam, signal }) => apiTokensApi.listOrg(orgId, filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: 0,
  });

/** `settings.api_tokens` of an organization (older payloads without it: the defaults). */
export function policyOf(org: Pick<OrganizationDto, 'settings'> | undefined): ApiTokenPolicy {
  return (
    (org?.settings as { api_tokens?: ApiTokenPolicy } | undefined)?.api_tokens ??
    DEFAULT_API_TOKEN_POLICY
  );
}

/** `settings.mcp` of an organization (CONTRACTS §30.1; older payloads without it: off). */
export function mcpPolicyOf(org: Pick<OrganizationDto, 'settings'> | undefined): McpPolicy {
  return (org?.settings as { mcp?: McpPolicy } | undefined)?.mcp ?? DEFAULT_MCP_POLICY;
}

/** Revoke a token (owner, or org owner/admin): every list of the page reloads. */
export function useRevokeToken(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => apiTokensApi.revoke(tokenId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: apiTokenKeys.all(orgId) }),
  });
}

export function useSetTokenPolicy(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: PolicySettings) => apiTokensApi.setPolicy(orgId, settings),
    onSuccess: (org) => {
      // `PATCH` answers without `ai` (T912): keep the one of `GET /orgs/:id`.
      queryClient.setQueryData<OrganizationDetailDto>(keys.org(orgId), (old) =>
        old === undefined ? undefined : { ...old, ...org },
      );
    },
  });
}
