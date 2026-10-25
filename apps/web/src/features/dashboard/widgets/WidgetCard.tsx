import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
} from '@cellhive/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, ImageDown, Info, ListTree, MoreHorizontal } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useState,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { translateError } from '../../../lib/errors/translate';
import { type WidgetDataContext } from '../api';
import { isDataWidget, type NotApplied, type WidgetLiveFilters } from '../filters/filter-state';
import { FilterControlWidget } from '../filters/FilterControlWidget';
import { useDashboardFilters, useWidgetLiveFilters } from '../filters/use-dashboard-filters';
import { buildChartModel, type MetricConfig } from '../model/chart-model';
import { modelTable } from '../model/table';
import { TEST_IDS } from '../test-ids';
import { useDashboardDataSource } from '../view/data-source';
import {
  ChartSnapshot,
  ChartSnapshotContext,
  useWidgetActions,
  type WidgetActions,
} from '../view/widget-actions';

import { ChartWidget, type ChartWidgetConfig } from './ChartWidget';
import { DataTable } from './DataTable';
import { KpiWidget, type KpiWidgetDisplay } from './KpiWidget';
import { useWidgetPresentation } from './presentation';
import { TextWidget } from './TextWidget';
import { WidgetBoundary } from './WidgetBoundary';
import { WidgetMessage } from './WidgetMessage';

import type { WidgetNumberFormat } from '../model/format';
import type {
  FieldDto,
  WidgetDataDto,
  WidgetDimension,
  WidgetDto,
  WidgetLiveFilterInput,
} from '@cellhive/contracts';

const RecordsTable = lazy(() => import('./RecordsTable'));

/** The config keys the view reads (the API filled the defaults, CONTRACTS §28.2). */
interface ViewConfig {
  readonly table_id?: string;
  readonly filter?: unknown;
  readonly description?: string | null;
  readonly metrics?: readonly MetricConfig[];
  readonly dimension?: WidgetDimension;
  readonly series_dimension?: WidgetDimension | null;
  readonly table?:
    | {
        readonly mode: 'pivot';
        readonly dimension: WidgetDimension;
        readonly metrics: readonly MetricConfig[];
      }
    | { readonly mode: 'records' };
  readonly markdown?: string;
  readonly display?: Record<string, unknown> & {
    readonly number_format?: WidgetNumberFormat | null;
    readonly empty_text?: string | null;
  };
}

const NO_METRICS: readonly MetricConfig[] = [];

/** (T812) What the editor adds to a card: its actions, keyboard moves. */
export interface WidgetCardFrame {
  /** Buttons at the end of the header (drag handle, actions menu). */
  readonly actions?: ReactNode;
  readonly ref?: Ref<HTMLElement>;
  readonly onKeyDown?: KeyboardEventHandler<HTMLElement>;
  readonly onBlur?: FocusEventHandler<HTMLElement>;
  /** Id of the text describing the card (the keyboard move instructions). */
  readonly describedBy?: string | undefined;
  /** Moved or resized with the keyboard right now. */
  readonly active?: boolean;
}

export interface WidgetCardProps {
  readonly widget: WidgetDto;
  readonly context: WidgetDataContext;
  /** Base admin: sees how to fix a broken widget (research §5.2). */
  readonly admin: boolean;
  /** (T812) Edit mode only. */
  readonly frame?: WidgetCardFrame | undefined;
}

/**
 * One widget of the dashboard (T811): a titled card in the reading order
 * (focusable, named by its title), its own error boundary (FRONTEND §8.2),
 * a skeleton of the same size while loading, then the widget or its state
 * (`empty`, `no_permission`, `broken`, failed / timed out with "Try again").
 */
export function WidgetCard({ widget, context, admin, frame }: WidgetCardProps) {
  const { t } = useTranslation('dashboard');
  const titleId = useId();
  const config = widget.config as ViewConfig;
  const title = widget.title.trim() === '' ? t(`type.${widget.type}`) : widget.title;
  const description = config.description ?? null;
  const live = useWidgetLiveFilters(widget);
  const actions = useWidgetActions();
  // (T813) The drawn chart registers its PNG here for the widget menu.
  const [snapshot] = useState(() => new ChartSnapshot());
  return (
    <section
      ref={frame?.ref}
      aria-labelledby={titleId}
      aria-describedby={frame?.describedBy}
      tabIndex={0}
      data-testid={`widget-${widget.id}`}
      data-widget-type={widget.type}
      onKeyDown={frame?.onKeyDown}
      onBlur={frame?.onBlur}
      className={cn(
        'flex size-full min-h-0 flex-col gap-2 overflow-hidden rounded-lg border border-line bg-surface p-4 focus-visible:outline-2 focus-visible:outline-accent group-data-[density=compact]/dashboard:gap-1.5 group-data-[density=compact]/dashboard:p-3',
        frame?.active === true && 'outline-2 outline-offset-2 outline-accent',
      )}
    >
      <header className="flex min-w-0 items-start gap-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id={titleId} className="truncate text-heading font-semibold text-fg">
            {title}
          </h2>
          {description === null || description === '' ? null : (
            <p className="truncate text-label font-normal text-fg-muted">{description}</p>
          )}
        </div>
        {frame === undefined ? (
          actions === null ? null : (
            <WidgetMenu
              widget={widget}
              title={title}
              actions={actions}
              snapshot={snapshot}
              filters={live.filters}
            />
          )
        ) : (
          frame.actions
        )}
      </header>
      <div className="min-h-0 flex-1">
        <WidgetBoundary
          fallback={(reset) => (
            <WidgetMessage
              kind="error"
              title={t('state.renderFailed')}
              onRetry={reset}
              testId={TEST_IDS.widgetState}
            />
          )}
        >
          <ChartSnapshotContext.Provider value={snapshot}>
            <WidgetBody
              widget={widget}
              config={config}
              title={title}
              context={context}
              admin={admin}
              live={live}
            />
          </ChartSnapshotContext.Provider>
        </WidgetBoundary>
      </div>
    </section>
  );
}

function WidgetBody({
  widget,
  config,
  title,
  context,
  admin,
  live,
}: {
  readonly widget: WidgetDto;
  readonly config: ViewConfig;
  readonly title: string;
  readonly context: WidgetDataContext;
  readonly admin: boolean;
  readonly live: WidgetLiveFilters;
}) {
  if (widget.type === 'text') return <TextWidget markdown={config.markdown ?? ''} />;
  if (widget.status === 'broken') {
    return <BrokenMessage admin={admin} reason={widget.broken_reason} />;
  }
  if (widget.type === 'filter_control') {
    return <FilterControlWidget widget={widget} title={title} context={context} />;
  }
  return (
    <DataWidget
      widget={widget}
      config={config}
      title={title}
      context={context}
      admin={admin}
      live={live}
    />
  );
}

function BrokenMessage({
  admin,
  reason,
}: {
  readonly admin: boolean;
  readonly reason: WidgetDto['broken_reason'];
}) {
  const { t } = useTranslation('dashboard');
  return (
    <WidgetMessage
      kind="broken"
      title={t('state.broken.title')}
      detail={
        admin
          ? t(reason === 'table_deleted' ? 'state.broken.tableAdmin' : 'state.broken.fieldAdmin')
          : t('state.broken.member')
      }
      testId={TEST_IDS.widgetState}
    />
  );
}

function DataWidget({
  widget,
  config,
  title,
  context,
  admin,
  live,
}: {
  readonly widget: WidgetDto;
  readonly config: ViewConfig;
  readonly title: string;
  readonly context: WidgetDataContext;
  readonly admin: boolean;
  readonly live: WidgetLiveFilters;
}) {
  return (
    <FilterNotices widget={widget} context={context} live={live}>
      <DataWidgetContent
        widget={widget}
        config={config}
        title={title}
        context={context}
        admin={admin}
        live={live}
      />
    </FilterNotices>
  );
}

function DataWidgetContent({
  widget,
  config,
  title,
  context,
  admin,
  live,
}: {
  readonly widget: WidgetDto;
  readonly config: ViewConfig;
  readonly title: string;
  readonly context: WidgetDataContext;
  readonly admin: boolean;
  readonly live: WidgetLiveFilters;
}) {
  const { t, i18n } = useTranslation('dashboard');
  const queryClient = useQueryClient();
  const source = useDashboardDataSource();
  const query = useQuery(source.widgetData(widget, context, live.filters));
  const data = query.data;
  const gone = isApiError(query.error) && query.error.status === 404;
  useEffect(() => {
    // The widget went away meanwhile: read the dashboard again.
    if (gone) {
      void queryClient.invalidateQueries({ queryKey: source.dashboardKey(widget.dashboard_id) });
    }
  }, [gone, queryClient, source, widget.dashboard_id]);
  const tableId = config.table_id ?? '';
  const fields = useQuery({ ...source.fields(tableId), enabled: data?.status === 'ok' });
  const metrics =
    (config.table?.mode === 'pivot' ? config.table.metrics : config.metrics) ?? NO_METRICS;
  const dimension = config.table?.mode === 'pivot' ? config.table.dimension : config.dimension;
  const optionFields = useMemo(
    () => [dimension?.field, config.series_dimension?.field],
    [dimension?.field, config.series_dimension?.field],
  );
  const presentation = useWidgetPresentation(
    metrics,
    config.display?.number_format,
    fields.data?.items,
    optionFields,
  );

  if (query.isPending) {
    return <Skeleton className="size-full" aria-hidden="true" data-testid="widget-skeleton" />;
  }
  if (query.isError) {
    const error = query.error;
    const retry = () => {
      void query.refetch();
    };
    if (isApiError(error) && (error.status === 504 || error.code === 'QUERY_TIMEOUT')) {
      return (
        <WidgetMessage
          kind="error"
          title={t('state.timeout.title')}
          detail={t('state.timeout.detail')}
          onRetry={retry}
          testId={TEST_IDS.widgetState}
        />
      );
    }
    const translated = translateError(error, i18n);
    return (
      <WidgetMessage
        kind="error"
        title={t('state.error')}
        detail={translated.details[0]?.message ?? translated.message}
        onRetry={retry}
        testId={TEST_IDS.widgetState}
      />
    );
  }
  switch (data?.status) {
    case 'no_permission':
      return (
        <WidgetMessage
          kind="no_permission"
          title={t('state.noPermission')}
          testId={TEST_IDS.widgetState}
        />
      );
    case 'broken':
      return <BrokenMessage admin={admin} reason={widget.broken_reason} />;
    case 'empty': {
      const own = config.display?.empty_text;
      return (
        <WidgetMessage
          kind="empty"
          title={own === null || own === undefined || own === '' ? t('state.empty.title') : own}
          detail={
            live.filters.length > 0
              ? t('state.empty.live')
              : config.filter !== null && config.filter !== undefined
                ? t('state.empty.filtered')
                : t('state.empty.detail')
          }
          testId={TEST_IDS.widgetState}
        />
      );
    }
    case undefined:
      return null;
    case 'ok':
      return (
        <OkWidget
          widget={widget}
          config={config}
          title={title}
          data={data}
          metrics={metrics}
          dimension={dimension}
          presentation={presentation}
          fields={fields.data?.items}
          filters={live.filters}
        />
      );
  }
}

function OkWidget({
  widget,
  config,
  title,
  data,
  metrics,
  dimension,
  presentation,
  fields,
  filters,
}: {
  readonly widget: WidgetDto;
  readonly config: ViewConfig;
  readonly title: string;
  readonly data: WidgetDataDto;
  readonly metrics: readonly MetricConfig[];
  readonly dimension: WidgetDimension | undefined;
  readonly presentation: ReturnType<typeof useWidgetPresentation>;
  readonly fields: readonly FieldDto[] | undefined;
  readonly filters: readonly WidgetLiveFilterInput[];
}): ReactNode {
  const { t } = useTranslation('dashboard');
  switch (widget.type) {
    case 'kpi':
      return (
        <KpiWidget
          metricId={metrics[0]?.id ?? ''}
          data={data}
          display={(config.display ?? {}) as KpiWidgetDisplay}
          presentation={presentation}
        />
      );
    case 'bar':
    case 'line':
    case 'combo':
    case 'pie':
      if (dimension === undefined) return null;
      return (
        <ChartWidget
          type={widget.type}
          title={title}
          config={{ ...(config as ChartWidgetConfig), metrics, dimension }}
          data={data}
          presentation={presentation}
          widget={widget}
          filters={filters}
        />
      );
    case 'table': {
      if (config.table?.mode === 'records') {
        if (fields === undefined) {
          return <Skeleton className="size-full" aria-hidden="true" />;
        }
        return (
          <Suspense fallback={<Skeleton className="size-full" aria-hidden="true" />}>
            <RecordsTable caption={title} data={data} fields={fields} />
          </Suspense>
        );
      }
      const model = buildChartModel({
        type: 'bar',
        metrics,
        data,
        colors: { palette: [], other: '' },
        label: presentation.label,
        otherLabel: presentation.otherLabel,
        metricName: presentation.metricName,
      });
      const table = modelTable(
        model,
        presentation.fieldName(dimension?.field) ?? t('chart.dimension'),
        presentation.format,
      );
      return (
        <DataTable
          caption={title}
          columns={table.columns}
          rows={table.rows}
          testId={TEST_IDS.widgetPivot}
        />
      );
    }
    default:
      return null;
  }
}

const CHART_TYPES: ReadonlySet<string> = new Set(['bar', 'line', 'pie', 'combo']);

/**
 * (T813) The "…" menu of a widget in view mode: "View records"
 * (click-through, every record behind the widget), "Download PNG" (charts,
 * ECharts `getDataURL` on the theme's background) and "Download CSV" (the
 * aggregate table, CONTRACTS §28.6) — the downloads only with
 * `base_rule.download` (S7 decision #12), otherwise not offered.
 */
function WidgetMenu({
  widget,
  title,
  actions,
  snapshot,
  filters,
}: {
  readonly widget: WidgetDto;
  readonly title: string;
  readonly actions: WidgetActions;
  readonly snapshot: ChartSnapshot;
  readonly filters: readonly WidgetLiveFilterInput[];
}) {
  const { t } = useTranslation('dashboard');
  if (!isDataWidget(widget) || widget.status === 'broken') return null;
  const records = (widget.config as ViewConfig).table?.mode === 'records';
  const png = actions.canDownload && CHART_TYPES.has(widget.type);
  const csv = actions.canDownload && !records;
  // (T814) No click-through through a share link (CONTRACTS §16A).
  const viewRecords = !records && actions.viewRecords !== null;
  if (!viewRecords && !png && !csv) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="-my-1 size-7 max-lg:size-control"
          aria-label={t('widget.actions', { name: title })}
          data-testid="widget-menu"
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <WidgetMenuItems
          widget={widget}
          title={title}
          actions={actions}
          snapshot={snapshot}
          filters={filters}
          viewRecords={viewRecords}
          png={png}
          csv={csv}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Rendered when the menu opens: "Download PNG" is enabled while a chart is drawn. */
function WidgetMenuItems({
  widget,
  title,
  actions,
  snapshot,
  filters,
  viewRecords,
  png,
  csv,
}: {
  readonly widget: WidgetDto;
  readonly title: string;
  readonly actions: WidgetActions;
  readonly snapshot: ChartSnapshot;
  readonly filters: readonly WidgetLiveFilterInput[];
  readonly viewRecords: boolean;
  readonly png: boolean;
  readonly csv: boolean;
}) {
  const { t } = useTranslation('dashboard');
  return (
    <>
      {viewRecords ? (
        <DropdownMenuItem
          onSelect={() => {
            actions.viewRecords?.({ widget, title, segment: null, segmentLabel: null, filters });
          }}
        >
          <ListTree aria-hidden="true" />
          {t('widget.viewRecords')}
        </DropdownMenuItem>
      ) : null}
      {png ? (
        <DropdownMenuItem
          disabled={!snapshot.ready}
          onSelect={() => {
            const url = snapshot.take();
            if (url !== null) actions.downloadPng(title, url);
          }}
        >
          <ImageDown aria-hidden="true" />
          {t('widget.downloadPng')}
        </DropdownMenuItem>
      ) : null}
      {csv ? (
        <DropdownMenuItem
          onSelect={() => {
            actions.downloadCsv(widget, title, filters);
          }}
        >
          <FileText aria-hidden="true" />
          {t('widget.downloadCsv')}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

/**
 * (T813, research §5.4) Live filters that do not change a widget's numbers,
 * said in text above them: a global or cross-filter on another table
 * (known here), and what the server left out (`ignored_filters`: a field
 * the viewer cannot read, a broken control). Filters it simply does not
 * follow (`not_bound`) and its own cross-filter (`self`) say nothing.
 */
function FilterNotices({
  widget,
  context,
  live,
  children,
}: {
  readonly widget: WidgetDto;
  readonly context: WidgetDataContext;
  readonly live: WidgetLiveFilters;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation('dashboard');
  const { dashboard, state } = useDashboardFilters();
  const source = useDashboardDataSource();
  // The same query as the widget's (no second request): only to read `ignored_filters`.
  const query = useQuery({ ...source.widgetData(widget, context, live.filters), enabled: false });
  const notices: NotApplied[] = [
    ...live.notApplied,
    ...(query.data?.ignored_filters ?? []).filter(
      (item) => item.reason !== 'self' && item.reason !== 'not_bound',
    ),
  ];
  if (notices.length === 0) return children;
  const nameOf = (notice: NotApplied): string => {
    if (notice.source === 'global') {
      const index = dashboard.global_filters.findIndex((filter) => filter.id === notice.id);
      const label = dashboard.global_filters[index]?.label;
      return label === null || label === undefined || label === ''
        ? t('filters.globalUnnamed', { position: index + 1 })
        : label;
    }
    if (notice.source === 'cross') {
      const cross = state.cross.find((item) => item.widgetId === notice.id);
      return t('notice.cross', { value: cross?.label ?? '' });
    }
    const control = dashboard.widgets.find((item) => item.id === notice.id);
    return control === undefined || control.title.trim() === ''
      ? t('type.filter_control')
      : control.title;
  };
  return (
    <div className="flex size-full min-h-0 flex-col gap-1">
      <ul className="flex flex-col gap-0.5" data-testid="widget-filter-notices">
        {notices.map((notice) => (
          <li
            key={`${notice.source}:${notice.id}`}
            className="flex min-w-0 items-start gap-1 text-label font-normal text-fg-muted"
            data-reason={notice.reason}
          >
            <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">
              {t(
                `notice.${notice.reason === 'not_bound' || notice.reason === 'self' ? 'broken' : notice.reason}`,
                {
                  name: nameOf(notice),
                },
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
