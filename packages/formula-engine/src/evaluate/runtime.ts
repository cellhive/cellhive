import { fieldValueType } from '../types/field-type.js';
import { elementOf, type FormulaType } from '../types/formula-type.js';

import { foldCase } from './case-fold.js';
import { localDay, parseDateText, parseTodate, startOfDay } from './dates.js';
import { Dec } from './decimal.js';
import {
  date,
  datetime,
  elements,
  isDate,
  isDateTime,
  isRow,
  isTable,
  isUser,
  rowTitle,
  toDec,
  toInstant,
  toText,
  type FormulaDataSource,
  type FormulaRecord,
  type RowValue,
  type TableValue,
  type Value,
} from './values.js';

import type { Call, Expr } from '../ast.js';
import type { SchemaSnapshot, SnapshotField } from '../resolve.js';

/** Converts a raw cell value (API JSON shape) to a runtime value. */
type Reader = (raw: unknown, runtime: Runtime) => Value;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A record of a link cell (`{ id, title }` or an ID); without a title, the data source gives it. */
function readRow(raw: unknown, tableId: string, runtime: Runtime): RowValue | null {
  let row: RowValue;
  if (typeof raw === 'string') {
    row = { kind: 'row', tableId, id: raw, title: null, record: undefined };
  } else if (isObject(raw) && typeof raw['id'] === 'string') {
    const title = raw['title'];
    row = {
      kind: 'row',
      tableId,
      id: raw['id'],
      title: typeof title === 'string' ? title : null,
      record: undefined,
    };
  } else {
    return null;
  }
  if (row.title === null) runtime.recordOf(row);
  return row;
}

/** A raw value read as `type` (untyped values keep their JSON kind). */
export function readAs(
  raw: unknown,
  type: FormulaType,
  runtime: Runtime,
  zone: string = runtime.timeZone,
): Value {
  if (raw === null || raw === undefined) return null;
  switch (type.kind) {
    case 'text':
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'number' || typeof raw === 'boolean') {
        return toText(readAs(raw, { kind: 'any' }, runtime), runtime.timeZone);
      }
      return null;
    case 'number':
      return Dec.parse(raw);
    case 'boolean':
      return typeof raw === 'boolean' ? raw : null;
    case 'date': {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        return date(localDay(raw, zone));
      }
      if (typeof raw !== 'string') return null;
      const parsed = parseDateText(raw, zone);
      if (parsed === null) return null;
      return parsed.kind === 'date' ? date(parsed.day) : date(localDay(parsed.ms, zone));
    }
    case 'datetime': {
      if (typeof raw === 'number' && Number.isFinite(raw)) return datetime(raw);
      if (typeof raw !== 'string') return null;
      const parsed = parseDateText(raw, zone);
      if (parsed === null) return null;
      return parsed.kind === 'datetime'
        ? datetime(parsed.ms)
        : datetime(startOfDay(parsed.day, zone));
    }
    case 'user':
      if (typeof raw === 'string') return { kind: 'user', id: raw };
      if (isObject(raw) && typeof raw['id'] === 'string') return { kind: 'user', id: raw['id'] };
      return null;
    case 'attachment':
      return isObject(raw) ? { kind: 'attachment', value: raw } : null;
    case 'row':
      return readRow(raw, type.tableId, runtime);
    case 'list': {
      const items = Array.isArray(raw) ? (raw as readonly unknown[]) : [raw];
      return items.map((item) => readAs(item, type.element, runtime));
    }
    case 'table':
      return null;
    case 'any':
    case 'null':
      if (typeof raw === 'number' || typeof raw === 'bigint') return Dec.parse(raw);
      if (typeof raw === 'string' || typeof raw === 'boolean') return raw;
      if (Array.isArray(raw)) {
        return (raw as readonly unknown[]).map((item) => readAs(item, type, runtime));
      }
      return null;
  }
}

/** Reader of a field: select IDs become option names, an empty checkbox is `false`. */
function fieldReader(field: SnapshotField): Reader {
  const type = fieldValueType(field);
  if (field.type === 'checkbox') return (raw) => raw === true;
  if (field.type === 'select') {
    const names = new Map<string, string>();
    const options = field.options?.['options'];
    if (Array.isArray(options)) {
      for (const option of options as readonly unknown[]) {
        if (
          isObject(option) &&
          typeof option['id'] === 'string' &&
          typeof option['name'] === 'string'
        ) {
          names.set(option['id'], option['name']);
        }
      }
    }
    const name = (raw: unknown): Value =>
      typeof raw === 'string' ? (names.get(raw) ?? raw) : null;
    if (type.kind === 'list') {
      return (raw) => {
        if (raw === null || raw === undefined) return null;
        const items = Array.isArray(raw) ? (raw as readonly unknown[]) : [raw];
        return items.map(name).filter((item) => item !== null);
      };
    }
    return name;
  }
  const zone = field.options?.['timezone'];
  if (
    typeof zone === 'string' &&
    zone !== '' &&
    (field.type === 'datetime' || field.type === 'created_at' || field.type === 'updated_at')
  ) {
    // ADR-21: a datetime field with its own zone is read (and used) in that zone.
    return (raw, runtime) => {
      const value = readAs(raw, type, runtime, zone);
      if (isDate(value)) return date(value.day, zone);
      if (isDateTime(value)) return datetime(value.ms, zone);
      return value;
    };
  }
  return (raw, runtime) => readAs(raw, type, runtime);
}

interface SnapshotIndex {
  fields: Map<string, SnapshotField>;
  readers: Map<string, Reader>;
}

const INDEXES = new WeakMap<SchemaSnapshot, SnapshotIndex>();

function indexOf(snapshot: SchemaSnapshot): SnapshotIndex {
  let index = INDEXES.get(snapshot);
  if (index === undefined) {
    const fields = new Map<string, SnapshotField>();
    for (const table of snapshot.tables)
      for (const field of table.fields) fields.set(field.id, field);
    index = { fields, readers: new Map() };
    INDEXES.set(snapshot, index);
  }
  return index;
}

const COLLATORS = new Map<string, Intl.Collator>();

function collator(locale: string): Intl.Collator {
  let found = COLLATORS.get(locale);
  if (found === undefined) {
    found = new Intl.Collator(locale);
    COLLATORS.set(locale, found);
  }
  return found;
}

export interface RuntimeOptions {
  snapshot: SchemaSnapshot;
  row: FormulaRecord;
  resolve: FormulaDataSource | null;
  timeZone: string;
  now: number;
  locale: string;
  types: ReadonlyMap<Expr, FormulaType>;
}

/** What function implementations see of one evaluation: data, time zone, comparisons. */
export class Runtime {
  readonly timeZone: string;
  readonly now: number;
  readonly row: FormulaRecord;
  readonly tableId: string;
  readonly types: ReadonlyMap<Expr, FormulaType>;
  private readonly index: SnapshotIndex;
  private readonly resolve: FormulaDataSource | null;
  private readonly collator: Intl.Collator;
  private readonly tables = new Map<string, TableValue>();
  /** Cells of the formula's row, read once per evaluation. */
  private readonly own = new Map<string, Value>();

  constructor(options: RuntimeOptions) {
    this.timeZone = options.timeZone;
    this.now = options.now;
    this.row = options.row;
    this.tableId = options.snapshot.tableId;
    this.types = options.types;
    this.index = indexOf(options.snapshot);
    this.resolve = options.resolve;
    this.collator = collator(options.locale);
  }

  typeOf(node: Expr): FormulaType {
    return this.types.get(node) ?? { kind: 'any' };
  }

  fieldType(fieldId: string): FormulaType {
    const field = this.index.fields.get(fieldId);
    return field === undefined ? { kind: 'any' } : fieldValueType(field);
  }

  private reader(fieldId: string): Reader {
    let reader = this.index.readers.get(fieldId);
    if (reader === undefined) {
      const field = this.index.fields.get(fieldId);
      reader =
        field === undefined
          ? (raw, runtime) => readAs(raw, { kind: 'any' }, runtime)
          : fieldReader(field);
      this.index.readers.set(fieldId, reader);
    }
    return reader;
  }

  /** A field of a record. */
  read(record: FormulaRecord | null, fieldId: string): Value {
    if (record === null) return null;
    if (record !== this.row) return this.reader(fieldId)(record.fields[fieldId], this);
    let value = this.own.get(fieldId);
    if (value === undefined) {
      value = this.reader(fieldId)(record.fields[fieldId], this);
      this.own.set(fieldId, value);
    }
    return value;
  }

  /** The record behind a row (loaded through the data source once). */
  recordOf(row: RowValue): FormulaRecord | null {
    if (row.record === undefined) row.record = this.resolve?.record(row.tableId, row.id) ?? null;
    return row.record;
  }

  /** `row.[Field]`. */
  field(row: RowValue, fieldId: string): Value {
    return this.read(this.recordOf(row), fieldId);
  }

  /** `rows.[Field]`: one value per record, the records of a link field flattened. */
  column(rows: readonly Value[], fieldId: string): Value[] {
    const flatten =
      this.fieldType(fieldId).kind === 'list' && elementOf(this.fieldType(fieldId)).kind === 'row';
    const out: Value[] = [];
    for (const row of rows) {
      if (!isRow(row)) continue;
      const value = this.field(row, fieldId);
      if (flatten) {
        if (Array.isArray(value)) out.push(...(value as readonly Value[]));
      } else {
        out.push(value);
      }
    }
    return out;
  }

  /** `[Table]`: every record, in table order. */
  table(tableId: string): TableValue {
    let table = this.tables.get(tableId);
    if (table === undefined) {
      const records = this.resolve?.table(tableId) ?? [];
      table = {
        kind: 'table',
        tableId,
        rows: records.map((record) => ({
          kind: 'row',
          tableId,
          id: record.id,
          title: record.title ?? null,
          record,
        })),
      };
      this.tables.set(tableId, table);
    }
    return table;
  }

  text(value: Value): string | null {
    return toText(value, this.timeZone);
  }

  /** Local day of a date or datetime (in its field's zone, else the formula's). */
  day(value: Value): number | null {
    if (isDate(value)) return value.day;
    if (isDateTime(value)) return localDay(value.ms, value.zone ?? this.timeZone);
    if (typeof value === 'string') {
      // Text at a date parameter (M4): the same rule as TODATE (`fx.todate`).
      const instant = parseTodate(value, this.timeZone);
      return instant === null ? null : localDay(instant, this.timeZone);
    }
    return null;
  }

  instant(value: Value): number | null {
    return toInstant(value, this.timeZone);
  }

  /** Text order: the collation, then code points (a deterministic ICU collation). */
  compareText(a: string, b: string): -1 | 0 | 1 {
    const result = this.collator.compare(a, b);
    if (result !== 0) return result < 0 ? -1 : 1;
    return a === b ? 0 : a < b ? -1 : 1;
  }

  /**
   * Order of two single values (`<`, SORT, MAX): numbers, texts, dates
   * (a date against a datetime at its local midnight), booleans.
   * `null` when either is empty or they do not compare.
   */
  order(a: Value, b: Value): -1 | 0 | 1 | null {
    if (a === null || b === null) return null;
    if (a instanceof Dec && b instanceof Dec) return a.cmp(b);
    if (typeof a === 'string' && typeof b === 'string') return this.compareText(a, b);
    if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
    if (isDate(a) && isDate(b)) return a.day === b.day ? 0 : a.day < b.day ? -1 : 1;
    const left = this.instant(a);
    const right = this.instant(b);
    if (left === null || right === null) {
      const x = toDec(a);
      const y = toDec(b);
      return x === null || y === null ? null : x.cmp(y);
    }
    return left === right ? 0 : left < right ? -1 : 1;
  }

  /**
   * `=` (SPEC §9.2, §9.4), never empty: a list (or empty list) equals a list
   * element by element in order (two empty elements are equal); a text
   * equals a text with empty text and empty value alike; other values are
   * equal when both are empty or both are the same value. A record equals a
   * record with its ID, a text with its title — or its ID when the text is
   * `RECORD_ID()` of that table (static types); a user equals a text with
   * its ID; a date equals a datetime at its local midnight.
   */
  equal(
    a: Value,
    b: Value,
    typeA: FormulaType | undefined,
    typeB: FormulaType | undefined,
  ): boolean {
    const left = isTable(a) ? a.rows : a;
    const right = isTable(b) ? b.rows : b;
    if (
      Array.isArray(left) ||
      Array.isArray(right) ||
      typeA?.kind === 'list' ||
      typeB?.kind === 'list'
    ) {
      const x = elements(left);
      const y = elements(right);
      const elementA = typeA === undefined ? undefined : elementOf(typeA);
      const elementB = typeB === undefined ? undefined : elementOf(typeB);
      return (
        x.length === y.length &&
        x.every((item, i) => this.same(item, y[i] ?? null, elementA, elementB))
      );
    }
    if (isTextLike(left, typeA) || isTextLike(right, typeB)) {
      return this.same(left === '' ? null : left, right === '' ? null : right, typeA, typeB);
    }
    return this.same(left, right, typeA, typeB);
  }

  /**
   * Two single values: equal when both empty or the same value (list
   * elements, CONTAIN). `fold`: texts (and record titles) compare after
   * `foldCase` (CONTAIN*, `containFoldsCase`).
   */
  private same(
    a: Value,
    b: Value,
    typeA: FormulaType | undefined,
    typeB: FormulaType | undefined,
    fold = false,
  ): boolean {
    if (a === null || b === null) return a === b;
    if (a instanceof Dec || b instanceof Dec) {
      return a instanceof Dec && b instanceof Dec && a.eq(b);
    }
    if (typeof a === 'string' && typeof b === 'string') {
      return fold ? foldCase(a) === foldCase(b) : a === b;
    }
    if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
    if (isRow(a) && isRow(b)) return a.tableId === b.tableId && a.id === b.id;
    if (isRow(a) && typeof b === 'string') return rowMatchesText(a, b, typeB, fold);
    if (isRow(b) && typeof a === 'string') return rowMatchesText(b, a, typeA, fold);
    if (isUser(a) && isUser(b)) return a.id === b.id;
    if (isUser(a) && typeof b === 'string') return a.id === b;
    if (isUser(b) && typeof a === 'string') return b.id === a;
    if (isDate(a) && isDate(b) && a.zone === b.zone) return a.day === b.day;
    const left = this.instant(a);
    const right = this.instant(b);
    return left !== null && left === right;
  }

  /**
   * Whether `item` is one of `range`'s elements (CONTAIN, as SQL array
   * overlap): empty elements never match; texts compare case-insensitively
   * when `fold` (`containFoldsCase` of the call, SPEC §9.4).
   */
  member(
    item: Value,
    range: readonly Value[],
    typeItem: FormulaType | undefined,
    typeRange: FormulaType | undefined,
    fold = false,
  ): boolean {
    if (item === null) return false;
    return range.some(
      (candidate) => candidate !== null && this.same(candidate, item, typeRange, typeItem, fold),
    );
  }
}

/** A text or user value (or an empty one typed so): `=` treats empty text as empty. */
function isTextLike(value: Value, type: FormulaType | undefined): boolean {
  if (typeof value === 'string' || isUser(value)) return true;
  return value === null && (type?.kind === 'text' || type?.kind === 'user');
}

function rowMatchesText(
  row: RowValue,
  text: string,
  textType: FormulaType | undefined,
  fold: boolean,
): boolean {
  if (textType?.kind === 'text' && textType.recordIdOf === row.tableId) return row.id === text;
  const title = rowTitle(row) ?? '';
  return fold ? foldCase(title) === foldCase(text) : title === text;
}

/** A function's view of its call: lazily evaluated arguments, iteration, the runtime. */
export interface Args {
  readonly call: Call;
  readonly count: number;
  readonly rt: Runtime;
  node(index: number): Expr;
  /** Static type of argument `index` (from the typecheck). */
  type(index: number): FormulaType;
  /** Value of argument `index` (evaluated once). */
  value(index: number): Value;
  /** Value of argument `index` with `CurrentValue` bound to `current`. */
  with(index: number, current: Value): Value;
  /** Any expression, in the scope of the call (ISERROR). */
  evaluate(node: Expr): Value;
}

export type FunctionImpl = (args: Args) => Value;
