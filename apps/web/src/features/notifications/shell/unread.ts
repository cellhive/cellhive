import {
  notificationUnreadCountSchema,
  type NotificationUnreadCountDto,
} from '@cellhive/contracts';
import { queryOptions } from '@tanstack/react-query';

import { apiRequest, UNCHECKED_SCHEMA } from '../../../lib/api/client';
import { keys } from '../../../lib/query/keys';

/**
 * The part of the notification center the app shell loads up front (T524,
 * BACKLOG: the shell grows by at most 2 KB gzip): the unread count of the
 * current organization (CONTRACTS §22.3). Responses are only checked in
 * development (`UNCHECKED_SCHEMA`, FRONTEND §11.1), so the production shell
 * carries no zod schema for it.
 */
export function unreadCountQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.notificationUnreadCount(orgId),
    queryFn: ({ signal }): Promise<NotificationUnreadCountDto> =>
      apiRequest(
        `/orgs/${encodeURIComponent(orgId)}/me/notifications/unread-count`,
        import.meta.env.DEV ? notificationUnreadCountSchema : UNCHECKED_SCHEMA,
        { signal },
      ),
    // Kept fresh by realtime (`notification.created`) and by reads, never polled.
    staleTime: 5 * 60_000,
  });
}

/** The badge text: `999+` once the server stops counting (CONTRACTS §22.3: at most 1 000). */
export function badgeText(count: number, format: (value: number) => string): string {
  return count >= 1000 ? `${format(999)}+` : format(count);
}

/**
 * Tabs of the same browser hear about reads made in another tab (BACKLOG
 * T524: "marking read syncs between tabs"): the server sends no realtime
 * message for reads (CONTRACTS §7 has only `notification.created`), so the
 * tab that marked posts the organization id on a `BroadcastChannel` and the
 * others refetch. Other devices catch up when the window gets the focus
 * again (TanStack Query refetch on focus).
 */
const SYNC_CHANNEL = 'cellhive.notifications';

export function announceRead(orgId: string): void {
  if (typeof BroadcastChannel !== 'function') return;
  const channel = new BroadcastChannel(SYNC_CHANNEL);
  channel.postMessage({ orgId });
  channel.close();
}

/** Calls `onRead(orgId)` for reads announced by other tabs; returns the unsubscribe. */
export function listenToReads(onRead: (orgId: string) => void): () => void {
  if (typeof BroadcastChannel !== 'function') return () => undefined;
  const channel = new BroadcastChannel(SYNC_CHANNEL);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data === 'object' && data !== null && 'orgId' in data) {
      const { orgId } = data;
      if (typeof orgId === 'string') onRead(orgId);
    }
  };
  return () => {
    channel.close();
  };
}
