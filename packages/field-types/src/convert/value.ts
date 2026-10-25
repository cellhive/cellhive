import { isoDateInZone, isValidEpochMs, parseIsoDate, parseIsoInstant } from '../internal/dates.js';
import { splitList, unique } from '../internal/results.js';
import { parseLocaleNumberExact } from '../number-parse.js';
import { FIELD_TYPE_REGISTRY } from '../registry.js';
import { wallTimeToEpoch } from '../time-zone.js';
import { datetimeFieldType, fieldTimeZone, isDateOnlyFormat } from '../types/datetime.js';
import {
  MAX_OPTION_NAME_LENGTH,
  findSelectOption,
  selectOptionSchema,
  type SelectOptions,
} from '../types/select.js';
import { isEmail } from '../types/user.js';

import {
  classifyConversion,
  sourceKindOf,
  type ConversionKind,
  type ConversionSettings,
  type FieldDefinitionRef,
} from './classify.js';

import type { LocaleContext, UserRef } from '../core.js';
import type { DatetimeOptions } from '../types/datetime.js';

/** Locale, zone and user lookups a conversion reads values with. */
export interface ConversionContext extends LocaleContext {
  /** user ← text (`match_email`): member id of an email; unknown → the value is lost. */
  readonly resolveUserEmail?: (email: string) => string | undefined;
}

/**
 * What happened to one cell:
 * - `empty`: the source cell was empty (target empty too);
 * - `kept`: converted, `value` is the target's json write value;
 * - `truncated`: converted with items dropped (multiple → single);
 * - `lost`: not convertible, the target cell is empty.
 */
export type CellConversion =
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'lost' }
  | { readonly outcome: 'kept' | 'truncated'; readonly value: unknown };

/** A planned conversion: both definitions, the settings and their kind. */
export interface FieldConversionPlan {
  readonly from: FieldDefinitionRef;
  readonly to: FieldDefinitionRef;
  readonly settings: ConversionSettings;
  readonly kind: ConversionKind;
}

export function planFieldConversion(
  from: FieldDefinitionRef,
  to: FieldDefinitionRef,
  settings: ConversionSettings = {},
): FieldConversionPlan {
  return { from, to, settings, kind: classifyConversion(from, to, settings) };
}

const EMPTY: CellConversion = { outcome: 'empty' };
const LOST: CellConversion = { outcome: 'lost' };

function kept(value: unknown): CellConversion {
  return { outcome: 'kept', value };
}

/**
 * Whether a source value (json read shape) is empty. A cleared checkbox is
 * empty, except for number ← checkbox where `false` is `0`.
 */
function isEmptySource(plan: FieldConversionPlan, value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value === false) return plan.to.type !== 'number';
  return false;
}

/** Items of a list read value (select names, users); a single value becomes one item. */
function itemsOf<T>(value: unknown): T[] {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

/** Display text of a source value (`cell_format=text`, CONTRACTS §2). */
function displayText(plan: FieldConversionPlan, value: unknown, ctx: LocaleContext): string {
  const definition = FIELD_TYPE_REGISTRY[plan.from.type];
  return definition.formatText(value as never, plan.from.options as never, ctx);
}

/**
 * Epoch ms of a datetime read value; a calendar date is the start of that
 * day in `timeZone` (the source field's zone), the convention `datetimeValue`
 * reads it back with, so date → number → date keeps the day in any zone.
 */
function epochOfDatetime(value: string, timeZone: string): number | null {
  const date = parseIsoDate(value);
  if (date !== null) return wallTimeToEpoch(date, timeZone);
  return parseIsoInstant(value);
}

/** Target datetime value of an instant or a calendar date. */
function datetimeValue(
  to: DatetimeOptions,
  ctx: LocaleContext,
  source: { readonly epochMs: number } | { readonly date: string },
): string {
  const timeZone = fieldTimeZone(to, ctx);
  if ('date' in source) {
    if (isDateOnlyFormat(to.style.format)) return source.date;
    const wall = parseIsoDate(source.date);
    if (wall === null) throw new TypeError('not a date');
    // A date becomes the start of that day in the field's zone.
    return new Date(wallTimeToEpoch(wall, timeZone)).toISOString();
  }
  return isDateOnlyFormat(to.style.format)
    ? isoDateInZone(source.epochMs, timeZone)
    : new Date(source.epochMs).toISOString();
}

function toText(plan: FieldConversionPlan, value: unknown, ctx: LocaleContext): CellConversion {
  const text = displayText(plan, value, ctx);
  return text === '' ? LOST : kept(text);
}

function toNumber(plan: FieldConversionPlan, value: unknown, ctx: LocaleContext): CellConversion {
  switch (sourceKindOf(plan.from.type)) {
    case 'text': {
      const parsed = typeof value === 'string' ? parseLocaleNumberExact(value, ctx.locale) : null;
      if (parsed === null) return LOST;
      // More digits than a double holds: rounded, counted as cut (confirm).
      return parsed.exact
        ? kept(parsed.value + 0)
        : { outcome: 'truncated', value: parsed.value + 0 };
    }
    case 'datetime': {
      const zone = fieldTimeZone(plan.from.options as Partial<DatetimeOptions>, ctx);
      const epochMs = typeof value === 'string' ? epochOfDatetime(value, zone) : null;
      return epochMs === null ? LOST : kept(epochMs);
    }
    case 'checkbox':
      return kept(value === true ? 1 : 0);
    default:
      return LOST;
  }
}

function toDatetime(plan: FieldConversionPlan, value: unknown, ctx: LocaleContext): CellConversion {
  const to = plan.to.options as DatetimeOptions;
  switch (sourceKindOf(plan.from.type)) {
    case 'text': {
      const cast = datetimeFieldType.typecast(value, to, ctx);
      return cast.ok && cast.value !== null ? kept(cast.value) : LOST;
    }
    case 'number': {
      if (typeof value !== 'number') return LOST;
      // CONTRACTS §4.1: epoch milliseconds, or seconds below 10¹¹.
      const epochMs = Math.abs(value) < 1e11 ? value * 1000 : value;
      if (!isValidEpochMs(epochMs)) return LOST;
      return kept(datetimeValue(to, ctx, { epochMs: Math.trunc(epochMs) }));
    }
    case 'datetime': {
      if (typeof value !== 'string') return LOST;
      if (parseIsoDate(value) !== null) return kept(datetimeValue(to, ctx, { date: value }));
      const epochMs = parseIsoInstant(value);
      return epochMs === null ? LOST : kept(datetimeValue(to, ctx, { epochMs }));
    }
    default:
      return LOST;
  }
}

function isUsableOptionName(name: string): boolean {
  return (
    name.length <= MAX_OPTION_NAME_LENGTH && selectOptionSchema.shape.name.safeParse(name).success
  );
}

/**
 * Option names a source value maps to for select ← text/number: the whole
 * trimmed text for a single select (or a multiple select when it names an
 * option exactly), else the comma-separated parts; a number as displayed.
 */
function selectTokens(plan: FieldConversionPlan, value: unknown, ctx: LocaleContext): string[] {
  const to = plan.to.options as SelectOptions;
  if (sourceKindOf(plan.from.type) === 'number') {
    const text = displayText(plan, value, ctx).trim();
    return text === '' ? [] : [text];
  }
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (trimmed === '') return [];
  if (!to.multiple || findSelectOption(to, trimmed) !== undefined) return [trimmed];
  return unique(splitList(trimmed, /,/));
}

function toSelect(plan: FieldConversionPlan, value: unknown, ctx: LocaleContext): CellConversion {
  const to = plan.to.options as SelectOptions;
  if (plan.from.type === 'select') {
    // multiple → single (§4.2): the first option is kept.
    const names = itemsOf<string>(value);
    if (names.length === 0) return EMPTY;
    const first = names[0] as string;
    const result = to.multiple ? names : first;
    return names.length > 1 && !to.multiple
      ? { outcome: 'truncated', value: result }
      : kept(result);
  }
  let tokens = selectTokens(plan, value, ctx).filter(isUsableOptionName);
  if (plan.settings.match_existing_only === true) {
    tokens = tokens.filter((token) => findSelectOption(to, token) !== undefined);
  }
  if (tokens.length === 0) return LOST;
  return kept(to.multiple ? tokens : tokens[0]);
}

function normalizedTruthy(settings: ConversionSettings): Set<string> {
  return new Set(
    (settings.truthy_values ?? []).map((item) => item.normalize('NFC').trim().toLowerCase()),
  );
}

function toCheckbox(plan: FieldConversionPlan, value: unknown): CellConversion {
  const truthy = normalizedTruthy(plan.settings);
  const items = itemsOf<unknown>(value).filter((item): item is string => typeof item === 'string');
  const checked = items.some((item) => truthy.has(item.normalize('NFC').trim().toLowerCase()));
  // A value that does not read as checked loses its text (counted as lost).
  return checked ? kept(true) : LOST;
}

function toUser(plan: FieldConversionPlan, value: unknown, ctx: ConversionContext): CellConversion {
  const multiple = (plan.to.options as { readonly multiple?: boolean }).multiple !== false;
  if (sourceKindOf(plan.from.type) === 'user') {
    const users = itemsOf<unknown>(value).filter(
      (user): user is UserRef => typeof user === 'object' && user !== null,
    );
    if (users.length === 0) return EMPTY;
    const ids = users.map((user) => ({ id: user.id }));
    if (!multiple && ids.length > 1) return { outcome: 'truncated', value: ids.slice(0, 1) };
    return kept(ids);
  }
  if (typeof value !== 'string') return LOST;
  const emails = splitList(value, /[,;]/).filter(isEmail);
  const ids = unique(
    emails.flatMap((email) => {
      const id = ctx.resolveUserEmail?.(email);
      return id === undefined ? [] : [id];
    }),
  );
  if (ids.length === 0) return LOST;
  if (!multiple && ids.length > 1) {
    return { outcome: 'truncated', value: [{ id: ids[0] as string }] };
  }
  return kept(ids.map((id) => ({ id })));
}

/**
 * Converts one cell (CONTRACTS §4.1–§4.3). `value` is the source cell in
 * its json read shape (`fromStorage` of the source type: select names,
 * users as `{ id, name, email }`, datetimes as ISO text); the result is the
 * target's json write value, to go through the target's `toStorage` (select
 * names → option ids: a name without an option is then lost).
 *
 * `blacklist` conversions lose every non-empty value; `none` and
 * `forbidden` never convert values (a `TypeError`).
 */
export function convertCell(
  plan: FieldConversionPlan,
  value: unknown,
  ctx: ConversionContext,
): CellConversion {
  if (plan.kind === 'none' || plan.kind === 'forbidden') {
    throw new TypeError(`convertCell: a ${plan.kind} conversion has no values to convert`);
  }
  if (isEmptySource(plan, value)) return EMPTY;
  if (plan.kind === 'blacklist') return LOST;
  switch (plan.to.type) {
    case 'text':
      return toText(plan, value, ctx);
    case 'number':
      return toNumber(plan, value, ctx);
    case 'datetime':
      return toDatetime(plan, value, ctx);
    case 'select':
      return toSelect(plan, value, ctx);
    case 'checkbox':
      return toCheckbox(plan, value);
    case 'user':
      return toUser(plan, value, ctx);
    default:
      return LOST;
  }
}

/**
 * Option names of a converted select value that `options` does not have
 * yet (select ← text/number creates them, CONTRACTS §4.1).
 */
export function missingSelectOptionNames(options: SelectOptions, value: unknown): string[] {
  return itemsOf<unknown>(value).filter(
    (name): name is string =>
      typeof name === 'string' && findSelectOption(options, name) === undefined,
  );
}
