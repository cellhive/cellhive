import { containFoldsCase } from './case-fold.js';
import { Dec } from './decimal.js';
import {
  datetime,
  elements,
  isDate,
  isDateTime,
  isNull,
  isRow,
  isUser,
  toDec,
  type Value,
} from './values.js';

import type { Args, Runtime } from './runtime.js';

/**
 * Argument readers shared by the function implementations
 * (`src/functions/<NAME>.ts`, T453). Every reader returns `null` for an
 * empty argument; functions are strict unless their description says
 * otherwise (SPEC §9.4: an empty input gives an empty result).
 */

/** Number argument. */
export function num(args: Args, index: number): Dec | null {
  return toDec(args.value(index));
}

/** Optional number argument (`fallback` when left out). */
export function optNum(args: Args, index: number, fallback: Dec): Dec | null {
  return index < args.count ? num(args, index) : fallback;
}

/** Largest integer argument (`fx.int_arg` clamps to the `int` range). */
const INT_LIMIT = 2_147_483_647;
const INT_LIMIT_DEC = Dec.int(INT_LIMIT);

/** Integer argument: truncated toward zero, clamped to ±2,147,483,647 (`fx.int_arg`). */
export function int(args: Args, index: number): number | null {
  const value = num(args, index);
  if (value === null) return null;
  if (value.cmp(INT_LIMIT_DEC) >= 0) return INT_LIMIT;
  if (value.cmp(INT_LIMIT_DEC.neg()) <= 0) return -INT_LIMIT;
  return value.toInt();
}

/** Optional integer argument (`fallback` when left out). */
export function optInt(args: Args, index: number, fallback: number): number | null {
  return index < args.count ? int(args, index) : fallback;
}

/** Text argument (any single value as text). */
export function str(args: Args, index: number): string | null {
  return args.rt.text(args.value(index));
}

/** Optional boolean argument: `fallback` when left out or empty. */
export function optBool(args: Args, index: number, fallback: boolean): boolean {
  const value = args.value(index);
  return value === null ? fallback : value === true;
}

/** Local day of a date argument (a datetime in the formula's time zone). */
export function day(args: Args, index: number): number | null {
  return args.rt.day(args.value(index));
}

/**
 * Arguments `from…` combined into one list like the SQL compiler's
 * `combine`: a list gives its elements (empty ones kept, an empty list
 * nothing), any other value itself (even empty).
 */
export function combine(args: Args, from = 0): Value[] {
  const out: Value[] = [];
  for (let index = from; index < args.count; index += 1) {
    const value = args.value(index);
    if (Array.isArray(value) || args.type(index).kind === 'list') out.push(...elements(value));
    else out.push(value);
  }
  return out;
}

/** CONTAIN*: whether the call compares texts case-insensitively (`containFoldsCase`, SPEC §9.4). */
export function foldsCase(args: Args): boolean {
  if (args.call.exact === true) return false;
  const types = [];
  for (let index = 0; index < args.count; index += 1) types.push(args.type(index));
  return containFoldsCase(types);
}

/** Elements of every argument from `from` on (one value or a list each), empty ones skipped. */
export function flat(args: Args, from = 0): Value[] {
  const out: Value[] = [];
  for (let index = from; index < args.count; index += 1) {
    for (const item of elements(args.value(index))) if (!isNull(item)) out.push(item);
  }
  return out;
}

/** Numbers of every argument (numbers or lists of numbers), empty ones skipped. */
export function numbers(args: Args, from = 0): Dec[] {
  const out: Dec[] = [];
  for (const item of flat(args, from)) {
    const value = toDec(item);
    if (value !== null) out.push(value);
  }
  return out;
}

export function sum(values: readonly Dec[]): Dec {
  return values.reduce((total, value) => total.add(value), Dec.ZERO);
}

/** Numbers sorted ascending. */
export function sorted(values: readonly Dec[]): Dec[] {
  return [...values].sort((a, b) => a.cmp(b));
}

/** Code points of a text (PostgreSQL counts characters, not UTF-16 units). */
export function chars(text: string): string[] {
  return Array.from(text);
}

/** Remainder with the sign of the divisor (MOD, `%`); empty when dividing by zero. */
export function mod(a: Dec, b: Dec): Dec | null {
  if (b.isZero()) return null;
  return a.sub(b.mul(Dec.of(a.floorDiv(b))));
}

/** Numbers of one value or list, empty elements skipped. */
export function numbersOf(value: Value): Dec[] {
  const out: Dec[] = [];
  for (const item of elements(value)) {
    const number = toDec(item);
    if (number !== null) out.push(number);
  }
  return out;
}

/** Local days of a date or list of dates (WORKDAY/NETWORKDAYS holidays); left out → none. */
export function holidays(args: Args, index: number): number[] {
  if (index >= args.count) return [];
  const out: number[] = [];
  for (const item of elements(args.value(index))) {
    const day = args.rt.day(item);
    if (day !== null) out.push(day);
  }
  return out;
}

/**
 * MAX (`direction` 1) / MIN (-1) of numbers or dates; a date that wins
 * over datetimes is returned as its local midnight when the result is a
 * datetime.
 */
export function extreme(args: Args, direction: 1 | -1): Value {
  let best: Value = null;
  for (const item of flat(args)) {
    if (!(item instanceof Dec) && !isDate(item) && !isDateTime(item)) continue;
    if (best === null) {
      best = item;
      continue;
    }
    const order = args.rt.order(item, best);
    if (order !== null && order * direction > 0) best = item;
  }
  if (isDate(best) && args.rt.typeOf(args.call).kind === 'datetime') {
    const instant = args.rt.instant(best);
    return instant === null ? null : datetime(instant);
  }
  return best;
}

/**
 * Stable sort by a key: empty keys last in both directions, ties keep
 * their order (SQL: `ORDER BY key ASC|DESC NULLS LAST, position`).
 */
export function sortBy<T>(
  items: readonly T[],
  key: (item: T) => Value,
  ascending: boolean,
  runtime: Runtime,
): T[] {
  const keyed = items.map((item, index) => ({ item, index, key: key(item) }));
  keyed.sort((a, b) => {
    const emptyA = isNull(a.key);
    const emptyB = isNull(b.key);
    if (emptyA || emptyB) return emptyA === emptyB ? a.index - b.index : emptyA ? 1 : -1;
    const order = runtime.order(a.key, b.key) ?? 0;
    if (order === 0) return a.index - b.index;
    return ascending ? order : -order;
  });
  return keyed.map((entry) => entry.item);
}

/** Identity of a value for UNIQUE (same rules as `=` for values of one type). */
export function uniqueKey(value: Value): string {
  if (value === null) return 'z';
  if (typeof value === 'string') return `s${value}`;
  if (typeof value === 'boolean') return value ? 'bt' : 'bf';
  if (value instanceof Dec) return `n${value.toString()}`;
  if (Array.isArray(value)) return `l${JSON.stringify((value as readonly Value[]).map(uniqueKey))}`;
  if (isDate(value)) return `d${String(value.day)}`;
  if (isDateTime(value)) return `t${String(value.ms)}`;
  if (isRow(value)) return `r${value.tableId}:${value.id}`;
  if (isUser(value)) return `u${value.id}`;
  return `o${JSON.stringify(value)}`;
}
