import { Button, Skeleton } from '@cellhive/ui';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { LayoutDashboard, Monitor, Pencil } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { PAGE_GUTTER, PageHeading } from '../../../lib/layout/page-heading';
import { canDownload, isBaseAdmin } from '../../../lib/permissions/access';
import { dashboardQuery } from '../../../lib/query/dashboards';
import { baseQuery } from '../../../lib/query/queries';
import { meQuery } from '../../../lib/session/session';
import { showToast } from '../../../lib/toast/toast';
import { downloadName, downloadPng, downloadWidgetCsv, widgetCsvUrl } from '../export/export';
import { FilterBar } from '../filters/FilterBar';
import { DashboardFiltersContext, useDashboardFilterState } from '../filters/use-dashboard-filters';
import { densityOf, DENSITY_GAP } from '../model/theme';
import { TEST_IDS } from '../test-ids';
import { TvToolbar } from '../tv/TvToolbar';
import { useTvMode } from '../tv/use-tv-mode';
import { WidgetCard } from '../widgets/WidgetCard';
import { WidgetMessage } from '../widgets/WidgetMessage';

import { DashboardGrid } from './DashboardGrid';
import { DashboardSurface } from './DashboardSurface';
import { useDashboardRealtime } from './use-dashboard-realtime';
import { WidgetActionsContext, type RecordsRequest, type WidgetActions } from './widget-actions';

import type { RecordDetailComponents } from '../../../lib/records/detail';
import type { RecordFilterEditorProps } from '../../../lib/schema/field-tools';
import type { DashboardShareActionProps } from '../../../lib/share/dashboard-share';
import type { WidgetDataContext } from '../api';
import type { DashboardDto, WidgetDto } from '@cellhive/contracts';

const NO_WIDGETS: readonly WidgetDto[] = [];

/** (T812) The editor is its own chunk: view mode never downloads it. */
const DashboardEditor = lazy(() => import('../edit/DashboardEditor'));
/** (T813) Click-through: its own chunk, loaded when "View records" is first used. */
const RecordsDrawer = lazy(() => import('../drill/RecordsDrawer'));

export interface DashboardPageProps {
  /**
   * (T812) The view filter builder (`features/view`, FRONTEND §1.2) for the
   * widget filter of the editor, given by the app layer; lazy.
   */
  readonly FilterEditor?: ComponentType<RecordFilterEditorProps> | undefined;
  /**
   * (T813) The record panel of the grid (`features/record`, lazy, F§1.2):
   * a record of a click-through opens in it.
   */
  readonly RecordDetail?: RecordDetailComponents | undefined;
  /**
   * (T814) "Share" of the dashboard (`features/share/manage`, lazy, F§1.2):
   * shown to people who may share; it hides itself otherwise.
   */
  readonly ShareAction?: ComponentType<DashboardShareActionProps> | undefined;
}

function PageSkeleton() {
  return (
    <div className="flex min-h-full flex-col bg-canvas" aria-busy="true">
      <div className={`${PAGE_GUTTER} flex flex-col gap-4 py-6`} aria-hidden="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}

/**
 * `/b/:baseId/d/:dashboardId` (T811, SPEC §10, FRONTEND §18): the
 * dashboard in view mode — its name and description, the widgets on the
 * 12-column grid (one column below 1024 px), each widget loading its own
 * data (at most four requests at once), realtime on `dashboard:{id}`. The
 * route guard shows 404 for a dashboard the caller cannot read; one that
 * goes away while open (deleted, permission lost) says so in place.
 *
 * (T812) `?edit=1` opens the editor for base owners and admins (a lazy
 * chunk); anyone else stays in view mode. The dashboard's theme (mode,
 * palette, density) applies in both.
 */
export function DashboardPage({
  FilterEditor,
  RecordDetail,
  ShareAction,
}: DashboardPageProps = {}) {
  const { t } = useTranslation('dashboard');
  const { baseId = '', dashboardId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const dashboard = useQuery(dashboardQuery(dashboardId));
  const me = useQuery(meQuery());
  const admin = isBaseAdmin(base.access);
  const editRequested = params.get('edit') === '1';
  const editing = admin && editRequested;
  useEffect(() => {
    // Only base owners and admins edit (CONTRACTS §28): others see the dashboard.
    if (editRequested && !admin) {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('edit');
          return next;
        },
        { replace: true },
      );
    }
  }, [admin, editRequested, setParams]);
  const widgets = dashboard.data?.widgets ?? NO_WIDGETS;
  useDashboardRealtime(dashboardId, widgets);
  const filters = useDashboardFilterState(editing ? undefined : dashboard.data);
  const tv = useTvMode(baseId, dashboardId);
  const [drill, setDrill] = useState<RecordsRequest | null>(null);
  useDocumentTitle(dashboard.data?.name ?? t('page.title'));

  const timezone = me.data?.timezone ?? null;
  const context = useMemo<WidgetDataContext>(
    () => ({ permissionVersion: base.permission_version, timezone }),
    [base.permission_version, timezone],
  );
  const renderWidget = useCallback(
    (widget: WidgetDto) => <WidgetCard widget={widget} context={context} admin={admin} />,
    [context, admin],
  );
  const dashboardName = dashboard.data?.name ?? '';
  const download = canDownload(base.access);
  const actions = useMemo<WidgetActions>(
    () => ({
      canDownload: download,
      viewRecords: setDrill,
      downloadCsv: (widget, _title, live) => {
        downloadWidgetCsv(widgetCsvUrl(widget.id, live, timezone), {
          frameTitle: t('widget.downloadFrame'),
          onError: (error) => {
            showToast({ variant: 'error', error });
          },
        });
      },
      downloadPng: (title, dataUrl) => {
        downloadPng(dataUrl, downloadName(dashboardName, title, 'png'));
      },
    }),
    [download, timezone, t, dashboardName],
  );
  // TV mode only shows: no click-through or downloads over the screen.
  const tvActions = useMemo<WidgetActions | null>(() => (tv.on ? null : actions), [tv.on, actions]);

  const leaveEditing = useCallback(() => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('edit');
      return next;
    });
  }, [setParams]);

  if (dashboard.isPending) return <PageSkeleton />;
  if (dashboard.isError) {
    const gone = isApiError(dashboard.error) && dashboard.error.status === 404;
    return (
      <div className="flex min-h-full flex-col bg-canvas">
        <div className={`${PAGE_GUTTER} flex flex-col gap-4 py-10`} data-testid="dashboard-gone">
          {gone ? (
            <WidgetMessage
              kind="no_permission"
              title={t('page.gone.title')}
              detail={t('page.gone.detail')}
              testId={TEST_IDS.dashboardState}
            />
          ) : (
            <ErrorAlert error={dashboard.error} />
          )}
          <Link
            to={`/b/${encodeURIComponent(baseId)}`}
            className="mx-auto text-body text-accent underline-offset-4 hover:underline"
          >
            {t('page.backToBase', { base: base.name })}
          </Link>
        </div>
      </div>
    );
  }

  const data = dashboard.data;
  if (editing) {
    return (
      <Suspense fallback={<PageSkeleton />}>
        <DashboardEditor
          key={data.id}
          dashboard={data}
          base={base}
          context={context}
          FilterEditor={FilterEditor}
          onDone={leaveEditing}
        />
      </Suspense>
    );
  }
  return (
    <DashboardFiltersContext.Provider value={filters}>
      <WidgetActionsContext.Provider value={tvActions}>
        <DashboardSurface
          theme={data.theme}
          testId={TEST_IDS.dashboardPage}
          className={tv.on ? 'fixed inset-0 z-50 overflow-y-auto' : undefined}
          tv={tv.on}
        >
          {tv.on ? (
            <TvToolbar name={data.name} tv={tv} />
          ) : (
            <PageHeading
              icon={LayoutDashboard}
              title={<span data-testid="dashboard-title">{data.name}</span>}
              subtitle={
                data.description === null || data.description === '' ? undefined : data.description
              }
              actions={
                <>
                  {ShareAction === undefined ? null : (
                    <Suspense fallback={null}>
                      <ShareAction dashboard={data} base={base} />
                    </Suspense>
                  )}
                  <Button variant="secondary" onClick={tv.enter} data-testid="dashboard-tv">
                    <Monitor aria-hidden="true" />
                    {t('tv.open')}
                  </Button>
                  {admin ? (
                    <Button asChild variant="secondary">
                      <Link to="?edit=1" data-testid="dashboard-edit">
                        <Pencil aria-hidden="true" />
                        {t('edit.open')}
                      </Link>
                    </Button>
                  ) : null}
                </>
              }
            />
          )}
          <FilterBar baseId={baseId} className={PAGE_GUTTER} />
          <DashboardBody data={data} admin={admin} renderWidget={renderWidget} />
        </DashboardSurface>
        {drill === null ? null : (
          <Suspense fallback={null}>
            <RecordsDrawer
              key={`${drill.widget.id}:${JSON.stringify(drill.segment)}`}
              request={drill}
              base={base}
              context={context}
              RecordDetail={RecordDetail}
              onClose={() => {
                setDrill(null);
              }}
            />
          </Suspense>
        )}
      </WidgetActionsContext.Provider>
    </DashboardFiltersContext.Provider>
  );
}

function DashboardBody({
  data,
  admin,
  renderWidget,
}: {
  readonly data: DashboardDto;
  readonly admin: boolean;
  readonly renderWidget: (widget: WidgetDto) => ReactNode;
}) {
  const { t } = useTranslation('dashboard');
  return (
    <div className={`${PAGE_GUTTER} flex-1 py-6`}>
      {data.widgets.length === 0 ? (
        <div className="mx-auto flex max-w-lg flex-col py-10" data-testid="dashboard-empty">
          <WidgetMessage
            kind="empty"
            title={t('page.empty.title')}
            detail={t(admin ? 'page.empty.admin' : 'page.empty.member')}
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
  );
}

export default DashboardPage;
