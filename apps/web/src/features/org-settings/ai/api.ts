import {
  aiSettingsSchema,
  aiSettingsTestResultSchema,
  aiUsageSchema,
  type AiSettingsDto,
  type OrganizationDetailDto,
  type TestAiSettingsRequest,
  type UpdateAiSettingsRequest,
} from '@cellhive/contracts';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../../lib/api/client';
import { keys } from '../../../lib/query/keys';

const id = encodeURIComponent;

/** Query keys of the page (here, not in `lib/query/keys.ts`, which the app shell bundles). */
export const aiKeys = {
  settings: (orgId: string) => ['org', orgId, 'ai-settings'] as const,
  usage: (orgId: string) => ['org', orgId, 'ai-usage'] as const,
};

/** AI settings, "Test connection" and usage of an organization (CONTRACTS §29.1): owners/admins. */
export const aiSettingsApi = {
  get: (orgId: string, signal?: AbortSignal) =>
    apiRequest(`/orgs/${id(orgId)}/ai-settings`, aiSettingsSchema, { signal }),
  update: (orgId: string, body: UpdateAiSettingsRequest) =>
    apiRequest(`/orgs/${id(orgId)}/ai-settings`, aiSettingsSchema, { method: 'PUT', body }),
  test: (orgId: string, body: TestAiSettingsRequest) =>
    apiRequest(`/orgs/${id(orgId)}/ai-settings/test`, aiSettingsTestResultSchema, {
      method: 'POST',
      body,
    }),
  /** The default range: the last 30 days up to today in the organization time zone. */
  usage: (orgId: string, signal?: AbortSignal) =>
    apiRequest(`/orgs/${id(orgId)}/ai-usage`, aiUsageSchema, { signal }),
};

export const aiSettingsQuery = (orgId: string) =>
  queryOptions({
    queryKey: aiKeys.settings(orgId),
    queryFn: ({ signal }) => aiSettingsApi.get(orgId, signal),
    staleTime: 0,
  });

export const aiUsageQuery = (orgId: string) =>
  queryOptions({
    queryKey: aiKeys.usage(orgId),
    queryFn: ({ signal }) => aiSettingsApi.usage(orgId, signal),
    staleTime: 0,
  });

/**
 * `PUT …/ai-settings`: the page's settings, the quota of the usage card and
 * `ai` of `GET /orgs/:id` — what every AI entry point reads
 * (`useAiAvailability`) — follow at once.
 */
export function useUpdateAiSettings(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAiSettingsRequest) => aiSettingsApi.update(orgId, body),
    onSuccess: async (saved: AiSettingsDto) => {
      queryClient.setQueryData(aiKeys.settings(orgId), saved);
      queryClient.setQueryData<OrganizationDetailDto>(keys.org(orgId), (org) =>
        org === undefined
          ? undefined
          : {
              ...org,
              ai: {
                available: saved.available,
                record_data: saved.available && saved.allow_record_data,
              },
            },
      );
      await queryClient.invalidateQueries({ queryKey: aiKeys.usage(orgId) });
    },
  });
}

/** "Test connection": it uses a few tokens and may store the detected output rung. */
export function useTestAiSettings(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TestAiSettingsRequest) => aiSettingsApi.test(orgId, body),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: aiKeys.usage(orgId) }),
        queryClient.invalidateQueries({ queryKey: aiKeys.settings(orgId) }),
      ]),
  });
}
