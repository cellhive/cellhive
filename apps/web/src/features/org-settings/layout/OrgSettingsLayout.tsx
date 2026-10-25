import { cn } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { AtSign, Bell, Bot, History, KeyRound, Mail, Plug, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useParams } from 'react-router';

import { meQuery } from '../../../lib/session/session';

interface NavItem {
  readonly path: string;
  readonly key: string;
  readonly icon: LucideIcon;
  readonly testId: string;
}

/**
 * The pages of "Organization settings" that exist (board "S5 · Admin email
 * settings": the left nav; "back to the organization" stays in each page
 * heading). The board's other entries (general, members, roles)
 * come with their pages; Telegram bots (secrets) are T516.
 */
const GROUPS: readonly { readonly key: string; readonly items: readonly NavItem[] }[] = [
  {
    key: 'email',
    items: [
      { path: 'settings/email', key: 'emailSettings', icon: Mail, testId: 'nav-email' },
      {
        path: 'settings/email/identities',
        key: 'emailIdentities',
        icon: AtSign,
        testId: 'nav-email-identities',
      },
    ],
  },
  {
    key: 'automation',
    items: [
      { path: 'settings/telegram', key: 'telegramBots', icon: Bot, testId: 'nav-telegram' },
      // T613: HTTP allowlist and secrets.
      {
        path: 'settings/integrations',
        key: 'integrations',
        icon: Plug,
        testId: 'nav-integrations',
      },
    ],
  },
  {
    key: 'organization',
    // T716: the audit log of the organization (CONTRACTS §11.4).
    items: [{ path: 'settings/audit', key: 'audit', icon: History, testId: 'nav-audit' }],
  },
  {
    key: 'personal',
    items: [
      {
        path: 'settings/notifications',
        key: 'notifications',
        icon: Bell,
        testId: 'nav-notifications',
      },
      // T714: every member's own API tokens (outside this layout, like notifications).
      { path: 'settings/api-tokens', key: 'apiTokens', icon: KeyRound, testId: 'nav-api-tokens' },
    ],
  },
];

const linkClasses = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex min-h-control shrink-0 items-center gap-2 rounded-md px-2.5 text-body whitespace-nowrap text-fg hover:bg-surface-sunken lg:min-h-8',
    isActive && 'bg-accent-soft font-medium',
  );

/**
 * Layout of the organization settings pages for owners/admins (T526,
 * FRONTEND §15): a nav "Organization settings" beside the page — a column
 * from 1024 px, a row that scrolls on its own below (the page itself never
 * scrolls sideways). The layout route is guarded (`orgSettings`), so other
 * members never see the nav (they get the 404 screen).
 */
export function OrgSettingsLayout() {
  const { t } = useTranslation('org');
  const { orgSlug = '' } = useParams();
  const me = useQuery(meQuery());
  const org = me.data?.orgs.find((item) => item.slug === orgSlug);
  const root = `/o/${encodeURIComponent(orgSlug)}`;
  return (
    <div className="flex min-h-full flex-col bg-canvas lg:flex-row">
      <nav
        aria-label={t('settingsNav.label')}
        data-testid="org-settings-nav"
        className="flex min-w-0 flex-col gap-2 border-b border-line bg-surface px-4 py-3 lg:sticky lg:top-0 lg:max-h-dvh lg:w-60 lg:shrink-0 lg:self-start lg:gap-4 lg:border-r lg:border-b-0 lg:px-3 lg:py-6"
      >
        <span className="flex min-w-0 flex-col lg:px-2.5">
          <span className="text-label font-semibold text-fg-muted">{t('settingsNav.title')}</span>
          {org === undefined ? null : (
            <span className="truncate text-body font-medium text-fg">{org.name}</span>
          )}
        </span>
        {/* `relative`: the group labels (`sr-only`, absolutely positioned below 1024 px) stay
            inside this scroller instead of widening the page. */}
        <div className="relative -mx-4 flex gap-4 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
          {GROUPS.map((group) => (
            <div key={group.key} className="flex shrink-0 flex-col gap-1">
              <p
                id={`org-settings-${group.key}`}
                className="px-2.5 text-label font-normal text-fg-muted max-lg:sr-only"
              >
                {t(`settingsNav.groups.${group.key}`)}
              </p>
              <ul aria-labelledby={`org-settings-${group.key}`} className="flex gap-1 lg:flex-col">
                {group.items.map((item) => (
                  <li key={item.path}>
                    <NavLink
                      to={`${root}/${item.path}`}
                      end
                      className={linkClasses}
                      data-testid={item.testId}
                    >
                      <item.icon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                      {t(`settingsNav.items.${item.key}`)}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

export default OrgSettingsLayout;
