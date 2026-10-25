import { canonicalTimeZone } from '@cellhive/contracts';
import { Button } from '@cellhive/ui';
import { useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, Monitor, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { PAGE_GUTTER, PageHeading } from '../../../lib/layout/page-heading';
import { showToast } from '../../../lib/toast/toast';
import { downloadName, downloadPng, downloadWidgetCsv } from '../export/export';
import { FilterBar } from '../filters/FilterBar';
import { DashboardFiltersContext, useDashboardFilterState } from '../filters/use-dashboard-filters';
import { densityOf, DENSITY_GAP } from '../model/theme';
import { TEST_IDS } from '../test-ids';
import { TvToolbar } from '../tv/TvToolbar';
import { useTvMode } from '../tv/use-tv-mode';
import { DashboardGrid } from '../view/DashboardGrid';
import { DashboardSurface } from '../view/DashboardSurface';
import { DashboardDataSourceContext } from '../view/data-source';
import { WidgetActionsContext, type WidgetActions } from '../view/widget-actions';
import { WidgetCard } from '../widgets/WidgetCard';
import { WidgetMessage } from '../widgets/WidgetMessage';

import { sharedDashboardDto } from './shared-model';
import { sharedDataSource } from './shared-source';

import type { SharedDashboardProps } from '../../../lib/share/public-page';
import type { WidgetDataContext } from '../api';
import type { WidgetDto } from '@cellhive/contracts';

/** The viewer's zone for date buckets (no account behind a link). */
function browserTimeZone(): string | null {
  try {
    // By IANA primary name: Chrome says `Asia/Saigon`, Postgres knows `Asia/Ho_Chi_Minh` (T819).
    return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/**
 * (T814) A dashboard opened through its share link (`/s/:token`, SPEC
 * §15A, CONTRACTS §16A): read-only — the same widget cards as members see
 * (`WidgetCard`), with numbers computed with the link creator's current
 * access. Filter controls and the filter bar work when the link allows
 * them (`allow_filter_controls`); no click-through, no editing. Numbers
 * refresh every `refresh_seconds` while the tab is visible (no WebSocket
 * for links). TV mode is offered with `tv_mode`; widget CSV and PNG
 * downloads with `allow_export` (the creator's `download` right included).
 * Embedded (`?embed=1`), the page has no share chrome around it.
 */
export function SharedDashboardView({
  dashboard: shared,
  source,
  embed,
  onFatal,
}: SharedDashboardProps) {
  const { t } = useTranslation('dashboard');
  const queryClient = useQueryClient();
  const settings = shared.settings;
  const data = useMemo(() => sharedDashboardDto(shared), [shared]);
  useDocumentTitle(data.name);
  const refreshMs = settings.refresh_seconds * 1000;
  const dataSource = useMemo(
    () => sharedDataSource(shared, source, { refreshMs, onFatal }),
    [shared, source, refreshMs, onFatal],
  );
  const filters = useDashboardFilterState(settings.allow_filter_controls ? data : undefined);
  const tv = useTvMode('', data.id, { rotation: false });
  const tvOn = settings.tv_mode && tv.on;
  const timezone = useMemo(() => browserTimeZone(), []);
  const context = useMemo<WidgetDataContext>(
    () => ({ permissionVersion: 0, timezone }),
    [timezone],
  );
  const actions = useMemo<WidgetActions | null>(
    () =>
      tvOn
        ? null
        : {
            canDownload: settings.allow_export,
            viewRecords: null,
            downloadCsv: (widget, _title, live) => {
              downloadWidgetCsv(source.widgetCsvUrl(widget.id, live, timezone), {
                frameTitle: t('widget.downloadFrame'),
                onError: (error) => {
                  if (error.status === 410) onFatal(error);
                  else showToast({ variant: 'error', error });
                },
              });
            },
            downloadPng: (title, dataUrl) => {
              downloadPng(dataUrl, downloadName(data.name, title, 'png'));
            },
          },
    [tvOn, settings.allow_export, source, timezone, t, onFatal, data.name],
  );
  const renderWidget = useCallback(
    (widget: WidgetDto) => <WidgetCard widget={widget} context={context} admin={false} />,
    [context],
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: source.widgetsKey });
  };

  return (
    <DashboardDataSourceContext.Provider value={dataSource}>
      <DashboardFiltersContext.Provider value={filters}>
        <WidgetActionsContext.Provider value={actions}>
          <DashboardSurface
            theme={data.theme}
            testId={TEST_IDS.dashboardPage}
            className={tvOn ? 'fixed inset-0 z-50 overflow-y-auto' : 'flex-1'}
            tv={tvOn}
          >
            {tvOn ? (
              <TvToolbar name={data.name} tv={tv} rotation={false} />
            ) : (
              <PageHeading
                icon={embed ? undefined : LayoutDashboard}
                className={embed ? 'pt-4 pb-4' : ''}
                title={<span data-testid="dashboard-title">{data.name}</span>}
                subtitle={
                  data.description === null || data.description === ''
                    ? undefined
                    : data.description
                }
                actions={
                  <SharedActions
                    refreshSeconds={settings.refresh_seconds}
                    onRefresh={refresh}
                    tv={settings.tv_mode ? tv.enter : null}
                  />
                }
              />
            )}
            <FilterBar baseId="" className={PAGE_GUTTER} />
            <div className={`${PAGE_GUTTER} flex-1 py-6`}>
              {data.widgets.length === 0 ? (
                <div className="mx-auto flex max-w-lg flex-col py-10" data-testid="dashboard-empty">
                  <WidgetMessage
                    kind="empty"
                    title={t('page.empty.title')}
                    testId={TEST_IDS.dashboardState}
                  />
                </div>
              ) : (
                <DashboardGrid
                  widgets={data.widgets}
                  renderWidget={renderWidget}
                  gap={DENSITY_GAP[densityOf(data.theme)]}
                />
              )}
            </div>
          </DashboardSurface>
        </WidgetActionsContext.Provider>
      </DashboardFiltersContext.Provider>
    </DashboardDataSourceContext.Provider>
  );
}

/** How often the numbers refresh, "Refresh" and (with `tv_mode`) "TV mode". */
function SharedActions({
  refreshSeconds,
  onRefresh,
  tv,
}: {
  readonly refreshSeconds: number;
  readonly onRefresh: () => void;
  readonly tv: (() => void) | null;
}): ReactNode {
  const { t } = useTranslation('dashboard');
  const every =
    refreshSeconds < 60 || refreshSeconds % 60 !== 0
      ? t('shared.everySeconds', { count: refreshSeconds })
      : t('shared.everyMinutes', { count: refreshSeconds / 60 });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-label font-normal text-fg-muted" data-testid="shared-refresh-every">
        {every}
      </span>
      <Button variant="secondary" onClick={onRefresh} data-testid="shared-dashboard-refresh">
        <RefreshCw aria-hidden="true" />
        {t('shared.refresh')}
      </Button>
      {tv === null ? null : (
        <Button variant="secondary" onClick={tv} data-testid="dashboard-tv">
          <Monitor aria-hidden="true" />
          {t('tv.open')}
        </Button>
      )}
    </div>
  );
}

export default SharedDashboardView;
