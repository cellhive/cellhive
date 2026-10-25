import { cn } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import {
  History,
  Link2,
  Settings,
  ShieldCheck,
  Users,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useParams } from 'react-router';

import { baseQuery } from '../../../lib/query/queries';

interface NavItem {
  /** Under `/b/:baseId/settings`; `''` is the index ("General"). */
  readonly path: string;
  readonly key: string;
  readonly icon: LucideIcon;
  readonly testId: string;
}

/**
 * The pages of "Base settings" (T712, FRONTEND §17; the base settings nav of
 * the "Roles" board, laid out like `OrgSettingsLayout`), with the audit
 * log of the base (T716).
 */
const ITEMS: readonly NavItem[] = [
  { path: '', key: 'general', icon: Settings, testId: 'base-settings-nav-general' },
  { path: 'members', key: 'members', icon: Users, testId: 'base-settings-nav-members' },
  { path: 'roles', key: 'roles', icon: ShieldCheck, testId: 'base-settings-nav-roles' },
  // T316 and T611: their pages moved under this layout as they were.
  { path: 'share-links', key: 'shareLinks', icon: Link2, testId: 'base-settings-nav-share-links' },
  { path: 'webhooks', key: 'webhooks', icon: Webhook, testId: 'base-settings-nav-webhooks' },
  // T716: the audit log of the base (CONTRACTS §11.4).
  { path: 'audit', key: 'audit', icon: History, testId: 'base-settings-nav-audit' },
];

const linkClasses = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex min-h-control shrink-0 items-center gap-2 rounded-md px-2.5 text-body whitespace-nowrap text-fg hover:bg-surface-sunken lg:min-h-8',
    isActive && 'bg-accent-soft font-medium',
  );

/**
 * Layout of the base settings pages for base admins (T712, FRONTEND §17): a
 * nav "Base settings" beside the page — a column from 1024 px, a row that
 * scrolls on its own below (the page never scrolls sideways). The layout
 * route is guarded (`baseSettings`): everyone else gets the 404 screen
 * without the nav.
 */
export function BaseSettingsLayout() {
  const { t } = useTranslation('baseSettings');
  const { baseId = '' } = useParams();
  const base = useQuery(baseQuery(baseId));
  const root = `/b/${encodeURIComponent(baseId)}/settings`;
  return (
    <div className="flex min-h-full flex-col bg-canvas lg:flex-row">
      <nav
        aria-label={t('nav.label')}
        data-testid="base-settings-nav"
        className="flex min-w-0 flex-col gap-2 border-b border-line bg-surface px-4 py-3 lg:sticky lg:top-0 lg:max-h-dvh lg:w-60 lg:shrink-0 lg:self-start lg:gap-4 lg:border-r lg:border-b-0 lg:px-3 lg:py-6"
      >
        <span className="flex min-w-0 flex-col lg:px-2.5">
          <span className="text-label font-semibold text-fg-muted">{t('nav.title')}</span>
          {base.data === undefined ? null : (
            <span className="truncate text-body font-medium text-fg">{base.data.name}</span>
          )}
        </span>
        <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
          {ITEMS.map((item) => (
            <li key={item.key}>
              <NavLink
                to={item.path === '' ? root : `${root}/${item.path}`}
                // "Roles" stays current in a role's editor (T713, `roles/:roleId`).
                end={item.path === ''}
                className={linkClasses}
                data-testid={item.testId}
              >
                <item.icon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                {t(`nav.items.${item.key}`)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

export default BaseSettingsLayout;
