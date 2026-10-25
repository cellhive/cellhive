import { Skeleton, Spinner } from '@cellhive/ui';
import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useNavigation } from 'react-router';

import { ConnectionBanner } from '../../lib/realtime/ConnectionBanner';
import { Toaster } from '../../lib/toast/Toaster';

/** Full-page placeholder while the first route or a translation loads. */
export function PageLoading() {
  const { t } = useTranslation('common');
  return (
    <div role="status" className="flex min-h-dvh items-center justify-center gap-2 text-fg-muted">
      <Spinner />
      <span>{t('loading')}</span>
    </div>
  );
}

/** Rows of the grid skeleton: widths of the cells of each column, in rem (decorative). */
const SKELETON_COLUMNS = ['w-40', 'w-20', 'w-16', 'w-24', 'w-20'] as const;
const SKELETON_ROWS = 12;

/**
 * The first load of an app page (T322a): the app shell's frame — sidebar,
 * top bar, view bar, toolbar and a grid of placeholder rows — in place of a
 * full-page spinner while the session, the metadata and the code arrive;
 * a table URL (`/b/…/t/…`, a `?record=` link included) shows the grid.
 * Static and tiny: it is part of the entry chunk.
 */
export function AppShellSkeleton({ grid }: { readonly grid: boolean }) {
  const { t } = useTranslation('common');
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="app-shell-skeleton"
      className="flex min-h-dvh bg-canvas"
    >
      <span className="sr-only">{t('loading')}</span>
      <div
        aria-hidden="true"
        className="hidden w-64 shrink-0 flex-col gap-4 border-r border-line bg-surface p-5 lg:flex"
      >
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-5 w-40" />
        <div className="flex flex-col gap-3 pt-4">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </div>
      </div>
      <div aria-hidden="true" className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-13 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="ml-auto h-5 w-24" />
        </div>
        {grid ? (
          <>
            <div className="flex min-h-10 shrink-0 items-center gap-4 border-b border-line bg-surface px-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-24" />
            </div>
            <div className="flex min-h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="ml-auto h-7 w-56 max-md:w-24" />
              <Skeleton className="h-7 w-24" />
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface">
              <div className="flex h-9 shrink-0 items-center gap-6 border-b border-line bg-surface-sunken px-12">
                {SKELETON_COLUMNS.map((width, index) => (
                  <Skeleton key={index} className={`h-3 ${width}`} />
                ))}
              </div>
              {Array.from({ length: SKELETON_ROWS }, (_, row) => (
                <div
                  key={row}
                  className="flex h-[34px] shrink-0 items-center gap-6 border-b border-line px-12"
                >
                  {SKELETON_COLUMNS.map((width, index) => (
                    <Skeleton key={index} className={`h-3 ${width}`} />
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-4 p-8">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-24" />
          </div>
        )}
      </div>
    </div>
  );
}

/** App pages (signed-in shell) by path: `/o/…` and `/b/…`. */
const APP_PATH = /^\/(?:o|b)\//u;
/** A table page (the grid, or a record of it through `?record=`). */
const TABLE_PATH = /^\/b\/[^/]+\/t\//u;

/**
 * First paint while the router loads the matched routes (their loaders and
 * lazy code): the app shell's skeleton for app pages, else a spinner.
 */
export function HydrateFallback() {
  const path = typeof window === 'undefined' ? '/' : window.location.pathname;
  if (APP_PATH.test(path)) return <AppShellSkeleton grid={TABLE_PATH.test(path)} />;
  return <PageLoading />;
}

/** Thin bar at the top while a navigation loads its data or code. */
function NavigationProgress() {
  const navigation = useNavigation();
  if (navigation.state === 'idle') return null;
  return (
    <div
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-50 h-0.5 animate-pulse bg-accent motion-reduce:animate-none"
    />
  );
}

/**
 * Everything around the routes: navigation progress, the offline /
 * reconnecting banner (FRONTEND §8.3) and the toasts (FRONTEND §8.1).
 */
export function RootLayout() {
  return (
    <>
      <NavigationProgress />
      <ConnectionBanner />
      <Suspense fallback={<PageLoading />}>
        <Outlet />
      </Suspense>
      <Toaster />
    </>
  );
}
