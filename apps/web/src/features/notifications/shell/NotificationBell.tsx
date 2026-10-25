import { cn } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { lazy, Suspense, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { badgeText, unreadCountQuery } from './unread';

const loadPanel = () => import('../panel/NotificationPanel');
const NotificationPanel = lazy(loadPanel);

export interface NotificationBellProps {
  readonly org: { readonly id: string; readonly slug: string };
  readonly className?: string;
}

/**
 * The bell of the app shell (T524, BACKLOG S5 design decision #5: at the
 * top of the sidebar; in the top bar while the sidebar is a drawer) with
 * the unread count of the current organization, kept fresh by realtime
 * (`useNotificationRealtime`), never polled. The panel is a lazy chunk:
 * a popover from 768 px, the whole screen below (board "… - 375 px").
 */
export function NotificationBell({ org, className }: NotificationBellProps) {
  const { t, i18n } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { data } = useQuery(unreadCountQuery(org.id));
  const count = data?.count ?? 0;
  const text = badgeText(count, (value) => new Intl.NumberFormat(i18n.language).format(value));
  return (
    <>
      <button
        ref={button}
        type="button"
        data-testid="notification-bell"
        aria-label={
          count === 0
            ? t('notifications.bell')
            : t('notifications.bellUnread', { count, formatted: text })
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'relative inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg max-lg:size-control',
          open && 'bg-accent-soft text-accent',
          className,
        )}
        onPointerEnter={() => {
          void loadPanel();
        }}
        onFocus={() => {
          void loadPanel();
        }}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <Bell aria-hidden="true" className="size-4" />
        {count === 0 ? null : (
          <span
            aria-hidden="true"
            data-testid="notification-badge"
            className="absolute -top-1 -right-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-label leading-none font-semibold text-on-danger tabular-nums max-lg:top-0.5 max-lg:right-0.5"
          >
            {text}
          </span>
        )}
      </button>
      {open ? (
        <Suspense fallback={null}>
          <NotificationPanel
            org={org}
            anchor={button}
            onClose={(restoreFocus) => {
              setOpen(false);
              if (restoreFocus) button.current?.focus();
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
