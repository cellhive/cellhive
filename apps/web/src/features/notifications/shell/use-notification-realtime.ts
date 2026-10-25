import { userChannel, type Id } from '@cellhive/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { keys } from '../../../lib/query/keys';
import { useRealtimeChannel } from '../../../lib/realtime/channels';

import { listenToReads } from './unread';

/**
 * (T524, FRONTEND §14) Keeps the notifications of the signed-in user fresh
 * without polling: `notification.created` on `user:<id>` (CONTRACTS §7)
 * marks that organization's notification queries stale (the bell's count
 * and an open panel refetch at once); reads made in another tab of this
 * browser do the same; a reconnect refetches (messages missed meanwhile).
 * `automation.disabled` of the organization on screen also raises a toast
 * ("«X» turned itself off" + "View", board "S5 · Notification center") —
 * except on that base's automation list, which raises its own (F§13.1).
 * Mounted once by the app shell.
 */
export function useNotificationRealtime(userId: string | null, orgId: string | null): void {
  const { i18n } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useRealtimeChannel(userId === null ? null : userChannel(userId as Id<'usr'>), {
    onMessage: (message) => {
      if (message.type !== 'notification.created') return;
      void queryClient.invalidateQueries({
        queryKey: keys.notifications(message.organization_id),
      });
      if (
        message.notification_type !== 'automation.disabled' ||
        message.organization_id !== orgId ||
        (message.base_id !== null &&
          pathname === `/b/${encodeURIComponent(message.base_id)}/automations`)
      ) {
        return;
      }
      void import('./disabled-toast').then(({ showDisabledToast }) =>
        showDisabledToast({
          orgId: message.organization_id,
          notificationId: message.notification_id,
          i18n,
          open: (to) => {
            void navigate(to);
          },
        }),
      );
    },
    onReconnect: () => {
      if (orgId !== null)
        void queryClient.invalidateQueries({ queryKey: keys.notifications(orgId) });
    },
  });
  useEffect(
    () =>
      listenToReads((readOrgId) => {
        void queryClient.invalidateQueries({ queryKey: keys.notifications(readOrgId) });
      }),
    [queryClient],
  );
}
