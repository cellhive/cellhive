import { showToast } from '../../../lib/toast/toast';
import { notificationsApi } from '../api';
import { linkOf } from '../model/items';

import type { i18n as I18n } from 'i18next';

/**
 * (T524, board "S5 · Notification center": "Toast when an automation is
 * turned off (realtime, every tab)") Loaded on the first `automation.disabled`
 * message: the message carries ids only (CONTRACTS §7), so the newest unread
 * notifications are read to name the automation — with the caller's access
 * (CONTRACTS §22.3: no name when they cannot see it). "View" opens the
 * base's automation list.
 */
export async function showDisabledToast(input: {
  readonly orgId: string;
  readonly notificationId: string;
  readonly i18n: I18n;
  readonly open: (to: string) => void;
}): Promise<void> {
  await input.i18n.loadNamespaces('notifications');
  const t = input.i18n.getFixedT(null, 'notifications');
  let name: string | null = null;
  let link: string | null = null;
  try {
    const page = await notificationsApi.list(input.orgId, { unread: true, baseId: null });
    const item = page.items.find((notification) => notification.id === input.notificationId);
    if (item !== undefined) {
      name = item.entity.title;
      link = linkOf(item);
    }
  } catch {
    // The toast still says that an automation was turned off.
  }
  showToast({
    variant: 'warning',
    message: name === null ? t('shell.disabledToastUnnamed') : t('shell.disabledToast', { name }),
    actions:
      link === null
        ? []
        : [
            {
              label: t('shell.view'),
              onClick: () => {
                input.open(link);
              },
            },
          ],
  });
}
