import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useMemo } from 'react';

import { keys } from '../../../../lib/query/keys';
import { ShareLoading } from '../components/ShareScreens';

import type { SharedDashboardSource, SharePageParts } from '../../../../lib/share/public-page';
import type { ShareApi } from '../api';

export interface SharedDashboardPageProps {
  readonly api: ShareApi;
  readonly Dashboard: SharePageParts['Dashboard'];
  /** `?embed=1`: framed by another site. */
  readonly embed: boolean;
  /** `GET …/dashboard` failed: the page shows what that means (as for `meta`). */
  readonly onLoadError: (error: unknown) => void;
  /** A later request ended the page (link revoked or turned off, unlock expired…). */
  readonly onFatal: (error: unknown) => void;
}

/**
 * (T814) A dashboard link (`/s/:token`, its `meta` answers `404
 * DASHBOARD_LINK`): reads `GET /shares/:token/dashboard` once — the widgets,
 * their layout and the fields they name, filtered to what the link may show
 * — and draws it with the dashboard renderer of `features/dashboard`
 * (given by the route, a chunk of its own with ECharts). Widget numbers are
 * read and polled by that renderer through the link (`widgets/:id/data`).
 */
export function SharedDashboardPage({
  api,
  Dashboard,
  embed,
  onLoadError,
  onFatal,
}: SharedDashboardPageProps) {
  const dashboard = useQuery({
    queryKey: keys.shareDashboard(api.token),
    queryFn: ({ signal }) => api.dashboard(signal),
    retry: false,
    // Each read counts as an opening of the link (CONTRACTS §16A): read once, then poll widgets.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const { isError, error } = dashboard;
  useEffect(() => {
    if (isError) onLoadError(error);
  }, [isError, error, onLoadError]);
  const source = useMemo<SharedDashboardSource>(
    () => ({
      widgetsKey: keys.shareWidgets(api.token),
      dashboardKey: keys.shareDashboard(api.token),
      widgetData: (widgetId, body, signal) => api.widgetData(widgetId, body, signal),
      widgetOptions: (widgetId, body, signal) => api.widgetOptions(widgetId, body, signal),
      widgetCsvUrl: (widgetId, filters, timezone) => api.widgetCsvUrl(widgetId, filters, timezone),
    }),
    [api],
  );
  if (dashboard.data === undefined) return <ShareLoading />;
  return (
    <Suspense fallback={<ShareLoading />}>
      <Dashboard dashboard={dashboard.data} source={source} embed={embed} onFatal={onFatal} />
    </Suspense>
  );
}

export default SharedDashboardPage;
