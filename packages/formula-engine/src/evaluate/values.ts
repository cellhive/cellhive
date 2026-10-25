import { isoDate, isoInstant, localText, startOfDay } from './dates.js';
import { Dec } from './decimal.js';

/**
 * Runtime values of the TS evaluator (T453), one per formula type
 * (SPEC §9.2): `null`; `number` → `Dec`; `text` → string; `boolean`;
 * `date` → `{ kind: 'date', day }`; `datetime` → `{ kind: 'datetime', ms }`;
 * `user`, `attachment`, `row<tbl>` → tagged objects; `list<T>` → array;
 * `table<tbl>` → `{ kind: 'table', rows }`.
 */

/** A record as the evaluator reads it: the formula's row, a linked record, a row of `[Table]`. */
export interface FormulaRecord {
  id: string;
  /** Title (primary field as text); compared with text as in Lark (SPEC §9.2). */
  title?: string | null;
  /** Cell values by field ID, in the `cell_format=json` shape of the records API (CONTRACTS §2). */
  fields: Readonly<Record<string, unknown>>;
}

/**
 * Sample data for links and `[Table]` (preview, tests). Synchronous: the
 * caller loads what the formula needs beforehand.
 */
export interface FormulaDataSource {
  /** Every record of a table, in table order (the order SQL reads it in). */
  table(tableId: string): readonly FormulaRecord[];
  /** One record; `null` when it is missing or not readable. */
  record(tableId: string, recordId: string): FormulaRecord | null;
}

export interface DateValue {
  readonly kind: 'date';
  /** Days since 1970-01-01. */
  readonly day: number;
  /**
   * Zone of a value read from a datetime field with its own `timezone`
   * (ADR-21); calendar operations on it use this zone instead of the
   * formula's. Lost by any function call (as in the SQL compiler).
   */
  readonly zone?: string;
}

export interface DateTimeValue {
  readonly kind: 'datetime';
  /** Epoch milliseconds. */
  readonly ms: number;
  /** See `DateValue.zone`. */
  readonly zone?: string;
}

export interface UserValue {
  readonly kind: 'user';
  readonly id: string;
}

export interface AttachmentValue {
  readonly kind: 'attachment';
  readonly value: Readonly<Record<string, unknown>>;
}

export interface RowValue {
  readonly kind: 'row';
  readonly tableId: string;
  readonly id: string;
  readonly title: string | null;
  /** Loaded lazily through the data source when only `{ id, title }` is known. */
  record: FormulaRecord | null | undefined;
}

export interface TableValue {
  readonly kind: 'table';
  readonly tableId: string;
  readonly rows: readonly RowValue[];
}

export type Value =
  | null
  | boolean
  | string
  | Dec
  | DateValue
  | DateTimeValue
  | UserValue
  | AttachmentValue
  | RowValue
  | TableValue
  | readonly Value[];

/** JSON result of `evaluate` (see `toJson`). */
export type FormulaJsonValue =
  | null
  | boolean
  | string
  | { id: string; title: string | null }
  | Readonly<Record<string, unknown>>
  | FormulaJsonValue[];

export const date = (day: number, zone?: string): DateValue =>
  zone === undefined ? { kind: 'date', day } : { kind: 'date', day, zone };
export const datetime = (ms: number, zone?: string): DateTimeValue =>
  zone === undefined ? { kind: 'datetime', ms } : { kind: 'datetime', ms, zone };

/** Zone of calendar operations on a value: its field's own zone, else the formula's. */
export function zoneOf(value: Value, timeZone: string): string {
  return (isDate(value) || isDateTime(value)) && value.zone !== undefined ? value.zone : timeZone;
}

/** The value without field zones (a function call's result, as in SQL). */
export function withoutZone(value: Value): Value {
  if (isDate(value)) return value.zone === undefined ? value : date(value.day);
  if (isDateTime(value)) return value.zone === undefined ? value : datetime(value.ms);
  if (Array.isArray(value)) {
    const items = value as readonly Value[];
    return items.some((item) => (isDate(item) || isDateTime(item)) && item.zone !== undefined)
      ? items.map(withoutZone)
      : items;
  }
  return value;
}

export function isDate(value: Value): value is DateValue {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'date';
}

export function isDateTime(value: Value): value is DateTimeValue {
  return (
    typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'datetime'
  );
}

export function isRow(value: Value): value is RowValue {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'row';
}

export function isUser(value: Value): value is UserValue {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'user';
}

export function isAttachment(value: Value): value is AttachmentValue {
  return (
    typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'attachment'
  );
}

export function isTable(value: Value): value is TableValue {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'table';
}

export function isList(value: Value): value is readonly Value[] {
  return Array.isArray(value);
}

/** `null` or an empty list: what SQL sees as `NULL` (`array_agg` of no row). */
export function isNull(value: Value): boolean {
  return value === null || (Array.isArray(value) && value.length === 0);
}

/** Empty for ISBLANK/IFBLANK/COUNTA: `null`, empty text, empty list. */
export function isBlank(value: Value): boolean {
  return isNull(value) || value === '';
}

/** Elements of a list, the records of a table, or the value itself. */
export function elements(value: Value): readonly Value[] {
  if (value === null) return [];
  if (Array.isArray(value)) return value as readonly Value[];
  if (isTable(value)) return value.rows;
  return [value];
}

export function rowTitle(row: RowValue): string | null {
  return row.title ?? row.record?.title ?? null;
}

/** Text of a value (`&`, CONCATENATE, text parameters). */
export function toText(value: Value, timeZone: string): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Dec) return value.toString();
  if (Array.isArray(value)) {
    const parts = (value as readonly Value[])
      .map((item) => toText(item, timeZone))
      .filter((item): item is string => item !== null);
    return parts.join(', ');
  }
  const tagged = value as Exclude<Value, null | boolean | string | Dec | readonly Value[]>;
  switch (tagged.kind) {
    case 'date':
      return isoDate(tagged.day);
    case 'datetime':
      return localText(tagged.ms, tagged.zone ?? timeZone);
    case 'user':
      return tagged.id;
    case 'attachment': {
      const name = tagged.value['name'];
      return typeof name === 'string' ? name : '';
    }
    case 'row':
      return rowTitle(tagged) ?? '';
    case 'table':
      return null;
  }
}

/** A number, from a number or (for untyped values) numeric text / a boolean. */
export function toDec(value: Value): Dec | null {
  if (value instanceof Dec) return value;
  if (typeof value === 'string') return Dec.parse(value);
  if (typeof value === 'boolean') return value ? Dec.ONE : Dec.ZERO;
  return null;
}

/** Instant of a date or datetime (a date is its local midnight in `timeZone`). */
export function toInstant(value: Value, timeZone: string): number | null {
  if (isDateTime(value)) return value.ms;
  if (isDate(value)) return startOfDay(value.day, value.zone ?? timeZone);
  return null;
}

/**
 * JSON form of a result: numbers as exact decimal text (`"1.5"`), dates
 * `YYYY-MM-DD`, datetimes `YYYY-MM-DDTHH:mm:ss.sssZ`, users their ID,
 * records `{ id, title }`, attachments as stored, lists as arrays — an
 * empty list is `null` (SQL `array_agg` of no row).
 */
export function toJson(value: Value): FormulaJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Dec) return value.toString();
  if (Array.isArray(value)) {
    const items = value as readonly Value[];
    return items.length === 0 ? null : items.map(toJson);
  }
  const tagged = value as Exclude<Value, null | boolean | string | Dec | readonly Value[]>;
  switch (tagged.kind) {
    case 'date':
      return isoDate(tagged.day);
    case 'datetime':
      return isoInstant(tagged.ms);
    case 'user':
      return tagged.id;
    case 'attachment':
      return tagged.value;
    case 'row':
      return { id: tagged.id, title: rowTitle(tagged) };
    case 'table':
      return tagged.rows.length === 0 ? null : tagged.rows.map(toJson);
  }
}
