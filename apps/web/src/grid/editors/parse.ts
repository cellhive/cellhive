import {
  datetimeFieldType,
  fieldTimeZone,
  findSelectOption,
  isDateOnlyFormat,
  numberFieldType,
  selectFieldType,
  textFieldType,
  toWallTime,
  userFieldType,
  wallTimeToEpoch,
  type DatetimeOptions,
  type LocaleContext,
  type NumberOptions,
  type SelectOptions,
  type TextOptions,
  type UserOptions,
  type ValidationResult,
  type WallTime,
} from '@cellhive/field-types';

import type { EditorDraft, EditorIssue, MemberOption } from './types';

/**
 * Pure parsing of what the user typed into an overlay editor (FRONTEND §4.1
 * step 1): every draft is checked with `validate` of `field-types` before
 * anything is sent, so a value the server would refuse never leaves the
 * browser. Numbers and dates are read like `typecast` reads them, in the
 * user's locale (dates in the field's display format and zone).
 */

function firstIssue(result: ValidationResult): EditorIssue | null {
  if (result.ok) return null;
  const issue = result.issues[0];
  return issue === undefined
    ? { code: 'INVALID_CELL_VALUE' }
    : {
        code: issue.code,
        message: issue.message,
        ...(issue.params ? { params: issue.params } : {}),
      };
}

function draftOf(value: unknown, validation: ValidationResult, typecast = false): EditorDraft {
  const issue = firstIssue(validation);
  if (issue !== null) return { ok: false, issue };
  return { ok: true, commit: { value, display: value, typecast } };
}

// --- text ------------------------------------------------------------------------

/** Text as typed; an empty text is an empty cell (CONTRACTS §2). */
export function textDraft(text: string, options: TextOptions): EditorDraft {
  const value = text === '' ? null : text;
  return draftOf(value, textFieldType.validate(value, options));
}

// --- number ----------------------------------------------------------------------

/** Styles that store a fraction and show a percentage (20% = 0.2). */
export function isPercentStyle(options: NumberOptions): boolean {
  const style = options.style;
  return (style.type === 'plain' || style.type === 'progress') && style.percentage;
}

const inputFormats = new Map<string, Intl.NumberFormat>();

function inputFormat(locale: string): Intl.NumberFormat {
  let format = inputFormats.get(locale);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale, {
      useGrouping: false,
      maximumFractionDigits: 10,
      numberingSystem: 'latn',
    });
    inputFormats.set(locale, format);
  }
  return format;
}

/** Shifts the decimal point in text, so that 0.07 × 100 is exactly 7. */
function shift(value: number, exponent: number): number {
  return Number(`${String(value)}e${String(exponent)}`);
}

/**
 * The text an editor starts with: no grouping, the locale's decimal
 * separator; percentages as the percent number ("20" for 0.2).
 */
export function numberInputText(value: unknown, options: NumberOptions, locale: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return inputFormat(locale).format(isPercentStyle(options) ? shift(value, 2) : value);
}

/**
 * Reads a typed number like `typecast` does (CONTRACTS §2): the locale's
 * separators, grouping, currency signs and `%`. In a percentage field a
 * number without `%` is a percent ("20" = 20% = 0.2).
 */
export function numberDraft(text: string, options: NumberOptions, ctx: LocaleContext): EditorDraft {
  const trimmed = text.trim();
  if (trimmed === '') return draftOf(null, numberFieldType.validate(null, options));
  const cast = numberFieldType.typecast(trimmed, options, ctx);
  if (!cast.ok) {
    return { ok: false, issue: { code: 'EXPECTED_NUMBER', params: { locale: ctx.locale } } };
  }
  let value = cast.value;
  if (value !== null && isPercentStyle(options) && !trimmed.includes('%')) value = shift(value, -2);
  return draftOf(value, numberFieldType.validate(value, options));
}

// --- datetime --------------------------------------------------------------------

/**
 * The locale whose numeric date order matches a display format: typed
 * dates follow the field format ("25/09/2026" in a `dd/MM/yyyy` field),
 * whatever the UI language.
 */
export function formatLocale(options: DatetimeOptions, fallback: string): string {
  const format = options.style.format;
  if (format.startsWith('dd')) return 'en-GB';
  if (format.startsWith('MM')) return 'en-US';
  return fallback;
}

export function isDateOnly(options: DatetimeOptions): boolean {
  return isDateOnlyFormat(options.style.format);
}

/** The value as the field shows it (`style.format`, field zone): the editor's text. */
export function datetimeInputText(
  value: unknown,
  options: DatetimeOptions,
  ctx: LocaleContext,
): string {
  if (typeof value !== 'string' || value === '') return '';
  return datetimeFieldType.formatText(value, options, ctx);
}

/**
 * Reads a typed date (and time) in the field's format and zone, or ISO
 * 8601; the result is the json write shape (`YYYY-MM-DD` or an instant).
 */
export function datetimeDraft(
  text: string,
  options: DatetimeOptions,
  ctx: LocaleContext,
): EditorDraft {
  const trimmed = text.trim();
  if (trimmed === '') return draftOf(null, datetimeFieldType.validate(null, options));
  const cast = datetimeFieldType.typecast(trimmed, options, {
    locale: formatLocale(options, ctx.locale),
    timeZone: ctx.timeZone,
  });
  if (!cast.ok) {
    const code = isDateOnly(options) ? 'EXPECTED_DATE' : 'EXPECTED_DATETIME';
    return {
      ok: false,
      issue: { code, params: { pattern: options.style.format } },
    };
  }
  return draftOf(cast.value, datetimeFieldType.validate(cast.value, options));
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Calendar date and time of a json value in the field zone (for the picker). */
export function wallTimeOf(
  value: unknown,
  options: DatetimeOptions,
  ctx: LocaleContext,
): WallTime | null {
  if (typeof value !== 'string') return null;
  const date = ISO_DATE.exec(value);
  if (date !== null) {
    return {
      year: Number(date[1]),
      month: Number(date[2]),
      day: Number(date[3]),
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    };
  }
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? null : toWallTime(epoch, fieldTimeZone(options, ctx));
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/** The json write value of a picked calendar date and time. */
export function valueOfWallTime(
  wall: WallTime,
  options: DatetimeOptions,
  ctx: LocaleContext,
): string {
  if (isDateOnly(options)) return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
  return new Date(wallTimeToEpoch(wall, fieldTimeZone(options, ctx))).toISOString();
}

// --- select ----------------------------------------------------------------------

/**
 * Chosen option names as a write value. Names that are not options yet are
 * sent with `typecast=true` and created by the server — only offered when
 * the role may edit the options (`canCreate`), else refused here.
 */
export function selectDraft(
  names: readonly string[],
  options: SelectOptions,
  canCreate: boolean,
): EditorDraft {
  const unique = [...new Set(names.map((name) => name.trim()).filter((name) => name !== ''))];
  const value = options.multiple ? (unique.length === 0 ? null : unique) : (unique[0] ?? null);
  const unknown = unique.filter((name) => findSelectOption(options, name) === undefined);
  if (unknown.length === 0) return draftOf(value, selectFieldType.validate(value, options));
  if (!canCreate) {
    return {
      ok: false,
      issue: { code: 'INVALID_SELECT_OPTION', params: { value: unknown[0] } },
    };
  }
  return { ok: true, commit: { value, display: value, typecast: true } };
}

/** Option names of a json select value. */
export function selectedNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' && value !== '' ? [value] : [];
}

// --- user ------------------------------------------------------------------------

/** Picked members: written as `[{ id }]`, shown as `[{ id, name, email }]` right away. */
export function userDraft(members: readonly MemberOption[], options: UserOptions): EditorDraft {
  const unique = [...new Map(members.map((member) => [member.id, member])).values()];
  const value = unique.length === 0 ? null : unique.map((member) => ({ id: member.id }));
  const issue = firstIssue(userFieldType.validate(value, options));
  if (issue !== null) return { ok: false, issue };
  const display =
    unique.length === 0
      ? null
      : unique.map((member) => ({ id: member.id, name: member.name, email: member.email }));
  return { ok: true, commit: { value, display, typecast: false } };
}

/** Users of a json user value (`[{ id, name?, email? }]`). */
export function selectedUsers(value: unknown): MemberOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { id, name, email } = item as { id?: unknown; name?: unknown; email?: unknown };
    if (typeof id !== 'string') return [];
    return [
      {
        id,
        name: typeof name === 'string' ? name : '',
        email: typeof email === 'string' ? email : '',
      },
    ];
  });
}

/** Case- and accent-insensitive "contains" for the pickers' search boxes. */
export function matchesSearch(text: string, search: string): boolean {
  const fold = (value: string) =>
    value
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/đ/giu, 'd')
      .toLowerCase();
  return fold(text).includes(fold(search.trim()));
}
