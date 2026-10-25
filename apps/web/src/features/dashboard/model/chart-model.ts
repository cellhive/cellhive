import { groupCell, groupKey } from './labels';

import type {
  MetricAggregation,
  WidgetDataColumn,
  WidgetDataDto,
  WidgetGroupValue,
} from '@cellhive/contracts';

/**
 * Widget data → a chart model (T811): categories along the dimension and
 * one series per metric, or per value of the series dimension. Pure: the
 * ECharts option (`chart-option.ts`) and the "View as table" fallback
 * (`DataTable`) are both built from it, so they always show the same
 * numbers. "Other" (`other` of CONTRACTS §28.3) is always the last category.
 */

/** The metric fields of a widget config used here. */
export interface MetricConfig {
  readonly id: string;
  readonly aggregation: MetricAggregation;
  readonly field: string | null;
  readonly label: string | null;
  readonly color: string | null;
  readonly chart?: 'bar' | 'line' | undefined;
  readonly axis?: 'left' | 'right' | undefined;
}

export interface ChartColors {
  /** Categorical palette (`--chart-0…7`), in its fixed order. */
  readonly palette: readonly string[];
  /** "Other" (`--chart-other`). */
  readonly other: string;
}

export interface ChartCategory {
  readonly key: string;
  readonly label: string;
  readonly cell: WidgetGroupValue;
  /** The "Other" category (groups beyond `limit`). */
  readonly other: boolean;
}

export interface ChartSeries {
  readonly key: string;
  readonly name: string;
  readonly color: string;
  /** One value per category (`null`: nothing to aggregate). */
  readonly values: readonly (number | null)[];
  readonly kind: 'bar' | 'line';
  /** Value axis: 0 left, 1 right (combo). */
  readonly axis: 0 | 1;
  /** Metric whose number format applies. */
  readonly metricId: string;
  /** (T813) The series group (series dimension): click-through narrows to it. */
  readonly cell?: WidgetGroupValue | undefined;
}

export interface ChartModel {
  readonly categories: readonly ChartCategory[];
  readonly series: readonly ChartSeries[];
  /** Colors of pie slices, one per category. */
  readonly sliceColors: readonly string[];
}

export interface BuildChartInput {
  readonly type: 'bar' | 'line' | 'combo' | 'pie';
  readonly metrics: readonly MetricConfig[];
  /** `display.colors`: color by metric id, series key or option id. */
  readonly displayColors?: Readonly<Record<string, string>> | undefined;
  readonly data: Pick<WidgetDataDto, 'columns' | 'rows' | 'other'>;
  readonly colors: ChartColors;
  /** Text of a group value (dimension or series). */
  readonly label: (cell: WidgetGroupValue, column: WidgetDataColumn | undefined) => string;
  /** "Other". */
  readonly otherLabel: string;
  /** Name of a metric (its label, else e.g. "Count"). */
  readonly metricName: (metric: MetricConfig) => string;
  /**
   * Palette slot of a select option (its color, mapped to the chart hue of
   * the same family), `undefined` when the value is not an option.
   */
  readonly optionSlot?: ((value: string) => number | undefined) | undefined;
}

const toNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function colorOf(
  input: BuildChartInput,
  keys: readonly (string | null)[],
  index: number,
  fallbackSlot?: number,
): string {
  for (const key of keys) {
    if (key === null) continue;
    const own = input.displayColors?.[key];
    if (own !== undefined) return own;
  }
  const palette = input.colors.palette;
  const slot = fallbackSlot ?? index;
  return palette[slot % palette.length] ?? input.colors.other;
}

function optionSlotOf(input: BuildChartInput, cell: WidgetGroupValue): number | undefined {
  return typeof cell.value === 'string' ? input.optionSlot?.(cell.value) : undefined;
}

export function buildChartModel(input: BuildChartInput): ChartModel {
  const { columns } = input.data;
  const dimensionIndex = columns.findIndex((column) => column.role === 'dimension');
  const seriesIndex = columns.findIndex((column) => column.role === 'series');
  const dimensionColumn = columns[dimensionIndex];
  const seriesColumn = seriesIndex === -1 ? undefined : columns[seriesIndex];
  const metricIndex = new Map(
    columns.flatMap((column, index) => (column.role === 'metric' ? [[column.key, index]] : [])),
  );
  const rows = input.data.rows;
  const otherRows = input.data.other?.rows ?? [];

  // Categories in row order (the server sorted them), "Other" last.
  const categories: ChartCategory[] = [];
  const categoryIndex = new Map<string, number>();
  for (const row of rows) {
    const cell = groupCell(row[dimensionIndex]);
    const key = groupKey(cell);
    if (categoryIndex.has(key)) continue;
    categoryIndex.set(key, categories.length);
    categories.push({ key, label: input.label(cell, dimensionColumn), cell, other: false });
  }
  const otherKey = '__other__';
  if (otherRows.length > 0) {
    categoryIndex.set(otherKey, categories.length);
    categories.push({
      key: otherKey,
      label: input.otherLabel,
      cell: { value: null, label: null },
      other: true,
    });
  }
  const indexOfRow = (row: readonly unknown[], other: boolean) =>
    other
      ? categories.length - 1
      : (categoryIndex.get(groupKey(groupCell(row[dimensionIndex]))) ?? -1);

  const series: ChartSeries[] = [];
  if (seriesColumn !== undefined) {
    // One metric split by the series dimension: a series per value, in order of appearance.
    const metric = input.metrics[0];
    const valueAt = metric === undefined ? undefined : metricIndex.get(metric.id);
    const bySeries = new Map<string, { cell: WidgetGroupValue; values: (number | null)[] }>();
    const visit = (row: readonly unknown[], other: boolean) => {
      const cell = groupCell(row[seriesIndex]);
      const key = groupKey(cell);
      let entry = bySeries.get(key);
      if (entry === undefined) {
        entry = { cell, values: categories.map(() => null) };
        bySeries.set(key, entry);
      }
      const at = indexOfRow(row, other);
      if (at >= 0 && valueAt !== undefined) entry.values[at] = toNumber(row[valueAt]);
    };
    rows.forEach((row) => {
      visit(row, false);
    });
    otherRows.forEach((row) => {
      visit(row, true);
    });
    let index = 0;
    for (const [key, entry] of bySeries) {
      series.push({
        key,
        name: input.label(entry.cell, seriesColumn),
        color: colorOf(
          input,
          [typeof entry.cell.value === 'string' ? entry.cell.value : null, key],
          index,
          optionSlotOf(input, entry.cell),
        ),
        values: entry.values,
        kind: input.type === 'line' ? 'line' : 'bar',
        axis: 0,
        metricId: metric?.id ?? '',
        cell: entry.cell,
      });
      index += 1;
    }
  } else {
    input.metrics.forEach((metric, index) => {
      const valueAt = metricIndex.get(metric.id);
      const values: (number | null)[] = categories.map(() => null);
      const fill = (row: readonly unknown[], other: boolean) => {
        const at = indexOfRow(row, other);
        if (at >= 0 && valueAt !== undefined) values[at] = toNumber(row[valueAt]);
      };
      rows.forEach((row) => {
        fill(row, false);
      });
      otherRows.forEach((row) => {
        fill(row, true);
      });
      const kind =
        input.type === 'line' || (input.type === 'combo' && metric.chart === 'line')
          ? 'line'
          : 'bar';
      series.push({
        key: metric.id,
        name: input.metricName(metric),
        color: metric.color ?? colorOf(input, [metric.id], index),
        values,
        kind,
        axis: input.type === 'combo' && metric.axis === 'right' ? 1 : 0,
        metricId: metric.id,
      });
    });
  }

  const sliceColors = categories.map((category, index) =>
    category.other
      ? input.colors.other
      : colorOf(
          input,
          [typeof category.cell.value === 'string' ? category.cell.value : null, category.key],
          index,
          optionSlotOf(input, category.cell),
        ),
  );
  return { categories, series, sliceColors };
}

/**
 * 100 % stacked bars (S7 decision #6: normalised on the client from the
 * aggregated numbers): each value as a share of its category's total of
 * absolute values, 0–100. A category whose total is 0 stays 0.
 */
export function toPercentStack(series: readonly ChartSeries[]): ChartSeries[] {
  const length = series[0]?.values.length ?? 0;
  const totals = Array.from({ length }, (_, index) =>
    series.reduce((sum, item) => sum + Math.abs(item.values[index] ?? 0), 0),
  );
  return series.map((item) => ({
    ...item,
    values: item.values.map((value, index) => {
      const total = totals[index] ?? 0;
      if (value === null) return null;
      return total === 0 ? 0 : (Math.abs(value) / total) * 100;
    }),
  }));
}

/**
 * Select option color (0–54, modulo the eight option hues of FRONTEND
 * §9.3: gray, sky, leaf, amber, pink, jade, orange, indigo) → the chart slot
 * of the same hue family (blue, orange, aqua, yellow, magenta, green,
 * violet, red); gray has no chart hue and takes the last slot (red, 7).
 */
const OPTION_TO_CHART_SLOT: readonly (number | undefined)[] = [undefined, 0, 5, 3, 4, 2, 1, 6];

export function chartSlotOfOptionColor(color: number | undefined, position: number): number {
  const option = (color ?? position) % OPTION_TO_CHART_SLOT.length;
  return OPTION_TO_CHART_SLOT[option] ?? 7;
}
