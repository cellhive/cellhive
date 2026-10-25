import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import { BarChart3, Filter, FilterX, ListTree, Table2 } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useChartTheme, useReducedMotion } from '../charts/use-chart-theme';
import { useDashboardFilters } from '../filters/use-dashboard-filters';
import { buildChartModel, type ChartModel, type MetricConfig } from '../model/chart-model';
import { buildChartOption, type ChartDisplay } from '../model/chart-option';
import { chartSummary, modelTable } from '../model/table';
import { TEST_IDS } from '../test-ids';
import { ChartSnapshotContext, useWidgetActions } from '../view/widget-actions';

import { DataTable } from './DataTable';

import type { WidgetPresentation } from './presentation';
import type { ChartElementEvent } from '../charts/EChart';
import type { ChartInstance } from '../charts/echarts';
import type {
  WidgetDataDto,
  WidgetDimension,
  WidgetDto,
  WidgetLiveFilterInput,
} from '@cellhive/contracts';

/**
 * ECharts with the chart modules is its own chunk inside the dashboard
 * route: a dashboard of KPIs and text never downloads it.
 */
const EChart = lazy(() => import('../charts/EChart'));

export interface ChartWidgetConfig {
  readonly metrics: readonly MetricConfig[];
  readonly dimension: WidgetDimension;
  readonly display?: ChartWidgetDisplay | undefined;
}

type ChartWidgetDisplay = ChartDisplay & { colors?: Record<string, string> };
const NO_DISPLAY: ChartWidgetDisplay = {};

/** A data element of the chart: category (group) and series. */
interface Point {
  readonly dataIndex: number;
  readonly seriesIndex: number;
}

interface MenuState extends Point {
  readonly x: number;
  readonly y: number;
}

/** Text of a point for the live region and the menu: "Urgent · Lan". */
function pointLabel(model: ChartModel, point: Point, seriesSplit: boolean): string {
  const category = model.categories[point.dataIndex]?.label ?? '';
  const series = model.series[point.seriesIndex];
  return seriesSplit && series !== undefined ? `${category} · ${series.name}` : category;
}

/**
 * Bar, line, combo and pie widgets (T811, S7 decision #6). The chart is an
 * image named by a summary of its numbers; "View as table" swaps it for the
 * same numbers in a `<table>` (FRONTEND §9.2, research §5.3).
 *
 * (T813) In view mode a group is a filter: clicking a bar, slice or point
 * cross-filters the widgets on the same table (again: removed); its context
 * menu (right click, Shift+F10) also offers "View records". The chart takes
 * the focus: arrow keys move between groups (up/down between series),
 * Enter filters, each step read out by a live region. The group filtering
 * the dashboard stays at full strength, the others are dimmed.
 */
export function ChartWidget({
  type,
  title,
  config,
  data,
  presentation,
  widget,
  filters = [],
}: {
  readonly type: 'bar' | 'line' | 'combo' | 'pie';
  readonly title: string;
  readonly config: ChartWidgetConfig;
  readonly data: WidgetDataDto;
  readonly presentation: WidgetPresentation;
  /** (T813) The widget, for cross-filters and click-through (view mode). */
  readonly widget?: WidgetDto | undefined;
  readonly filters?: readonly WidgetLiveFilterInput[];
}) {
  const { t } = useTranslation('dashboard');
  const theme = useChartTheme();
  const reducedMotion = useReducedMotion();
  const [asTable, setAsTable] = useState(false);
  const display = config.display ?? NO_DISPLAY;
  const dashboardFilters = useDashboardFilters();
  const actions = useWidgetActions();
  const snapshot = useContext(ChartSnapshotContext);
  const interactive = widget !== undefined && dashboardFilters.enabled;
  const hintId = useId();
  const chart = useRef<ChartInstance | null>(null);
  const [focus, setFocus] = useState<Point | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const model = useMemo(
    () =>
      buildChartModel({
        type,
        metrics: config.metrics,
        displayColors: display.colors,
        data,
        colors: theme,
        label: presentation.label,
        otherLabel: presentation.otherLabel,
        metricName: presentation.metricName,
        optionSlot: presentation.optionSlot,
      }),
    [type, config.metrics, display.colors, data, theme, presentation],
  );
  const seriesSplit = model.series.some((series) => series.cell !== undefined);
  const cross =
    widget === undefined
      ? undefined
      : dashboardFilters.state.cross.find((item) => item.widgetId === widget.id);
  const selected = useMemo(() => {
    if (cross === undefined) return null;
    const index = model.categories.findIndex(
      (category) => !category.other && category.cell.value === cross.value,
    );
    return index === -1 ? null : index;
  }, [cross, model.categories]);

  const dimensionLabel = presentation.fieldName(config.dimension.field) ?? t('chart.dimension');
  const table = useMemo(
    () => modelTable(model, dimensionLabel, presentation.format),
    [model, dimensionLabel, presentation.format],
  );
  const summary = chartSummary(table, title);
  const description = t('chart.summary', {
    kind: t(`type.${type}`),
    title: summary.heading,
    count: model.categories.length,
    formatted: new Intl.NumberFormat(presentation.locale).format(model.categories.length),
    items: summary.items,
  });
  const option = useMemo(
    () =>
      buildChartOption({
        type,
        model,
        display,
        theme,
        format: presentation.format,
        percent: presentation.percent,
        reducedMotion,
        description,
        pieTotal: data.total?.[0] ?? null,
        selected,
      }),
    [type, model, display, theme, presentation, reducedMotion, description, data.total, selected],
  );

  const onReady = useCallback(
    (instance: ChartInstance | null) => {
      chart.current = instance;
      snapshot?.set(
        instance === null
          ? null
          : () =>
              instance.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: theme.surface }),
      );
    },
    [snapshot, theme.surface],
  );
  useEffect(() => {
    // The background follows the theme: register again when it changes.
    if (chart.current !== null) onReady(chart.current);
  }, [onReady]);

  const toggleCross = (point: Point) => {
    const category = model.categories[point.dataIndex];
    if (widget === undefined || category === undefined || category.other) return;
    dashboardFilters.toggleCross({
      widgetId: widget.id,
      value: category.cell.value,
      label: category.label,
    });
  };
  const viewRecords = (point: Point) => {
    const category = model.categories[point.dataIndex];
    if (
      widget === undefined ||
      actions === null ||
      actions.viewRecords === null ||
      category === undefined ||
      category.other
    ) {
      return;
    }
    const series = model.series[point.seriesIndex];
    actions.viewRecords({
      widget,
      title,
      segment: {
        dimension: category.cell.value,
        ...(series?.cell === undefined ? {} : { series: series.cell.value }),
      },
      segmentLabel: pointLabel(model, point, seriesSplit),
      filters,
    });
  };
  const onElement = (event: ChartElementEvent) => {
    const point = {
      dataIndex: event.dataIndex,
      seriesIndex: model.series.length > 1 ? event.seriesIndex : 0,
    };
    if (event.kind === 'click') toggleCross(point);
    else setMenu({ ...point, x: event.x, y: event.y });
  };

  const show = (point: Point | null) => {
    const instance = chart.current;
    if (instance === null) return;
    instance.dispatchAction({ type: 'downplay' });
    instance.dispatchAction({ type: 'hideTip' });
    if (point === null) return;
    const seriesIndex = type === 'pie' ? 0 : point.seriesIndex;
    instance.dispatchAction({ type: 'highlight', seriesIndex, dataIndex: point.dataIndex });
    instance.dispatchAction({ type: 'showTip', seriesIndex, dataIndex: point.dataIndex });
  };
  const move = (point: Point) => {
    setFocus(point);
    show(point);
    const row = table.rows[point.dataIndex] ?? [];
    const values =
      type === 'pie' || model.series.length === 1
        ? (row[1] ?? '')
        : `${model.series[point.seriesIndex]?.name ?? ''} ${row[point.seriesIndex + 1] ?? ''}`;
    const filtered = selected === point.dataIndex ? ` ${t('chart.keyboard.filtering')}` : '';
    setAnnouncement(`${model.categories[point.dataIndex]?.label ?? ''}: ${values}.${filtered}`);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = model.categories.length;
    if (count === 0) return;
    const seriesCount = type === 'pie' ? 1 : Math.max(model.series.length, 1);
    const current = focus ?? { dataIndex: -1, seriesIndex: 0 };
    const at = (dataIndex: number, seriesIndex = current.seriesIndex) => {
      event.preventDefault();
      move({
        dataIndex: (dataIndex + count) % count,
        seriesIndex: (seriesIndex + seriesCount) % seriesCount,
      });
    };
    switch (event.key) {
      case 'ArrowRight':
        at(current.dataIndex + 1);
        return;
      case 'ArrowLeft':
        at(current.dataIndex < 0 ? count - 1 : current.dataIndex - 1);
        return;
      case 'ArrowDown':
        if (seriesCount > 1) at(Math.max(current.dataIndex, 0), current.seriesIndex + 1);
        else at(current.dataIndex + 1);
        return;
      case 'ArrowUp':
        if (seriesCount > 1) at(Math.max(current.dataIndex, 0), current.seriesIndex - 1);
        else at(current.dataIndex < 0 ? count - 1 : current.dataIndex - 1);
        return;
      case 'Home':
        at(0);
        return;
      case 'End':
        at(count - 1);
        return;
      case 'Enter':
      case ' ':
        if (focus === null) return;
        event.preventDefault();
        toggleCross(focus);
        return;
      case 'Escape':
        if (focus === null) return;
        event.preventDefault();
        setFocus(null);
        show(null);
        return;
      case 'ContextMenu':
      case 'F10':
        if (event.key === 'F10' && !event.shiftKey) return;
        if (focus === null) return;
        event.preventDefault();
        setMenu({ ...focus, x: (box.current?.clientWidth ?? 0) / 2, y: 16 });
        return;
      default:
    }
  };

  const menuCategory = menu === null ? undefined : model.categories[menu.dataIndex];
  const menuLabel = menu === null ? '' : pointLabel(model, menu, seriesSplit);
  const menuFiltering = menu !== null && selected === menu.dataIndex;

  return (
    <div className="flex size-full min-h-0 flex-col gap-2">
      <div ref={box} className="relative min-h-0 flex-1">
        {asTable ? (
          <DataTable
            caption={t('chart.tableCaption', { title })}
            columns={table.columns}
            rows={table.rows}
            mutedRows={table.otherRow === null ? undefined : new Set([table.otherRow])}
            testId={TEST_IDS.widgetDataTable}
          />
        ) : (
          <Suspense fallback={null}>
            <EChart
              option={option}
              label={description}
              testId={TEST_IDS.widgetChart}
              onReady={onReady}
              onElement={interactive ? onElement : undefined}
              onKeyDown={interactive ? onKeyDown : undefined}
              onBlur={() => {
                if (menu === null) show(null);
              }}
              describedBy={interactive ? hintId : undefined}
            />
          </Suspense>
        )}
        {interactive && !asTable ? (
          <>
            <p id={hintId} className="sr-only">
              {t('chart.keyboard.hint')}
            </p>
            <p className="sr-only" aria-live="polite" data-testid="chart-live">
              {announcement}
            </p>
          </>
        ) : null}
        {menu !== null && menuCategory !== undefined && !menuCategory.other ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) setMenu(null);
            }}
          >
            <DropdownMenuTrigger asChild>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute size-px"
                style={{ left: menu.x, top: menu.y }}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              data-testid="chart-element-menu"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const target = box.current?.firstElementChild;
                if (target instanceof HTMLElement) target.focus();
              }}
            >
              <DropdownMenuItem
                onSelect={() => {
                  toggleCross(menu);
                }}
              >
                {menuFiltering ? <FilterX aria-hidden="true" /> : <Filter aria-hidden="true" />}
                {menuFiltering
                  ? t('chart.menu.unfilter', { value: menuCategory.label })
                  : t('chart.menu.filter', { value: menuCategory.label })}
              </DropdownMenuItem>
              {actions === null || actions.viewRecords === null ? null : (
                <DropdownMenuItem
                  onSelect={() => {
                    viewRecords(menu);
                  }}
                >
                  <ListTree aria-hidden="true" />
                  {t('chart.menu.records', { value: menuLabel })}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          className="max-lg:h-control"
          aria-pressed={asTable}
          onClick={() => {
            setAsTable((value) => !value);
          }}
        >
          {/* A toggle keeps one name; `aria-pressed` says which way it is. */}
          {asTable ? <BarChart3 aria-hidden="true" /> : <Table2 aria-hidden="true" />}
          {t('chart.showTable')}
        </Button>
      </div>
    </div>
  );
}
