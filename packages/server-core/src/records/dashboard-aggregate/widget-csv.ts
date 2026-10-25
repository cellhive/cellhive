import { CSV_LINE_BREAK, csvLine, UTF8_BOM } from '../../export/csv.js';

import type { WidgetAggregateResult } from './aggregate.js';
import type { MetricAggregation, WidgetDataColumn } from '@cellhive/contracts';

/**
 * The CSV of a widget (BACKLOG T808, CONTRACTS §28.6, "Quyết định S7" #12):
 * the aggregate table the viewer sees — one line per group (and series), the
 * "Other" lines last — never raw records. RFC 4180, UTF-8 with BOM, CRLF and
 * the CSV-injection guard of every export (`csvCell`, C§18). Pure.
 */

/** How a column of the result is titled. */
export interface WidgetCsvColumn {
  /** Field name (dimension, series, metric field), when the column has one. */
  readonly fieldName: string | null;
  /** Saved label of a metric (`null`: built from the aggregation and the field). */
  readonly label: string | null;
}

const TEXTS = {
  en: {
    count: 'Count',
    count_distinct: 'Distinct {f}',
    sum: 'Sum of {f}',
    avg: 'Average of {f}',
    min: 'Min of {f}',
    max: 'Max of {f}',
    other: 'Other',
    empty: '(Empty)',
    noAccess: '(No access)',
  },
  vi: {
    count: 'Số lượng',
    count_distinct: 'Số {f} khác nhau',
    sum: 'Tổng {f}',
    avg: 'Trung bình {f}',
    min: 'Nhỏ nhất {f}',
    max: 'Lớn nhất {f}',
    other: 'Khác',
    empty: '(Trống)',
    noAccess: '(Không có quyền)',
  },
} as const satisfies Record<
  string,
  Record<MetricAggregation | 'other' | 'empty' | 'noAccess', string>
>;

const RECORD_ID = /^rec_[0-9A-Za-z]{16}$/u;

/**
 * A group of linked records whose title the reader cannot read (`label:
 * null`, `value` the record id): the id never goes in the file — through a
 * share link the data route already hides it (T409), and the file must not
 * give it back (QA S7, T819).
 */
function hiddenRecordGroup(column: WidgetDataColumn | undefined, cell: unknown): boolean {
  if (column === undefined || (column.role !== 'dimension' && column.role !== 'series')) {
    return false;
  }
  if (typeof cell !== 'object' || cell === null || !('value' in cell)) return false;
  const { value, label } = cell as { value: unknown; label: unknown };
  if (label !== null && label !== undefined && label !== '') return false;
  return (
    typeof value === 'string' &&
    RECORD_ID.test(value) &&
    (column.field_type === 'link' ||
      column.field_type === 'lookup' ||
      column.field_type === 'formula')
  );
}

/** A cell of the result as CSV text (`{ value, label }` group cells by their label). */
function cellText(cell: unknown, empty: string): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'object' && 'value' in cell) {
    const { value, label } = cell as { value: unknown; label: unknown };
    if (typeof label === 'string' && label !== '') return label;
    if (value === null || value === undefined) return empty;
    return cellText(value, empty);
  }
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  return JSON.stringify(cell);
}

/**
 * The CSV text of `result` (`ok` or `empty`) and the number of data lines.
 * `columns[i]` titles `result.columns[i]`; `locale` picks the default
 * metric titles and the "Other" / "(Empty)" labels (English unless `vi`).
 */
export function widgetCsv(
  result: Pick<WidgetAggregateResult, 'columns' | 'rows'> & {
    readonly other?: WidgetAggregateResult['other'] | undefined;
  },
  columns: readonly WidgetCsvColumn[],
  locale: string,
): { readonly text: string; readonly rowCount: number } {
  const texts = locale.toLowerCase().startsWith('vi') ? TEXTS.vi : TEXTS.en;
  const headers = result.columns.map((column, index) => {
    const meta = columns[index];
    if (column.role !== 'metric') return meta?.fieldName ?? column.key;
    if (meta?.label !== null && meta?.label !== undefined && meta.label !== '') return meta.label;
    const aggregation = column.aggregation ?? 'count';
    return texts[aggregation].replace('{f}', meta?.fieldName ?? '').trim();
  });
  const lines = [csvLine(headers)];
  const text = (cell: unknown, index: number) =>
    hiddenRecordGroup(result.columns[index], cell) ? texts.noAccess : cellText(cell, texts.empty);
  for (const row of result.rows) lines.push(csvLine(row.map(text)));
  const dimension = result.columns.findIndex((column) => column.role === 'dimension');
  for (const row of result.other?.rows ?? []) {
    lines.push(
      csvLine(row.map((cell, index) => (index === dimension ? texts.other : text(cell, index)))),
    );
  }
  return {
    text: `${UTF8_BOM}${lines.join(CSV_LINE_BREAK)}${CSV_LINE_BREAK}`,
    rowCount: lines.length - 1,
  };
}
