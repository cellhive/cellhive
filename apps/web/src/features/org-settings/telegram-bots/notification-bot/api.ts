import {
  orgNotificationChannelsSchema,
  type UpdateOrgNotificationChannelsInput,
} from '@cellhive/contracts';
import { queryOptions } from '@tanstack/react-query';

import { apiRequest } from '../../../../lib/api/client';
import { keys } from '../../../../lib/query/keys';

const id = encodeURIComponent;

/**
 * The organization's notification bot (BACKLOG T555, CONTRACTS §22.7):
 * owners/admins choose one `telegram_bot` secret of the organization that
 * members link their own Telegram chat to. Never a token or a chat id.
 */
export const notificationChannelsApi = {
  get: (orgId: string, signal?: AbortSignal) =>
    apiRequest(`/orgs/${id(orgId)}/notification-channels`, orgNotificationChannelsSchema, {
      signal,
    }),
  update: (orgId: string, body: UpdateOrgNotificationChannelsInput) =>
    apiRequest(`/orgs/${id(orgId)}/notification-channels`, orgNotificationChannelsSchema, {
      method: 'PATCH',
      body,
    }),
};

/**
 * The poller writes `status` (`webhook_conflict`, `invalid_token`) without
 * telling anyone (CONTRACTS §22.7): read it again whenever the page is shown
 * or the window gets the focus back.
 */
export const orgNotificationChannelsQuery = (orgId: string) =>
  queryOptions({
    queryKey: keys.orgNotificationChannels(orgId),
    queryFn: ({ signal }) => notificationChannelsApi.get(orgId, signal),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
