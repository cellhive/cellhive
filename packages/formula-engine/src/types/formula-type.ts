/**
 * Formula type system (SPEC §9.2, T452).
 *
 * - Scalars: `text`, `number`, `boolean`, `date` (a calendar day),
 *   `datetime` (an instant).
 * - Single values that only come from fields: `user`, `attachment`, and
 *   `row<tbl>` — one record of a table (the element of a link cell, the
 *   `CurrentValue` of an iteration over a table, `FIRST([Link])`).
 * - `list<T>`: a list of one element type. A link cell is `list<row<tbl>>`
 *   ("list<record>"); a multi-value field read through a table or link is
 *   `list<list<T>>` and needs `LISTCOMBINE` before most functions.
 * - `table<tbl>`: every record of a table (`[Table]`, `[Table].FILTER(…)`),
 *   usable only as the range of FILTER/COUNTIF/SUMIF/MAP/SORTBY or with `.[Field]`.
 * - `null`: no value (`LIST()` has type `list<null>`); fits any type.
 * - `any`: unknown (a field the snapshot carries no type for); fits any type.
 *
 * Types are plain JSON so they can be stored with a computed field (`result_type`).
 */

export type ScalarKind = 'text' | 'number' | 'boolean' | 'date' | 'datetime';

export type FormulaType =
  | { kind: 'any' }
  | { kind: 'null' }
  | {
      kind: 'text';
      /**
       * Set on the value of `RECORD_ID()`: the ID of a record of that table.
       * Compared with a `row` of the same table it matches the record ID;
       * any other text compared with a row matches the record title
       * (primary field), as in Lark.
       */
      recordIdOf?: string;
    }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'datetime' }
  | { kind: 'user' }
  | { kind: 'attachment' }
  | { kind: 'row'; tableId: string }
  | { kind: 'list'; element: FormulaType }
  | { kind: 'table'; tableId: string };

export type FormulaTypeKind = FormulaType['kind'];

export const T = {
  any: { kind: 'any' },
  null: { kind: 'null' },
  text: { kind: 'text' },
  number: { kind: 'number' },
  boolean: { kind: 'boolean' },
  date: { kind: 'date' },
  datetime: { kind: 'datetime' },
  user: { kind: 'user' },
  attachment: { kind: 'attachment' },
} as const satisfies Record<string, FormulaType>;

export function listOf(element: FormulaType): FormulaType {
  return { kind: 'list', element };
}

export function rowOf(tableId: string): FormulaType {
  return { kind: 'row', tableId };
}

export function tableOf(tableId: string): FormulaType {
  return { kind: 'table', tableId };
}

const SCALARS: ReadonlySet<string> = new Set(['text', 'number', 'boolean', 'date', 'datetime']);

export function isScalar(type: FormulaType): boolean {
  return SCALARS.has(type.kind);
}

/** One value (not a list, not a table): scalars, `user`, `attachment`, `row`. */
export function isSingle(type: FormulaType): boolean {
  return (
    type.kind !== 'list' && type.kind !== 'table' && type.kind !== 'any' && type.kind !== 'null'
  );
}

/** `any` or `null`: fits wherever a type is expected. */
export function isOpen(type: FormulaType): boolean {
  return type.kind === 'any' || type.kind === 'null';
}

export function isDateLike(type: FormulaType): boolean {
  return type.kind === 'date' || type.kind === 'datetime';
}

/** `list<list<…>>`. */
export function isNestedList(type: FormulaType): boolean {
  return type.kind === 'list' && type.element.kind === 'list';
}

/** `list<T>` with a non-list `T` (or `list<any>`/`list<null>`). */
export function isFlatList(type: FormulaType): boolean {
  return type.kind === 'list' && type.element.kind !== 'list' && type.element.kind !== 'table';
}

/** Records a value stands for: `table<t>`, `list<row<t>>` or `row<t>`; `null` otherwise. */
export function rowsTable(type: FormulaType): string | null {
  if (type.kind === 'table' || type.kind === 'row') return type.tableId;
  if (type.kind === 'list' && type.element.kind === 'row') return type.element.tableId;
  return null;
}

export function sameType(a: FormulaType, b: FormulaType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'row':
    case 'table':
      return a.tableId === (b as { tableId: string }).tableId;
    case 'list':
      return sameType(a.element, (b as { element: FormulaType }).element);
    default:
      return true;
  }
}

/**
 * The one type both values fit (IF branches, list elements): `null`/`any`
 * give way to the other side, `date` widens to `datetime`, `RECORD_ID()`
 * text widens to plain text. `null` when there is none.
 */
export function unify(a: FormulaType, b: FormulaType): FormulaType | null {
  if (isOpen(a)) return b.kind === 'null' ? a : b;
  if (isOpen(b)) return a;
  if (a.kind === 'text' && b.kind === 'text') {
    return a.recordIdOf !== undefined && a.recordIdOf === b.recordIdOf ? a : T.text;
  }
  if (isDateLike(a) && isDateLike(b)) return a.kind === b.kind ? a : T.datetime;
  if (a.kind === 'list' && b.kind === 'list') {
    const element = unify(a.element, b.element);
    return element === null ? null : listOf(element);
  }
  return sameType(a, b) ? a : null;
}

/**
 * Whether two single values can be compared with `=`/`!=` or found in a
 * list (CONTAIN): same scalar kind, `date` with `datetime`, a `user` with a
 * user or a text (user ID), a `row` with a row of the same table (record ID)
 * or a text (record title; the record ID for `RECORD_ID()` of that table).
 */
export function singlesComparable(a: FormulaType, b: FormulaType): boolean {
  if (isOpen(a) || isOpen(b)) return true;
  if (isDateLike(a) && isDateLike(b)) return true;
  if (a.kind === 'row' && b.kind === 'row') return a.tableId === b.tableId;
  if ((a.kind === 'row' || a.kind === 'user') && b.kind === 'text') return true;
  if ((b.kind === 'row' || b.kind === 'user') && a.kind === 'text') return true;
  if (a.kind === 'list' || b.kind === 'list' || a.kind === 'table' || b.kind === 'table') {
    return false;
  }
  return a.kind === b.kind && a.kind !== 'attachment';
}

/** `=`/`!=`: two comparable single values, or two lists of comparable elements. */
export function equalityComparable(a: FormulaType, b: FormulaType): boolean {
  if (isOpen(a) || isOpen(b)) return true;
  if (a.kind === 'list' && b.kind === 'list') return equalityComparable(a.element, b.element);
  return singlesComparable(a, b);
}

/** `<`, `<=`, `>`, `>=`: numbers, texts, or dates/datetimes. */
export function orderComparable(a: FormulaType, b: FormulaType): boolean {
  if (isOpen(a) && isOpen(b)) return true;
  if (isOpen(a)) return isOrderable(b);
  if (isOpen(b)) return isOrderable(a);
  if (isDateLike(a) && isDateLike(b)) return true;
  return a.kind === b.kind && (a.kind === 'number' || a.kind === 'text');
}

/** A single value `<`/`>`/SORT can order. */
export function isOrderable(type: FormulaType): boolean {
  return isOpen(type) || type.kind === 'number' || type.kind === 'text' || isDateLike(type);
}

/** Element type of a list (the type itself for a single value). */
export function elementOf(type: FormulaType): FormulaType {
  return type.kind === 'list' ? type.element : type;
}

/** Human-readable type: `number`, `list<text>`, `row<tbl_…>`, `table<tbl_…>`. */
export function formatType(type: FormulaType): string {
  switch (type.kind) {
    case 'list':
      return `list<${formatType(type.element)}>`;
    case 'row':
    case 'table':
      return `${type.kind}<${type.tableId}>`;
    default:
      return type.kind;
  }
}
