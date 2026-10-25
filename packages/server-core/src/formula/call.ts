import {
  containFoldsCase,
  T,
  type Call,
  type Expr,
  type FormulaType,
} from '@cellhive/formula-engine';
import { sql } from 'kysely';

import { FormulaCompileError } from './errors.js';
import {
  emptyOf,
  nullOf,
  numberParam,
  textParam,
  truthy,
  type Compiled,
  type Sql,
} from './values.js';

import type { FormulaCompiler } from './compiler.js';

/** A function call being compiled: arguments compile on demand (iterations scope `CurrentValue`). */
export interface SqlCall {
  readonly node: Call;
  /** Result type of the call (typecheck). */
  readonly type: FormulaType;
  readonly compiler: FormulaCompiler;
  readonly count: number;
  arg(index: number): Compiled;
}

/** SQL implementation of one catalogue function (`sql/<name>.ts`, SPEC §9.3). */
export type SqlFunction = (call: SqlCall) => Sql;

export const has = (call: SqlCall, index: number): boolean => index < call.count;

/** Argument `index` as `type` (NULL-typed values typed, dates widened). */
export const as = (call: SqlCall, index: number, type: FormulaType): Sql =>
  call.compiler.as(call.arg(index), type);

export const num = (call: SqlCall, index: number): Sql => as(call, index, T.number);

/** Optional number argument with its default (a bound parameter). */
export const numOr = (call: SqlCall, index: number, fallback: string): Sql =>
  has(call, index) ? num(call, index) : numberParam(fallback);

export const txt = (call: SqlCall, index: number): Sql => call.compiler.toText(call.arg(index));

export const txtOr = (call: SqlCall, index: number, fallback: string): Sql =>
  has(call, index) ? txt(call, index) : textParam(fallback);

/** A condition: an empty boolean counts as FALSE. */
export const bool = (call: SqlCall, index: number): Sql => truthy(as(call, index, T.boolean));

export function argsFrom(call: SqlCall, from: number): Compiled[] {
  const out: Compiled[] = [];
  for (let index = from; index < call.count; index += 1) out.push(call.arg(index));
  return out;
}

/** Arguments `from…` (numbers and lists of numbers) as one `numeric[]`. */
export const numbers = (call: SqlCall, from = 0): Sql =>
  call.compiler.combine(argsFrom(call, from), T.number);

/** Element type of a list result (`list<null>` → text). */
export function elementOfType(type: FormulaType): FormulaType {
  if (type.kind !== 'list') return type;
  return type.element.kind === 'null' || type.element.kind === 'any' ? T.text : type.element;
}

/** Argument `index`, a list of plain values (not records: those are T455's). */
export function valueList(call: SqlCall, index: number): Compiled {
  const value = call.arg(index);
  if (value.type.kind === 'table' || value.type.kind === 'row') {
    return call.compiler.crossTable(`${call.node.name} over records`);
  }
  if (value.type.kind !== 'list') {
    throw new FormulaCompileError('UNSUPPORTED_TYPE', `${call.node.name} expects a list.`);
  }
  if (value.type.element.kind === 'row') {
    return call.compiler.crossTable(`${call.node.name} over records`);
  }
  return value;
}

/** Element of a value list as `CurrentValue` (`cv.v` of the iteration's `unnest`). */
export function currentOf(list: Compiled): Compiled {
  return { sql: sql`cv.v`, type: list.type.kind === 'list' ? list.type.element : list.type };
}

/** Compiles argument `index` with `CurrentValue` bound to the elements of `list`. */
export function inIteration(call: SqlCall, list: Compiled, index: number): Compiled {
  const node = call.node.args[index] as Expr;
  return call.compiler.withCurrent(currentOf(list), () => call.compiler.compile(node));
}

/** A date argument (or list of them) as `date[]` of calendar days in its zone. */
export function holidays(call: SqlCall, index: number): Sql {
  if (!has(call, index)) return nullOf({ kind: 'list', element: T.date });
  const value = call.arg(index);
  const element = value.type.kind === 'list' ? value.type.element : value.type;
  if (element.kind === 'datetime') {
    const list = call.compiler.asArray(value, T.datetime);
    return sql`ARRAY(SELECT fx.local_date(u.v, ${call.compiler.tz(value)}) FROM unnest(${list}) AS u(v))`;
  }
  return call.compiler.asArray(value, T.date);
}

/**
 * CONTAIN/CONTAINSALL/CONTAINSONLY: the range (argument 0) and the values
 * (arguments 1…, each a value or a list) as arrays of one element type —
 * both through `fx.fold_all` when the call compares texts case-insensitively
 * (`containFoldsCase`, SPEC §9.4).
 */
export function members(call: SqlCall): { range: Sql; values: Sql } {
  const range = call.arg(0);
  const values = argsFrom(call, 1);
  const elementOf = (type: FormulaType) => (type.kind === 'list' ? type.element : type);
  let element = elementOf(range.type);
  for (const value of values) element = call.compiler.common(element, elementOf(value.type));
  if (element.kind === 'row') return call.compiler.crossTable('Looking for records');
  element = elementOfType({ kind: 'list', element });
  if (element.kind === 'user') element = T.text;
  const rangeArray = call.compiler.asArray(range, element);
  const valueArray = call.compiler.combine(values, element);
  const folds =
    call.node.exact !== true &&
    element.kind === 'text' &&
    containFoldsCase([range.type, ...values.map((value) => value.type)]);
  if (!folds) {
    return { range: rangeArray, values: valueArray };
  }
  return { range: foldAll(rangeArray), values: foldAll(valueArray) };
}

/** `fx.fold_all`: every text of a `text[]` case-folded (CONTAIN*, SPEC §9.4). */
export const foldAll = (array: Sql): Sql => sql`fx.fold_all(${array})`;

/** `fx.fold`: one text case-folded (CONTAIN* on record titles, SPEC §9.4). */
export const fold = (text: Sql): Sql => sql`fx.fold(${text})`;

/** `ARRAY[…]` of text arguments `from…` (FORMAT). */
export function texts(call: SqlCall, from: number): Sql {
  const values = argsFrom(call, from);
  if (values.length === 0) return emptyOf({ kind: 'list', element: T.text });
  return sql`ARRAY[${sql.join(values.map((value) => call.compiler.toText(value)))}]::text[]`;
}
