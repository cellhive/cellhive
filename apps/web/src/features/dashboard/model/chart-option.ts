import { toPercentStack, type ChartModel, type ChartSeries } from './chart-model';

import type { NumberFormatter } from './format';
import type { ChartOption } from '../charts/echarts';

/**
 * Chart model → ECharts option (T811, S7 decisions #6, #18, #20; research
 * §5): bar (vertical/horizontal; grouped, stacked, 100 % stacked), line
 * (area, smooth), combo (bars + lines on two value axes) and pie (donut).
 * Thin marks with rounded data ends, recessive axes in text tokens, a
 * legend for two series or more, patterns (`aria.decal`) so series never
 * rely on color alone, the `aria` description given by the caller, no
 * animation under `prefers-reduced-motion`. Tooltips are built as DOM
 * nodes with text content (no HTML strings: CSP, and labels are user data).
 */

export interface ChartDisplay {
  readonly orientation?: 'vertical' | 'horizontal' | undefined;
  readonly stack?: 'grouped' | 'stacked' | 'percent' | undefined;
  readonly area?: boolean | undefined;
  readonly smooth?: boolean | undefined;
  readonly donut?: boolean | undefined;
  readonly show_legend?: boolean | undefined;
  readonly show_values?: boolean | undefined;
  readonly x_axis_label?: string | null | undefined;
  readonly y_axis_label?: string | null | undefined;
}

/** Colors and font read from the design tokens (FRONTEND §9.3). */
export interface ChartTheme {
  readonly text: string;
  readonly muted: string;
  readonly line: string;
  readonly surface: string;
  readonly font: string;
}

export interface ChartOptionInput {
  readonly type: 'bar' | 'line' | 'combo' | 'pie';
  readonly model: ChartModel;
  readonly display: ChartDisplay;
  readonly theme: ChartTheme;
  /** Number format of a metric. */
  readonly format: (metricId: string) => NumberFormatter;
  /** Percent format (100 % stacks, pie shares). */
  readonly percent: NumberFormatter;
  readonly reducedMotion: boolean;
  /** Text alternative of the chart (ECharts `aria.label.description`). */
  readonly description: string;
  /** Total of the pie's metric over every record (`total[0]`), for the shares. */
  readonly pieTotal?: number | null | undefined;
  /**
   * (T813) The category this widget cross-filters the dashboard by: the
   * others are dimmed (the group stays readable by its label and the chip).
   */
  readonly selected?: number | null | undefined;
}

/** Opacity of the categories a cross-filter of the widget leaves out. */
export const DIMMED_OPACITY = 0.35;

function seriesData(values: readonly (number | null)[], selected: number | null | undefined) {
  if (selected === null || selected === undefined) return [...values];
  return values.map((value, index) =>
    index === selected ? value : { value, itemStyle: { opacity: DIMMED_OPACITY } },
  );
}

const AXIS_LABEL_WIDTH = 120;

function tooltipNode(
  title: string,
  lines: readonly { color: string; name: string; value: string }[],
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'flex flex-col gap-1 text-label';
  const heading = document.createElement('div');
  heading.className = 'font-medium';
  heading.textContent = title;
  root.append(heading);
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2';
    const swatch = document.createElement('span');
    swatch.className = 'inline-block size-2.5 shrink-0 rounded-full';
    swatch.style.backgroundColor = line.color;
    const name = document.createElement('span');
    name.className = 'min-w-0 flex-1 truncate font-normal text-fg-muted';
    name.textContent = line.name;
    const value = document.createElement('span');
    value.className = 'font-medium tabular-nums';
    value.textContent = line.value;
    row.append(swatch, name, value);
    root.append(row);
  }
  return root;
}

function formatValue(
  input: ChartOptionInput,
  series: ChartSeries,
  value: number | null | undefined,
): string {
  return value === null || value === undefined ? '–' : input.format(series.metricId)(value);
}

interface AxisParam {
  readonly dataIndex: number;
  readonly seriesIndex?: number;
}

function common(input: ChartOptionInput, legend: boolean): ChartOption {
  const { theme } = input;
  return {
    animation: !input.reducedMotion,
    animationDuration: 300,
    animationDurationUpdate: 200,
    textStyle: { fontFamily: theme.font, color: theme.text },
    aria: {
      enabled: true,
      label: { enabled: true, description: input.description },
      // Patterns on fills: series never told apart by color alone (research §5.3).
      decal: { show: legend },
    },
    legend: {
      show: legend,
      type: 'scroll',
      bottom: 0,
      icon: 'roundRect',
      itemWidth: 12,
      itemHeight: 12,
      textStyle: { color: theme.muted, fontFamily: theme.font, fontSize: 12 },
      pageTextStyle: { color: theme.muted },
    },
    tooltip: {
      confine: true,
      backgroundColor: theme.surface,
      borderColor: theme.line,
      textStyle: { color: theme.text, fontFamily: theme.font, fontSize: 12 },
      transitionDuration: input.reducedMotion ? 0 : 0.2,
    },
  };
}

function pieOption(input: ChartOptionInput): ChartOption {
  const { model, theme } = input;
  const series = model.series[0];
  const legend = input.display.show_legend !== false;
  const values = series?.values ?? [];
  const total =
    input.pieTotal ?? values.reduce<number>((sum, value) => sum + Math.abs(value ?? 0), 0);
  const share = (value: number | null | undefined) =>
    total === 0 || value === null || value === undefined ? null : (value / total) * 100;
  const base = common(input, legend);
  return {
    ...base,
    tooltip: {
      ...(base.tooltip as object),
      trigger: 'item',
      formatter: (params: unknown) => {
        const { dataIndex } = params as AxisParam;
        const category = model.categories[dataIndex];
        const value = values[dataIndex];
        const percent = share(value);
        return tooltipNode(category?.label ?? '', [
          {
            color: model.sliceColors[dataIndex] ?? theme.muted,
            name: series?.name ?? '',
            value:
              series === undefined
                ? '–'
                : `${formatValue(input, series, value)}${percent === null ? '' : ` (${input.percent(percent)})`}`,
          },
        ]);
      },
    },
    series: [
      {
        type: 'pie',
        name: series?.name ?? '',
        radius: input.display.donut === true ? ['45%', '72%'] : [0, '72%'],
        center: ['50%', legend ? '45%' : '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 4 },
        label: {
          show: input.display.show_values !== false,
          color: theme.text,
          fontFamily: theme.font,
          fontSize: 12,
          formatter: (params: unknown) => {
            const { dataIndex } = params as AxisParam;
            const percent = share(values[dataIndex]);
            const label = model.categories[dataIndex]?.label ?? '';
            return percent === null ? label : `${label}: ${input.percent(percent)}`;
          },
        },
        labelLine: { lineStyle: { color: theme.line } },
        data: model.categories.map((category, index) => ({
          name: category.label,
          value: values[index] ?? 0,
          itemStyle: {
            color: model.sliceColors[index] ?? theme.muted,
            ...(input.selected === null || input.selected === undefined || input.selected === index
              ? {}
              : { opacity: DIMMED_OPACITY }),
          },
        })),
      },
    ],
  };
}

export function buildChartOption(input: ChartOptionInput): ChartOption {
  if (input.type === 'pie') return pieOption(input);
  const { model, theme, display } = input;
  const horizontal = input.type === 'bar' && display.orientation === 'horizontal';
  const stackMode = input.type === 'bar' ? (display.stack ?? 'grouped') : 'grouped';
  const percent = stackMode === 'percent';
  const stacked = stackMode !== 'grouped';
  const shown = percent ? toPercentStack(model.series) : model.series;
  const legend = display.show_legend !== false && model.series.length > 1;
  const twoAxes = input.type === 'combo' && model.series.some((series) => series.axis === 1);
  const base = common(input, legend);

  const axisFormat = (axis: 0 | 1): NumberFormatter => {
    if (percent) return input.percent;
    const first = model.series.find((series) => series.axis === axis) ?? model.series[0];
    return first === undefined ? (value) => String(value) : input.format(first.metricId);
  };
  const categoryAxis = {
    type: 'category' as const,
    data: model.categories.map((category) => category.label),
    name: display.x_axis_label ?? '',
    nameLocation: 'middle' as const,
    nameGap: 28,
    nameTextStyle: { color: theme.muted },
    axisLine: { lineStyle: { color: theme.line } },
    axisTick: { show: false },
    axisLabel: {
      color: theme.muted,
      fontSize: 12,
      width: AXIS_LABEL_WIDTH,
      overflow: 'truncate' as const,
      hideOverlap: true,
    },
  };
  // Whole numbers only (counts, sums of whole numbers): no "0.5 orders" ticks.
  const wholeOnly = (axis: 0 | 1) =>
    model.series
      .filter((series) => (twoAxes ? series.axis === axis : true))
      .every((series) => series.values.every((value) => value === null || Number.isInteger(value)));
  const valueAxis = (axis: 0 | 1) => ({
    type: 'value' as const,
    name: axis === 0 ? (display.y_axis_label ?? '') : '',
    nameTextStyle: { color: theme.muted },
    ...(percent ? { max: 100 } : wholeOnly(axis) ? { minInterval: 1 } : {}),
    splitLine: { show: axis === 0, lineStyle: { color: theme.line } },
    axisLabel: {
      color: theme.muted,
      fontSize: 12,
      formatter: (value: number) => axisFormat(axis)(value),
    },
  });
  const valueAxes = twoAxes ? [valueAxis(0), valueAxis(1)] : [valueAxis(0)];

  return {
    ...base,
    grid: {
      left: 8,
      right: 8,
      top: 16,
      bottom: legend ? 32 : 8,
      outerBoundsMode: 'same',
      outerBoundsContain: 'axisLabel',
    },
    tooltip: {
      ...(base.tooltip as object),
      trigger: 'axis',
      axisPointer: { type: input.type === 'line' ? 'line' : 'shadow' },
      formatter: (params: unknown) => {
        const list = (Array.isArray(params) ? params : [params]) as AxisParam[];
        const dataIndex = list[0]?.dataIndex ?? 0;
        const category = model.categories[dataIndex];
        return tooltipNode(
          category?.label ?? '',
          model.series.map((series, index) => {
            const value = series.values[dataIndex];
            const share = percent ? shown[index]?.values[dataIndex] : null;
            return {
              color: series.color,
              name: series.name,
              value:
                share === null || share === undefined
                  ? formatValue(input, series, value)
                  : `${formatValue(input, series, value)} (${input.percent(share)})`,
            };
          }),
        );
      },
    },
    xAxis: horizontal ? valueAxes : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxes,
    series: shown.map((series, index) => {
      const original = model.series[index] ?? series;
      const label = {
        show: display.show_values === true,
        position: (stacked ? 'inside' : horizontal ? 'right' : 'top') as 'inside',
        color: stacked ? theme.surface : theme.text,
        fontSize: 12,
        formatter: (params: unknown) => {
          const { dataIndex } = params as AxisParam;
          const value = series.values[dataIndex];
          if (value === null || value === undefined) return '';
          return percent ? input.percent(value) : formatValue(input, original, value);
        },
      };
      if (series.kind === 'line') {
        return {
          type: 'line' as const,
          name: series.name,
          data: seriesData(series.values, input.selected),
          yAxisIndex: twoAxes ? series.axis : 0,
          smooth: display.smooth === true,
          showSymbol: series.values.length <= 31,
          symbolSize: 8,
          lineStyle: { width: 2, color: series.color },
          itemStyle: { color: series.color, borderColor: theme.surface, borderWidth: 2 },
          ...(display.area === true ? { areaStyle: { color: series.color, opacity: 0.16 } } : {}),
          ...(stacked ? { stack: 'total' } : {}),
          connectNulls: false,
          label,
        };
      }
      return {
        type: 'bar' as const,
        name: series.name,
        data: seriesData(series.values, input.selected),
        ...(horizontal ? {} : { yAxisIndex: twoAxes ? series.axis : 0 }),
        ...(stacked ? { stack: 'total' } : {}),
        barMaxWidth: 40,
        barGap: '10%',
        itemStyle: {
          color: series.color,
          borderColor: theme.surface,
          borderWidth: stacked ? 1 : 0,
          // Rounded data end only (the end away from the baseline).
          borderRadius: stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
        },
        label,
      };
    }),
  };
}
