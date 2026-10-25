import type { DateBucket, WidgetDataColumn, WidgetGroupValue } from '@cellhive/contracts';

/** Translated words a group label may need. */
export interface GroupTexts {
  /** The empty group, "(Empty)". */
  readonly empty: string;
  /** "Other" (groups folded beyond `limit`). */
  readonly other: string;
  readonly checked: string;
  readonly unchecked: string;
  /** A linked record the viewer cannot read. */
  readonly noAccess: string;
  /** A member who is not known any more. */
  readonly unknownUser: string;
  /** `{{date}}` → "Week of {{date}}". */
  readonly weekOf: (date: string) => string;
  /** `(quarter, year)` → "Q1 2026". */
  readonly quarter: (quarter: number, year: number) => string;
}

/** Reads a group cell of `rows` (`{ value, label }`), tolerating anything else. */
export function groupCell(cell: unknown): WidgetGroupValue {
  if (typeof cell === 'object' && cell !== null && 'value' in cell) {
    const { value, label } = cell as { value: unknown; label?: unknown };
    return {
      value:
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? value
          : null,
      label: typeof label === 'string' ? label : null,
    };
  }
  return { value: null, label: null };
}

/** Stable key of a group value (`null` → the empty group). */
export function groupKey(cell: WidgetGroupValue): string {
  return cell.value === null ? '∅' : `${typeof cell.value}:${String(cell.value)}`;
}

const dateCache = new Map<string, Intl.DateTimeFormat>();
function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dateCache.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    dateCache.set(key, format);
  }
  return format;
}

/**
 * The first day of a date bucket (`YYYY-MM-DD`, CONTRACTS §28.3) as text:
 * day → medium date, week → "Week of …", month → "Jan 2026", quarter →
 * "Q1 2026", year → "2026". Dates are calendar days (no time zone shift).
 */
export function bucketLabel(
  value: string,
  bucket: DateBucket | null,
  locale: string,
  texts: Pick<GroupTexts, 'weekOf' | 'quarter'>,
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (match === null) return value;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  switch (bucket) {
    case 'year':
      return String(date.getUTCFullYear());
    case 'quarter':
      return texts.quarter(Math.floor(date.getUTCMonth() / 3) + 1, date.getUTCFullYear());
    case 'month':
      return dateFormat(locale, { month: 'short', year: 'numeric' }).format(date);
    case 'week':
      return texts.weekOf(dateFormat(locale, { dateStyle: 'medium' }).format(date));
    default:
      return dateFormat(locale, { dateStyle: 'medium' }).format(date);
  }
}

/**
 * Text of a dimension or series value: the empty group, the server's label
 * (option, member, linked record title), checkbox words, date buckets,
 * number ranges (`bucket_width`), else the value itself.
 */
export function groupLabel(
  cell: WidgetGroupValue,
  column: Pick<WidgetDataColumn, 'field_type' | 'date_bucket' | 'bucket_width'> | undefined,
  locale: string,
  texts: GroupTexts,
  formatNumber: (value: number) => string,
): string {
  const { value, label } = cell;
  if (value === null) return texts.empty;
  if (label !== null && label !== '') return label;
  const type = column?.field_type ?? null;
  if (typeof value === 'boolean') return value ? texts.checked : texts.unchecked;
  if (type === 'link') return texts.noAccess;
  if (type === 'user' || type === 'created_by' || type === 'updated_by') return texts.unknownUser;
  if (typeof value === 'number') {
    const width = column?.bucket_width ?? null;
    return width === null
      ? formatNumber(value)
      : `${formatNumber(value)} – ${formatNumber(value + width)}`;
  }
  if (column?.date_bucket !== null && column?.date_bucket !== undefined) {
    return bucketLabel(value, column.date_bucket, locale, texts);
  }
  return value;
}
