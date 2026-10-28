import { Button, cn, Skeleton, TooltipProvider } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Menu, Settings, X } from 'lucide-react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, Outlet, useLocation, useParams } from 'react-router';

import { AutomationNavLink } from '../../features/automation/nav/AutomationNavLink';
import { baseQuery } from '../../features/base/api';
import { BaseTablesNav } from '../../features/base/components/BaseTablesNav';
import { BaseNotificationMenu } from '../../features/notifications/shell/BaseNotificationMenu';
import { NotificationBell } from '../../features/notifications/shell/NotificationBell';
import { useNotificationRealtime } from '../../features/notifications/shell/use-notification-realtime';
import { OrgSwitcher } from '../../features/org/components/OrgSwitcher';
import { WorkspaceNav } from '../../features/org/components/WorkspaceNav';
import { orgPath } from '../../features/org/hooks';
import { Logo } from '../../lib/brand/Logo';
import { PageHeaderSlotProvider } from '../../lib/layout/page-header';
import { loginPathFor } from '../../lib/navigation/safe-next';
import { canManageAutomations } from '../../lib/permissions/access';
import { isOrgAdmin } from '../../lib/permissions/org';
import { PREFERENCE_KEYS, readPreference } from '../../lib/preferences';
import { useBaseChannel, useUserChannel } from '../../lib/realtime/channels';
import { meQuery } from '../../lib/session/session';
import { useProfileLanguage } from '../../lib/session/use-profile-language';
import { UserMenu } from '../UserMenu';

import type { MeOrganization } from '@cellhive/contracts';

/**
 * The organization the sidebar shows: the one in the URL, the one owning the
 * base being viewed, else the last used one.
 */
function useCurrentOrg(orgs: readonly MeOrganization[] | undefined): MeOrganization | undefined {
  const { orgSlug, baseId } = useParams();
  const base = useQuery({ ...baseQuery(baseId ?? ''), enabled: baseId !== undefined });
  if (orgs === undefined) return undefined;
  if (orgSlug !== undefined) return orgs.find((org) => org.slug === orgSlug);
  if (baseId !== undefined) {
    return base.data === undefined
      ? undefined
      : orgs.find((org) => org.id === base.data.organization_id);
  }
  const last = readPreference(PREFERENCE_KEYS.lastOrg);
  return orgs.find((org) => org.slug === last) ?? orgs[0];
}

function MainFallback() {
  return (
    <div className="flex flex-col gap-4 p-8" aria-hidden="true">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-24" />
    </div>
  );
}

/** Where the navigation drawer was opened. */
interface NavOpenAt {
  /** Path of the page on screen (`useLocation`). */
  readonly shown: string;
  /** Path in the address bar: the page being loaded, if any. */
  readonly page: string;
}

/** Signed-in layout: sidebar (organization → workspaces → bases), top bar, page. */
export function AppShell() {
  const { t } = useTranslation('common');
  const location = useLocation();
  const me = useQuery(meQuery());
  const { baseId } = useParams();
  // Realtime (FRONTEND §5): the user's own channel always, the base's inside a base.
  useUserChannel(me.data?.user.id ?? null);
  useBaseChannel(baseId ?? null);
  const orgs = me.data?.orgs;
  const current = useCurrentOrg(orgs);
  // (T524) Notifications of the organization on screen: count, toast, cross-tab reads.
  useNotificationRealtime(me.data?.user.id ?? null, current?.id ?? null);
  // (T520) The automation list is for people who manage automations of the base.
  const base = useQuery({ ...baseQuery(baseId ?? ''), enabled: baseId !== undefined });
  // The drawer (narrow screens) is open for one page: navigating closes it.
  // That page is the address bar's when the menu was tapped. The router
  // renders a navigation inside a transition: while the next page loads, the
  // URL is already its own and `useLocation` still the previous page's. A tap
  // then opened the drawer for the previous page, and it closed by itself as
  // soon as the next page showed (CI t290).
  const [navOpenAt, setNavOpenAt] = useState<NavOpenAt | null>(null);
  const navOpen =
    navOpenAt !== null &&
    (location.pathname === navOpenAt.page ||
      // Still on screen while the page it was opened for loads.
      (location.pathname === navOpenAt.shown && window.location.pathname === navOpenAt.page));
  const setNavOpen = (open: boolean) => {
    setNavOpenAt(open ? { shown: location.pathname, page: window.location.pathname } : null);
  };
  const menuButton = useRef<HTMLButtonElement>(null);
  // The top bar's slot for the page's own header (table name and actions, T320b).
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  // Escape closes the open drawer and gives the focus back to its button (S2 QA).
  useEffect(() => {
    if (!navOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setNavOpenAt(null);
      menuButton.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [navOpen]);

  // The profile locale applies until the user picks a language on this device.
  useProfileLanguage(me.data?.locale);

  if (me.data === null) return <Navigate to={loginPathFor(location)} replace />;

  return (
    <div className="flex min-h-dvh bg-canvas">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('nav.skipToContent')}
      </a>
      {navOpen ? (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-30 animate-fade-in bg-overlay lg:hidden"
          onClick={() => {
            setNavOpen(false);
          }}
        />
      ) : null}
      <aside
        id="app-sidebar"
        aria-label={t('nav.sidebar')}
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col gap-4 border-r border-line bg-surface p-3',
          // Slides on the sheet timing; `visibility` waits for the slide out to end.
          'transition-[transform,visibility] duration-(--motion-sheet) ease-(--ease-enter) motion-reduce:transition-none lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0',
          // Closed drawer: off screen and out of the tab order (visible again from lg).
          navOpen ? 'visible translate-x-0' : 'invisible -translate-x-full lg:visible',
        )}
      >
        <div className="flex items-center justify-between gap-2 px-2 pt-1">
          <Link to={current === undefined ? '/' : orgPath(current)} className="mr-auto">
            <Logo />
          </Link>
          {/* The bell at the top of the sidebar (S5 design decision #5); the top bar's below lg. */}
          {current === undefined ? null : (
            <NotificationBell org={current} className="max-lg:hidden" />
          )}
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label={t('nav.close')}
            onClick={() => {
              setNavOpen(false);
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        {orgs === undefined || current === undefined ? (
          <div className="flex flex-col gap-2 px-2" aria-hidden="true">
            <Skeleton className="h-8" />
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-0.5">
              <OrgSwitcher orgs={orgs} current={current} />
              {/* T830: the organization's settings, for owners/admins like the route guard. */}
              {isOrgAdmin(current.role) ? (
                <OrgSettingsLink
                  to={`${orgPath(current)}/settings`}
                  pathname={location.pathname}
                  label={t('nav.orgSettings')}
                />
              ) : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
              {/* Inside a base: its tables first (design), then the workspace tree. */}
              {baseId === undefined ? null : (
                <BaseTablesNav
                  baseId={baseId}
                  extra={
                    canManageAutomations(base.data?.access) ? (
                      <AutomationNavLink baseId={baseId} />
                    ) : undefined
                  }
                />
              )}
              <WorkspaceNav
                org={current}
                baseMenu={(item) => <BaseNotificationMenu orgId={current.id} base={item} />}
              />
            </div>
          </>
        )}
        {me.data === undefined ? null : (
          <div className="-mx-3 -mb-3 border-t border-line p-2">
            <UserMenu me={me.data} orgSlug={current?.slug} />
          </div>
        )}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          52 px top bar (design): the menu button on narrow screens and the
          page's own header (`PageHeader`); hidden from lg when the page has none.
        */}
        <header className="flex h-13 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 lg:px-4 lg:has-[[data-page-header]:empty]:hidden">
          <Button
            ref={menuButton}
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label={t('nav.open')}
            aria-expanded={navOpen}
            aria-controls="app-sidebar"
            onClick={() => {
              setNavOpen(true);
            }}
          >
            <Menu aria-hidden="true" />
          </Button>
          <div
            ref={setHeaderSlot}
            data-page-header
            className="flex min-w-0 flex-1 items-center gap-3"
          />
          {current === undefined ? null : <NotificationBell org={current} className="lg:hidden" />}
        </header>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 outline-none">
          <PageHeaderSlotProvider value={headerSlot}>
            <Suspense fallback={<MainFallback />}>
              {/* One hover delay for the page's tooltips (T322b); not in the share bundle. */}
              <TooltipProvider>
                <Outlet />
              </TooltipProvider>
            </Suspense>
          </PageHeaderSlotProvider>
        </main>
      </div>
    </div>
  );
}

export default AppShell;

/**
 * The organization settings entry of the sidebar. Not a `NavLink`: the
 * notification and API token pages sit under `/settings` but are personal,
 * so they must not mark it current.
 */
function OrgSettingsLink({
  to,
  pathname,
  label,
}: {
  readonly to: string;
  readonly pathname: string;
  readonly label: string;
}) {
  const current =
    (pathname === to || pathname.startsWith(`${to}/`)) &&
    !/\/settings\/(?:notifications|api-tokens)(?:\/|$)/u.test(pathname);
  return (
    <Link
      to={to}
      data-testid="sidebar-org-settings"
      aria-current={current ? 'page' : undefined}
      className={cn(
        'flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 text-body text-fg hover:bg-surface-sunken max-lg:min-h-control',
        current && 'bg-accent-soft font-medium text-accent',
      )}
    >
      <Settings aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </Link>
  );
}
