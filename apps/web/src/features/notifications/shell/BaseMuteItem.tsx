import { DropdownMenuItem } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { keys } from '../../../lib/query/keys';
import { showErrorToast, showToast } from '../../../lib/toast/toast';
import { notificationSettingsQuery, notificationsApi } from '../api';

import type { NotificationSettingsDto } from '@cellhive/contracts';

/**
 * "Mute notifications" / "Unmute notifications" of a base (CONTRACTS §22.3
 * `PUT|DELETE …/notification-mutes/bases/:baseId`): a muted base sends no
 * email; in-app notifications still show, and mandatory types ignore the
 * mute (ADR-32 §1). The toast says so.
 */
export function BaseMuteItem({
  orgId,
  base,
}: {
  readonly orgId: string;
  readonly base: { readonly id: string; readonly name: string };
}) {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();
  const settings = useQuery(notificationSettingsQuery(orgId));
  const muted = settings.data?.muted_bases.some((item) => item.id === base.id) ?? false;
  const toggle = useMutation({
    mutationFn: (mute: boolean) =>
      mute ? notificationsApi.mute(orgId, base.id) : notificationsApi.unmute(orgId, base.id),
    onSuccess: (_result, mute) => {
      // Unmuting drops it at once; a mute shows with the settings fetched again (onSettled).
      if (!mute) {
        queryClient.setQueryData<NotificationSettingsDto>(
          keys.notificationSettings(orgId),
          (data) =>
            data === undefined
              ? data
              : { ...data, muted_bases: data.muted_bases.filter((item) => item.id !== base.id) },
        );
      }
      showToast({
        variant: 'success',
        message: mute
          ? t('shell.mutedToast', { name: base.name })
          : t('shell.unmutedToast', { name: base.name }),
      });
    },
    onError: (error) => {
      showErrorToast(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.notificationSettings(orgId) }),
  });
  return (
    <DropdownMenuItem
      data-testid={`base-mute-${base.id}`}
      disabled={settings.data === undefined}
      onSelect={() => {
        toggle.mutate(!muted);
      }}
    >
      {muted ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />}
      {settings.data === undefined
        ? t('common:loading')
        : muted
          ? t('shell.unmuteBase')
          : t('shell.muteBase')}
    </DropdownMenuItem>
  );
}

export default BaseMuteItem;
