import type { ChartModel } from './chart-model';
import type { NumberFormatter } from './format';

export interface ModelTable {
  readonly columns: readonly { key: string; label: string; numeric: boolean }[];
  readonly rows: readonly (readonly string[])[];
  /** Row of "Other", if any. */
  readonly otherRow: number | null;
}

/**
 * The numbers of a chart model as a table (T811: "View as table", pivot
 * table widget): one row per category ("Other" last), one column per
 * series, each value in its metric's format, `–` when there is none.
 */
export function modelTable(
  model: ChartModel,
  dimensionLabel: string,
  format: (metricId: string) => NumberFormatter,
): ModelTable {
  const columns = [
    { key: '__dimension__', label: dimensionLabel, numeric: false },
    ...model.series.map((series) => ({ key: series.key, label: series.name, numeric: true })),
  ];
  const rows = model.categories.map((category, index) => [
    category.label,
    ...model.series.map((series) => {
      const value = series.values[index];
      return value === null || value === undefined ? '–' : format(series.metricId)(value);
    }),
  ]);
  const otherRow = model.categories.findIndex((category) => category.other);
  return { columns, rows, otherRow: otherRow === -1 ? null : otherRow };
}

/**
 * A short text alternative of a chart: its kind and title, the number of
 * groups, then the first `limit` groups with their values ("A: 12; B: 7").
 */
export function chartSummary(
  table: ModelTable,
  heading: string,
  limit = 10,
): { heading: string; items: string } {
  const items = table.rows
    .slice(0, limit)
    .map((row) => `${row[0] ?? ''}: ${row.slice(1).join(', ')}`)
    .join('; ');
  return { heading, items };
}
