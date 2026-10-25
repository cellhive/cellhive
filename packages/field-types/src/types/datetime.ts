import { canonicalTimeZone, dateReminderOptionSchema } from '@cellhive/contracts';
import { z } from 'zod';

import {
  formatWallTime,
  isoDateInZone,
  isoDateOf,
  isValidEpochMs,
  parseDateText,
  parseIsoDate,
  parseIsoInstant,
  storedInstant,
} from '../internal/dates.js';
import { assertValid, cast, describe, invalid, issue, OK } from '../internal/results.js';
import { DATETIME_OPERATORS } from '../operators.js';
import { isValidTimeZone, toWallTime, wallTimeToEpoch } from '../time-zone.js';

import type { FieldTypeDefinition, LocaleContext, ValidationResult } from '../core.js';

/** Fixed display formats (SPEC §5.5). Formats without `HH:mm` make the field date-only. */
export const DATETIME_FORMATS = [
  'yyyy-MM-dd',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'yyyy-MM-dd HH:mm',
  'dd/MM/yyyy HH:mm',
  'MM/dd/yyyy HH:mm',
] as const;

export type DatetimeFormat = (typeof DATETIME_FORMATS)[number];

export function isDateOnlyFormat(format: DatetimeFormat): boolean {
  return !format.includes('HH');
}

export const timeZoneSchema = z
  .string()
  .refine(isValidTimeZone, { message: 'Unknown IANA time zone' })
  // The IANA primary name PostgreSQL knows (`Asia/Saigon` → `Asia/Ho_Chi_Minh`, T819).
  .overwrite((zone) => canonicalTimeZone(zone) ?? zone);

const datetimeFormatSchema = z.enum(DATETIME_FORMATS);

export const RECORD_CREATED_TIME_SLOT = { $slot: 'record_created_time' } as const;

export const datetimeOptionsSchema = z
  .strictObject({
    style: z
      .strictObject({ format: datetimeFormatSchema.default('yyyy-MM-dd') })
      .default({ format: 'yyyy-MM-dd' }),
    /** Display/typecast zone; the org (or user) zone applies when absent. */
    timezone: timeZoneSchema.optional(),
    default_value: z
      .union([z.string(), z.strictObject({ $slot: z.literal('record_created_time') })])
      .nullable()
      .optional(),
    /**
     * Date reminder of the field (CONTRACTS §22.6, BACKLOG T547): `null` or
     * absent = off. References (`user_field_id`, `user_ids`) are checked by
     * the server against the table and the organization.
     */
    reminder: dateReminderOptionSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.reminder != null &&
      value.reminder.time_of_day !== null &&
      !isDateOnlyFormat(value.style.format)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['reminder', 'time_of_day'],
        message:
          'Only a date-only field has a time of day; a field with a time reminds at its value',
      });
    }
    const fallback = value.default_value;
    if (typeof fallback !== 'string') return;
    const dateOnly = isDateOnlyFormat(value.style.format);
    const valid = dateOnly ? parseIsoDate(fallback) !== null : parseIsoInstant(fallback) !== null;
    if (!valid) {
      ctx.addIssue({
        code: 'custom',
        path: ['default_value'],
        message: dateOnly ? 'Expected YYYY-MM-DD' : 'Expected an ISO 8601 date-time with offset',
      });
    }
  });

export type DatetimeOptions = z.output<typeof datetimeOptionsSchema>;

/** Zone used for this field: its own `timezone`, else the caller's. */
export function fieldTimeZone(
  options: { timezone?: string | undefined },
  ctx: { timeZone: string },
): string {
  return options.timezone ?? ctx.timeZone;
}

function expected(dateOnly: boolean, value: unknown) {
  return dateOnly
    ? issue('EXPECTED_DATE', `Expected a date as YYYY-MM-DD, got ${describe(value)}`)
    : issue(
        'EXPECTED_DATETIME',
        `Expected an ISO 8601 date-time with offset or epoch milliseconds, got ${describe(value)}`,
      );
}

function validateDatetime(value: unknown, options: DatetimeOptions): ValidationResult {
  if (value === null) return OK;
  if (isDateOnlyFormat(options.style.format)) {
    return typeof value === 'string' && parseIsoDate(value) !== null
      ? OK
      : invalid(expected(true, value));
  }
  if (typeof value === 'number' && isValidEpochMs(value)) return OK;
  if (typeof value === 'string' && parseIsoInstant(value) !== null) return OK;
  return invalid(expected(false, value));
}

function typecastDatetime(input: unknown, options: DatetimeOptions, ctx: LocaleContext) {
  const dateOnly = isDateOnlyFormat(options.style.format);
  const timeZone = fieldTimeZone(options, ctx);
  if (input === null || input === undefined) return cast(null);

  let epochMs: number | null = null;
  if (typeof input === 'number' && isValidEpochMs(input)) {
    epochMs = input;
  } else if (typeof input === 'string') {
    const text = input.trim();
    if (text === '') return cast(null);
    const parsed = parseDateText(text, ctx.locale);
    if (parsed?.kind === 'instant') {
      epochMs = parsed.epochMs;
    } else if (parsed?.kind === 'wall') {
      // A wall time is read in the field zone; date-only fields keep its date as written.
      if (dateOnly) return cast(isoDateOf(parsed.wall));
      epochMs = wallTimeToEpoch(parsed.wall, timeZone);
    }
  }
  if (epochMs === null) return invalid(expected(dateOnly, input));
  return cast(dateOnly ? isoDateInZone(epochMs, timeZone) : new Date(epochMs).toISOString());
}

/**
 * `datetime` (SPEC §5.5): `timestamptz`, or `date` when `style.format` has no
 * time. Json reads are ISO 8601 UTC (`…Z`) or `YYYY-MM-DD`.
 */
export const datetimeFieldType: FieldTypeDefinition<
  DatetimeOptions,
  string | null,
  string | null,
  string | null
> = {
  type: 'datetime',
  readOnly: false,
  supportsDefaultValue: true,
  systemColumn: null,
  optionsSchema: datetimeOptionsSchema,
  pgType: (options) => (isDateOnlyFormat(options.style.format) ? 'date' : 'timestamptz'),
  validate: validateDatetime,
  typecast: typecastDatetime,
  toStorage(value, options) {
    assertValid(validateDatetime(value, options));
    if (value === null || isDateOnlyFormat(options.style.format)) return value as string | null;
    const epochMs =
      typeof value === 'number' ? value : (parseIsoInstant(value as string) as number);
    return new Date(epochMs).toISOString();
  },
  fromStorage(stored, options) {
    if (isDateOnlyFormat(options.style.format)) {
      // Configure the driver to return `date` as text; a Date is read at UTC midnight.
      if (typeof stored === 'string')
        return parseIsoDate(stored.slice(0, 10)) === null ? null : stored.slice(0, 10);
      if (stored instanceof Date && !Number.isNaN(stored.getTime()))
        return isoDateInZone(stored.getTime(), 'UTC');
      return null;
    }
    const epochMs = storedInstant(stored);
    return epochMs === null ? null : new Date(epochMs).toISOString();
  },
  formatText(value, options, ctx) {
    if (value === null) return '';
    const format = options.style.format;
    if (isDateOnlyFormat(format)) {
      const date = parseIsoDate(value);
      return date === null ? value : formatWallTime(date, format);
    }
    const epochMs = parseIsoInstant(value);
    return epochMs === null
      ? value
      : formatWallTime(toWallTime(epochMs, fieldTimeZone(options, ctx)), format);
  },
  filterOperators: () => DATETIME_OPERATORS,
};
