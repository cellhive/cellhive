import { cn } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import {
  AtSign,
  Bot,
  History,
  Link2,
  Mail,
  Plug,
  Settings,
  Sparkles,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useParams } from 'react-router';

import { meQuery } from '../../../lib/session/session';

interface NavItem {
  /** Under `/o/:orgSlug/settings`; `''` is the index ("General"). */
  readonly path: string;
  readonly key: string;
  readonly icon: LucideIcon;
  readonly testId: string;
}

/**
 * The pages of "Organization settings" (T830, grouped like the base settings
 * nav): General and AI, then people, email, automation and data. The personal
 * pages (notification settings, API tokens) are for every member and live
 * outside this layout, reached from the account menu.
 */
const GROUPS: readonly { readonly key: string | null; readonly items: readonly NavItem[] }[] = [
  {
    key: null,
    items: [
      { path: '', key: 'general', icon: Settings, testId: 'nav-general' },
      // T912: the AI provider, quota and usage (research §5.1: Sparkles + "AI").
      { path: 'ai', key: 'ai', icon: Sparkles, testId: 'nav-ai' },
    ],
  },
  {
    key: 'people',
    items: [
      { path: 'members', key: 'members', icon: Users, testId: 'nav-members' },
      { path: 'groups', key: 'groups', icon: UsersRound, testId: 'nav-groups' },
    ],
  },
  {
    key: 'email',
    items: [
      { path: 'email', key: 'emailSettings', icon: Mail, testId: 'nav-email' },
      {
        path: 'email/identities',
        key: 'emailIdentities',
        icon: AtSign,
        testId: 'nav-email-identities',
      },
    ],
  },
  {
    key: 'automation',
    items: [
      { path: 'telegram', key: 'telegramBots', icon: Bot, testId: 'nav-telegram' },
      // T613: HTTP allowlist and secrets.
      { path: 'integrations', key: 'integrations', icon: Plug, testId: 'nav-integrations' },
    ],
  },
  {
    key: 'data',
    items: [
      // T316: the public sharing policy and every share link of the organization.
      { path: 'share-links', key: 'shareLinks', icon: Link2, testId: 'nav-share-links' },
      // T716: the audit log of the organization (CONTRACTS §11.4).
      { path: 'audit', key: 'audit', icon: History, testId: 'nav-audit' },
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
 * from 1024 px as tall as the page (its links stay in view while the page
 * scrolls), a row that scrolls on its own below (the page itself never
 * scrolls sideways). The layout route is guarded (`orgSettings`), so other
 * members never see the nav (they get the 404 screen).
 */
export function OrgSettingsLayout() {
  const { t } = useTranslation('org');
  const { orgSlug = '' } = useParams();
  const me = useQuery(meQuery());
  const org = me.data?.orgs.find((item) => item.slug === orgSlug);
  const root = `/o/${encodeURIComponent(orgSlug)}/settings`;
  return (
    <div className="flex min-h-full flex-col bg-canvas lg:flex-row">
      <nav
        aria-label={t('settingsNav.label')}
        data-testid="org-settings-nav"
        className="flex min-w-0 flex-col border-b border-line bg-surface lg:w-60 lg:shrink-0 lg:border-r lg:border-b-0"
      >
        <div className="flex min-w-0 flex-col gap-2 px-4 py-3 lg:sticky lg:top-0 lg:max-h-dvh lg:gap-4 lg:overflow-y-auto lg:px-3 lg:py-6">
          <span className="flex min-w-0 flex-col lg:px-2.5">
            <span className="text-label font-semibold text-fg-muted">{t('settingsNav.title')}</span>
            {org === undefined ? null : (
              <span className="truncate text-body font-medium text-fg">{org.name}</span>
            )}
          </span>
          {/* `relative`: the group labels (`sr-only`, absolutely positioned below 1024 px) stay
              inside this scroller instead of widening the page. */}
          <div className="relative -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:gap-4 lg:overflow-visible lg:px-0">
            {GROUPS.map((group) => (
              <div key={group.key ?? 'org'} className="flex shrink-0 flex-col gap-1">
                {group.key === null ? null : (
                  <p
                    id={`org-settings-${group.key}`}
                    className="px-2.5 text-label font-normal text-fg-muted max-lg:sr-only"
                  >
                    {t(`settingsNav.groups.${group.key}`)}
                  </p>
                )}
                <ul
                  aria-labelledby={group.key === null ? undefined : `org-settings-${group.key}`}
                  className="flex gap-1 lg:flex-col"
                >
                  {group.items.map((item) => (
                    <li key={item.key}>
                      <NavLink
                        to={item.path === '' ? root : `${root}/${item.path}`}
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
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

export default OrgSettingsLayout;
