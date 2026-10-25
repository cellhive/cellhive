import {
  markNotificationsReadResultSchema,
  notificationListSchema,
  notificationPreferencesSchema,
  notificationSettingsSchema,
  type MarkNotificationsReadInput,
  type UpdateNotificationPreferencesInput,
  type UpdateNotificationSettingsInput,
} from '@cellhive/contracts';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { apiRequest, apiRequestVoid, UNCHECKED_SCHEMA } from '../../lib/api/client';
import { keys } from '../../lib/query/keys';

const id = encodeURIComponent;

/**
 * Responses are checked against their schema in development only (FRONTEND
 * §3.1). Production builds drop the schemas (`DEV ? schema : UNCHECKED_SCHEMA`, T422): the
 * app shell already loads this contract module (`notification.created` of
 * the realtime schema), and every schema used here would otherwise land in
 * the chunk the shell shares with these lazy screens (T524: the shell grows
 * by at most 2 KB gzip).
 */
const DEV = import.meta.env.DEV;
const me = (orgId: string) => `/orgs/${id(orgId)}/me`;

/** One page of the panel (CONTRACTS §22.3: default 50, at most 200). */
export const NOTIFICATION_PAGE_SIZE = 30;

/**
 * The caller's notifications in one organization (CONTRACTS §22.3, T511):
 * list (cursor), mark read, preferences (type × channel), email settings,
 * base mutes. Everything is the caller's own; another organization is 404.
 */
export const notificationsApi = {
  list: (
    orgId: string,
    query: { cursor?: string | undefined; unread: boolean; baseId: string | null },
    signal?: AbortSignal,
  ) =>
    apiRequest(`${me(orgId)}/notifications`, DEV ? notificationListSchema : UNCHECKED_SCHEMA, {
      query: {
        limit: NOTIFICATION_PAGE_SIZE,
        cursor: query.cursor,
        unread: query.unread ? true : undefined,
        base_id: query.baseId ?? undefined,
      },
      signal,
    }),
  markRead: (orgId: string, body: MarkNotificationsReadInput) =>
    apiRequest(
      `${me(orgId)}/notifications/read`,
      DEV ? markNotificationsReadResultSchema : UNCHECKED_SCHEMA,
      {
        method: 'POST',
        body,
      },
    ),
  preferences: (orgId: string, signal?: AbortSignal) =>
    apiRequest(
      `${me(orgId)}/notification-preferences`,
      DEV ? notificationPreferencesSchema : UNCHECKED_SCHEMA,
      { signal },
    ),
  updatePreferences: (orgId: string, body: UpdateNotificationPreferencesInput) =>
    apiRequest(
      `${me(orgId)}/notification-preferences`,
      DEV ? notificationPreferencesSchema : UNCHECKED_SCHEMA,
      {
        method: 'PUT',
        body,
      },
    ),
  settings: (orgId: string, signal?: AbortSignal) =>
    apiRequest(
      `${me(orgId)}/notification-settings`,
      DEV ? notificationSettingsSchema : UNCHECKED_SCHEMA,
      { signal },
    ),
  updateSettings: (orgId: string, body: UpdateNotificationSettingsInput) =>
    apiRequest(
      `${me(orgId)}/notification-settings`,
      DEV ? notificationSettingsSchema : UNCHECKED_SCHEMA,
      {
        method: 'PUT',
        body,
      },
    ),
  mute: (orgId: string, baseId: string) =>
    apiRequestVoid(`${me(orgId)}/notification-mutes/bases/${id(baseId)}`, { method: 'PUT' }),
  unmute: (orgId: string, baseId: string) =>
    apiRequestVoid(`${me(orgId)}/notification-mutes/bases/${id(baseId)}`, { method: 'DELETE' }),
};

export interface ListFilter {
  readonly unread: boolean;
  readonly baseId: string | null;
}

export const notificationListQuery = (orgId: string, filter: ListFilter) =>
  infiniteQueryOptions({
    queryKey: keys.notificationList(orgId, { unread: filter.unread, baseId: filter.baseId }),
    queryFn: ({ pageParam, signal }) =>
      notificationsApi.list(orgId, { ...filter, cursor: pageParam ?? undefined }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  });

export const notificationPreferencesQuery = (orgId: string) =>
  queryOptions({
    queryKey: keys.notificationPreferences(orgId),
    queryFn: ({ signal }) => notificationsApi.preferences(orgId, signal),
  });

export const notificationSettingsQuery = (orgId: string) =>
  queryOptions({
    queryKey: keys.notificationSettings(orgId),
    queryFn: ({ signal }) => notificationsApi.settings(orgId, signal),
  });
