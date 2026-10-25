import type { IF_VALUE_OPERATORS } from '@cellhive/contracts';

/**
 * Value conditions of the `if` step (SPEC §11.3): `{ value, operator,
 * compare }` on two values of SPEC §11.4 (JSON: cells in `cell_format=json`,
 * step outputs, rendered templates). Pure.
 *
 * - Empty: `null`, `""` (after trim), `[]`, `{}`.
 * - A record/user/attachment cell item `{ id, … }` stands for its `id`;
 *   a list (`[a, b]`) is a set of such scalars.
 * - `is` / `is_not`: same scalar (numbers by value, so `"10"` is `10`;
 *   text case-sensitive), or same set for lists; a list is `is` a scalar
 *   when it has exactly that one item.
 * - `contains`: text contains text (case-insensitive), or a list has an item
 *   equal to the scalar (or every item of a list).
 * - `gt`/`gte`/`lt`/`lte`: numbers, else ISO dates/datetimes (both sides
 *   the same kind), else `false`.
 */
export type IfValueOperator = (typeof IF_VALUE_OPERATORS)[number];

type Scalar = string | number | boolean;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;

/** One item: `{ id }` → its id; other objects → no scalar. */
function scalarOf(value: unknown): Scalar | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (isObject(value) && (typeof value['id'] === 'string' || typeof value['id'] === 'number')) {
    return value['id'];
  }
  return null;
}

export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.every(isEmptyValue);
  if (isObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** The value as a list of scalars (`null` items and empty strings dropped). */
function itemsOf(value: unknown): Scalar[] {
  const list = Array.isArray(value) ? (value as unknown[]) : [value];
  return list
    .map(scalarOf)
    .filter((item): item is Scalar => item !== null && !(typeof item === 'string' && item === ''));
}

function numberOf(value: Scalar): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NUMBER.test(value.trim())) return Number(value.trim());
  return null;
}

function sameScalar(a: Scalar, b: Scalar): boolean {
  const x = numberOf(a);
  const y = numberOf(b);
  if (x !== null && y !== null) return x === y;
  return String(a) === String(b);
}

function sameSet(a: readonly Scalar[], b: readonly Scalar[]): boolean {
  return (
    a.length === b.length &&
    a.every((item) => b.some((other) => sameScalar(item, other))) &&
    b.every((item) => a.some((other) => sameScalar(item, other)))
  );
}

/** `-1`, `0`, `1`, or `null` when the two cannot be ordered. */
function order(a: unknown, b: unknown): number | null {
  const [x] = itemsOf(a);
  const [y] = itemsOf(b);
  if (x === undefined || y === undefined || itemsOf(a).length > 1 || itemsOf(b).length > 1) {
    return null;
  }
  const nx = numberOf(x);
  const ny = numberOf(y);
  if (nx !== null && ny !== null) return Math.sign(nx - ny);
  if (typeof x === 'string' && typeof y === 'string' && ISO_DATE.test(x) && ISO_DATE.test(y)) {
    const dateOnly = (text: string) => text.length === 10;
    if (dateOnly(x) !== dateOnly(y)) return null;
    const tx = Date.parse(x);
    const ty = Date.parse(y);
    if (Number.isNaN(tx) || Number.isNaN(ty)) return null;
    return Math.sign(tx - ty);
  }
  return null;
}

export function compareIfValues(
  value: unknown,
  operator: IfValueOperator,
  compare: unknown,
): boolean {
  switch (operator) {
    case 'is_empty':
      return isEmptyValue(value);
    case 'is_not_empty':
      return !isEmptyValue(value);
    case 'is':
    case 'is_not': {
      const left = itemsOf(value);
      const right = itemsOf(compare);
      const equal = sameSet(left, right);
      return operator === 'is' ? equal : !equal;
    }
    case 'contains': {
      if (isEmptyValue(compare)) return true;
      if (typeof value === 'string' && typeof compare === 'string') {
        return value.toLocaleLowerCase().includes(compare.toLocaleLowerCase());
      }
      const left = itemsOf(value);
      const right = itemsOf(compare);
      return right.every((item) => left.some((other) => sameScalar(other, item)));
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const result = order(value, compare);
      if (result === null) return false;
      if (operator === 'gt') return result > 0;
      if (operator === 'gte') return result >= 0;
      if (operator === 'lt') return result < 0;
      return result <= 0;
    }
  }
}
