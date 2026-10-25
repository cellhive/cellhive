import {
  emailSettingsSchema,
  emailTestResultSchema,
  type EmailSettingsDto,
  type UpdateEmailSettingsRequest,
} from '@cellhive/contracts';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../../lib/api/client';
import { keys } from '../../../lib/query/keys';

const path = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/email-settings`;

/**
 * Email settings of an organization (CONTRACTS §23.2, T513/T531): instance
 * SMTP status (read only), limits, automation email settings; the
 * connection test. Organization owners/admins only.
 */
export const emailSettingsApi = {
  get: (orgId: string, signal?: AbortSignal) =>
    apiRequest(path(orgId), emailSettingsSchema, { signal }),
  update: (orgId: string, body: UpdateEmailSettingsRequest) =>
    apiRequest(path(orgId), emailSettingsSchema, { method: 'PATCH', body }),
  test: (orgId: string) =>
    apiRequest(`${path(orgId)}/test`, emailTestResultSchema, { method: 'POST' }),
};

export function emailSettingsQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.orgEmailSettings(orgId),
    queryFn: ({ signal }) => emailSettingsApi.get(orgId, signal),
    // The hourly usage and the automations using the system sender move on their own.
    staleTime: 0,
  });
}

/** `PATCH …/email-settings`: the answer is the whole settings document. */
export function useUpdateEmailSettings(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateEmailSettingsRequest) => emailSettingsApi.update(orgId, body),
    onSuccess: (settings: EmailSettingsDto) => {
      queryClient.setQueryData(keys.orgEmailSettings(orgId), settings);
    },
  });
}

/** `POST …/email-settings/test`: a classified SMTP failure is a result, not an error. */
export function useTestConnection(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => emailSettingsApi.test(orgId),
    // A test is not counted in the hourly usage, but the SMTP status may have changed.
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.orgEmailSettings(orgId) }),
  });
}
