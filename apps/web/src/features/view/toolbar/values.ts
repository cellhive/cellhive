import {
  isDateValue,
  isVariableValue,
  RELATIVE_DATES,
  RELATIVE_DATES_WITH_AMOUNT,
  type RelativeDate,
} from '@cellhive/filter-dsl';

/**
 * Operands of the value editors (T311) in the forms `validateFilter`
 * accepts: dates as `$date` (exact or relative, SPEC §6.1), users as ids or
 * the `current_user` / `current_user_groups` variables.
 */

/** A date operand as the date editor shows it. */
export type DateChoice =
  | { readonly mode: 'exact'; readonly date: string }
  | { readonly mode: RelativeDate; readonly amount?: number };

export const DATE_MODES = ['exact', ...RELATIVE_DATES] as const;
export type DateMode = (typeof DATE_MODES)[number];

/** Default `amount` of "N days ago / from now". */
export const DEFAULT_DAYS = 7;

export function needsAmount(mode: DateMode): boolean {
  return mode !== 'exact' && RELATIVE_DATES_WITH_AMOUNT.has(mode);
}

/** The operand of a date choice (`undefined` while an exact date is not picked yet). */
export function dateOperand(choice: DateChoice): unknown {
  if (choice.mode === 'exact') {
    return choice.date === '' ? undefined : { $date: { exact: choice.date } };
  }
  if (needsAmount(choice.mode)) {
    const amount = choice.amount ?? DEFAULT_DAYS;
    return { $date: { relative: choice.mode, amount } };
  }
  return { $date: { relative: choice.mode } };
}

/** How the date editor shows an operand of a saved filter. */
export function dateChoiceOf(value: unknown): DateChoice {
  if (typeof value === 'string') return { mode: 'exact', date: value.slice(0, 10) };
  if (isVariableValue(value) && value.$var === 'today') return { mode: 'today' };
  if (isDateValue(value)) {
    const spec = value.$date;
    if ('exact' in spec) return { mode: 'exact', date: spec.exact.slice(0, 10) };
    return spec.amount === undefined
      ? { mode: spec.relative }
      : { mode: spec.relative, amount: spec.amount };
  }
  return { mode: 'exact', date: '' };
}

/** The variables a user condition may use (SPEC §6.1). */
export const USER_VARIABLES = ['current_user', 'current_user_groups'] as const;
export type UserVariable = (typeof USER_VARIABLES)[number];

/** Key of a user operand in the picker: the user id or `$var:<name>`. */
export function userKey(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isVariableValue(value)) return `$var:${value.$var}`;
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = value.id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

export function userOperand(key: string): unknown {
  return key.startsWith('$var:') ? { $var: key.slice('$var:'.length) } : key;
}

/** A list operand as a list (a single saved value reads as one item). */
export function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? (value as unknown[]) : [value];
}

/** The two operands of `between` (missing ones `undefined`). */
export function pairOf(value: unknown): [unknown, unknown] {
  return Array.isArray(value) ? [value[0], value[1]] : [undefined, undefined];
}
