import { newId, type ImportCell, type ImportFieldType } from '@cellhive/contracts';
import {
  CHECKBOX_FALSE_STRINGS,
  CHECKBOX_TRUE_STRINGS,
  datetimeFieldType,
  datetimeOptionsSchema,
  MAX_OPTION_NAME_LENGTH,
  parseLocaleNumber,
  type DatetimeFormat,
} from '@cellhive/field-types';

/** A guessed column type with options for `POST /tables/:id/fields` (T103 shapes). */
export interface GuessedColumn {
  readonly type: ImportFieldType;
  readonly options: Record<string, unknown>;
}

/** Most distinct values of a column guessed as `select`. */
export const SELECT_GUESS_MAX_OPTIONS = 20;

const CHECKBOX_TOKENS = new Set(
  [...CHECKBOX_TRUE_STRINGS, ...CHECKBOX_FALSE_STRINGS].filter((token) => token !== ''),
);
const NUMERIC_TOKENS = new Set(['0', '1']);
const TIME_PART = /\d{1,2}:\d{2}/;
const YEAR_FIRST = /^\d{4}[-/.]/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL = /^https?:\/\/\S+$/i;

const monthFirstCache = new Map<string, boolean>();

/** Whether `locale` writes numeric dates month first (`en-US`: 09/25/2026). */
function monthFirst(locale: string): boolean {
  let found = monthFirstCache.get(locale);
  if (found === undefined) {
    const parts = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(Date.UTC(2000, 10, 22)));
    const order = parts.filter((part) => part.type === 'month' || part.type === 'day');
    found = order[0]?.type === 'month';
    monthFirstCache.set(locale, found);
  }
  return found;
}

function decimalsOf(value: number): number {
  const text = String(value);
  if (text.includes('e')) return 4;
  return Math.min(4, text.split('.')[1]?.length ?? 0);
}

function guessCheckbox(values: readonly (string | number | boolean)[]): boolean {
  let word = false;
  for (const value of values) {
    if (typeof value === 'boolean') {
      word = true;
      continue;
    }
    if (typeof value !== 'string') return false;
    const token = value.normalize('NFC').trim().toLowerCase();
    if (!CHECKBOX_TOKENS.has(token)) return false;
    if (!NUMERIC_TOKENS.has(token)) word = true;
  }
  return word;
}

function guessNumber(
  values: readonly (string | number | boolean)[],
  locale: string,
): GuessedColumn | undefined {
  let precision = 0;
  let percent = values.length > 0;
  let grouped = false;
  for (const value of values) {
    if (typeof value === 'boolean') return undefined;
    if (typeof value === 'number') {
      percent = false;
      precision = Math.max(precision, decimalsOf(value));
      continue;
    }
    const text = value.trim();
    // Leading zeros are identifiers (phone numbers, codes): keep them as text.
    if (/^[+-]?0\d/.test(text)) return undefined;
    const parsed = parseLocaleNumber(text, locale);
    if (parsed === null) return undefined;
    if (!text.endsWith('%')) percent = false;
    if (/\d[.,\s\u00a0\u202f]\d{3}(?:\D|$)/.test(text) && Math.abs(parsed) >= 1000) grouped = true;
    precision = Math.max(precision, decimalsOf(text.endsWith('%') ? parsed * 100 : parsed));
  }
  return {
    type: 'number',
    options: {
      style: { type: 'plain', precision, percentage: percent, thousands_separator: grouped },
    },
  };
}

function guessDatetime(
  values: readonly (string | number | boolean)[],
  locale: string,
): GuessedColumn | undefined {
  const options = datetimeOptionsSchema.parse({});
  let withTime = false;
  let yearFirst = true;
  for (const value of values) {
    // Numbers are epochs to typecast, never dates in a spreadsheet column.
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (!/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(text)) return undefined;
    const cast = datetimeFieldType.typecast(text, options, { locale, timeZone: 'UTC' });
    if (!cast.ok) return undefined;
    if (TIME_PART.test(text)) withTime = true;
    if (!YEAR_FIRST.test(text)) yearFirst = false;
  }
  const date = yearFirst ? 'yyyy-MM-dd' : monthFirst(locale) ? 'MM/dd/yyyy' : 'dd/MM/yyyy';
  const format: DatetimeFormat = withTime ? `${date} HH:mm` : date;
  return { type: 'datetime', options: { style: { format } } };
}

function guessSelect(values: readonly (string | number | boolean)[]): GuessedColumn | undefined {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') return undefined;
    const name = value.trim();
    if (name === '' || name.length > MAX_OPTION_NAME_LENGTH || /[\r\n]/.test(name)) {
      return undefined;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length > SELECT_GUESS_MAX_OPTIONS) return undefined;
  }
  // A category repeats: at least two values per option on average.
  if (names.length === 0 || values.length < names.length * 2) return undefined;
  return {
    type: 'select',
    options: { options: names.map((name) => ({ id: newId('opt'), name })) },
  };
}

function textStyle(values: readonly (string | number | boolean)[]): GuessedColumn {
  const strings = values.map((value) => String(value).trim());
  if (strings.length > 0 && strings.every((value) => EMAIL.test(value))) {
    return { type: 'text', options: { style: { type: 'email' } } };
  }
  if (strings.length > 0 && strings.every((value) => URL.test(value))) {
    return { type: 'text', options: { style: { type: 'url' } } };
  }
  return { type: 'text', options: {} };
}

/**
 * Guesses the field type of a column from its sample values (the first 200
 * rows, SPEC §17), reading numbers and dates with `locale` (the base's
 * locale, like typecast, CONTRACTS §2), in this order:
 *
 * 1. `checkbox`: every value is a checkbox word (`x`, `có`/`không`, `yes`…)
 *    or an XLSX boolean, and not only `0`/`1`;
 * 2. `number`: every value is a number in `locale` (`1.500.000` in `vi`),
 *    none with a leading zero (codes, phone numbers);
 * 3. `datetime`: every value is a written date (`25/09/2026`, `2026-09-25`,
 *    with or without a time); the format follows how they are written;
 * 4. `select`: at most 20 distinct short values, each repeated on average;
 * 5. `text` (style `email`/`url` when every value is one).
 *
 * Empty cells are ignored; a column without values is `text`.
 */
export function guessColumnType(cells: readonly ImportCell[], locale: string): GuessedColumn {
  const values = cells.filter(
    (cell): cell is string | number | boolean =>
      cell !== null && !(typeof cell === 'string' && cell.trim() === ''),
  );
  if (values.length === 0) return { type: 'text', options: {} };
  if (guessCheckbox(values)) return { type: 'checkbox', options: {} };
  return (
    guessNumber(values, locale) ??
    guessDatetime(values, locale) ??
    guessSelect(values) ??
    textStyle(values)
  );
}
