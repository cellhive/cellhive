import { Suspense, useEffect } from 'react';
import { useLocation, useSearchParams, type RouteObject } from 'react-router';

import { lazyOverlay, lazyPanel } from '../lib/lazy/chunk-error';
import { lazyRoute } from '../lib/lazy/lazy-route';

import { RouteErrorPage } from './errors';
import { ShareLayout, ShareLoading } from './layouts/ShareLayout';

import type { SharePageParts, UseWindowedRows } from '../lib/share/public-page';

/**
 * The public share page (`/s/:token`, T317) gets what it needs from other
 * features through the route (FRONTEND §1.2), each loaded only when used:
 * the form renderer of T315 (form links), the grid's windowed block loader
 * (grid links), the view toolbar of T311 (links that let viewers filter,
 * sort or search) and the read-only files of T418 (record details, T409; the viewer from
 * grid cells and cards, T419). Used by the share entry (`share-main.tsx`) and,
 * for navigations inside the app, by the app router.
 */
export async function loadShareRoute() {
  const { SharePage } = await import('../features/share/public/components/SharePage');
  let windowedRows: Promise<UseWindowedRows> | undefined;
  const parts: SharePageParts = {
    // T814: a dashboard link draws with the dashboard renderer (ECharts), a chunk of its own.
    Dashboard: lazyPanel(() => import('../features/dashboard/share/SharedDashboardView')),
    FormRenderer: lazyPanel(() => import('../features/form/renderer/FormRenderer')),
    loadWindowedRows: () =>
      (windowedRows ??= import('../features/grid/blocks/use-record-blocks').then(
        (module) => module.useWindowedRecordBlocks,
      )),
    Files: lazyPanel(() => import('../features/attachment/components/ReadOnlyFiles')),
    FileViewer: lazyOverlay(() => import('../features/attachment/components/ReadOnlyViewer')),
    Toolbar: {
      Controls: lazyOverlay(() => import('../features/view/toolbar/ViewToolbar')),
      Search: lazyOverlay(async () => ({
        default: (await import('../features/view/toolbar/ViewSearch')).ViewSearch,
      })),
      // The summary bar of a shared grid (T472), read-only: loaded when the view has summaries.
      SummaryBar: lazyOverlay(async () => ({
        default: (await import('../features/view/summary/SummaryBar')).SummaryBar,
      })),
    },
  };
  return {
    Component: function ShareRoute() {
      return <SharePage parts={parts} />;
    },
  };
}

/**
 * The public sender verification page (`/verify-sender?token=…`, T533,
 * ADR-33 §2): served by this light entry like the share pages — no app
 * shell, no session, no `Referer` carrying the token.
 */
export async function loadVerifySenderRoute() {
  const { VerifySenderPage } = await import('../routes/verify-sender/VerifySenderPage');
  return { Component: VerifySenderPage };
}

/** Any other path reached from a share page belongs to the app: a full page load. */
function LeaveShareEntry() {
  const location = useLocation();
  useEffect(() => {
    window.location.replace(`${location.pathname}${location.search}${location.hash}`);
  }, [location]);
  return <ShareLoading />;
}

/** (T814) The layout of an embedded page: a chunk of its own, only `?embed=1` loads it. */
const EmbedLayout = lazyPanel(() => import('../features/share/public/components/EmbedLayout'));

/** (T814) `?embed=1`: the page framed by another site, without the share header. */
function ShareFrame() {
  const [params] = useSearchParams();
  if (params.get('embed') !== '1') return <ShareLayout />;
  return (
    <Suspense fallback={<ShareLoading />}>
      <EmbedLayout />
    </Suspense>
  );
}

/**
 * Routes of the share entry (`share.html`, served for `/s/*` and
 * `/verify-sender`): the share page and the sender verification page, in
 * their own layout — none of the app shell, guards or screens are part of
 * this bundle (FRONTEND §11.1).
 */
export function createShareRoutes(): RouteObject[] {
  return [
    {
      element: <ShareFrame />,
      errorElement: <RouteErrorPage />,
      hydrateFallbackElement: <ShareLoading />,
      children: [
        { path: 's/:token', lazy: lazyRoute(loadShareRoute) },
        { path: 'verify-sender', lazy: lazyRoute(loadVerifySenderRoute) },
        { path: '*', element: <LeaveShareEntry /> },
      ],
    },
  ];
}
