import {
  DATE_REMINDER_USER_FIELD_TYPES,
  DEFAULT_DUE_TIME_OF_DAY,
  MAX_DATE_OFFSET_MINUTES,
  dateReminderOptionSchema,
  type DateReminderOption,
  type FieldDto,
} from '@cellhive/contracts';
import { isDateOnlyFormat, wallTimeToEpoch, type DatetimeFormat } from '@cellhive/field-types';

import type { TFunction } from 'i18next';

/**
 * Date reminders of `datetime` fields on the client (CONTRACTS §2, §22.6;
 * BACKLOG T554): the pure part shared by the field dialog
 * (`features/field/datetime/reminder`) and the grid header (icon, hint).
 * When a reminder fires follows the server's `dueAt` (time scan core,
 * ADR-34 §1): a value with a time + `offset_minutes`; a date-only value at
 * `time_of_day` (default 09:00) in the field's zone, else the
 * organization's, + `offset_minutes`.
 */

/** Units of the offset, largest first. */
export const REMINDER_UNITS = ['days', 'hours', 'minutes'] as const;
export type ReminderUnit = (typeof REMINDER_UNITS)[number];

/** On time, before the date, after it. */
export const REMINDER_DIRECTIONS = ['at', 'before', 'after'] as const;
export type ReminderDirection = (typeof REMINDER_DIRECTIONS)[number];

export const UNIT_MINUTES: Readonly<Record<ReminderUnit, number>> = {
  days: 1440,
  hours: 60,
  minutes: 1,
};

/** Largest amount of a unit (±43 200 minutes = 30 days). */
export function maxAmountOf(unit: ReminderUnit): number {
  return Math.floor(MAX_DATE_OFFSET_MINUTES / UNIT_MINUTES[unit]);
}

export interface ReminderOffsetParts {
  readonly direction: ReminderDirection;
  /** A positive whole number of `unit` (0 when `direction` is `at`). */
  readonly amount: number;
  readonly unit: ReminderUnit;
}

/** `-1440` → 1 day before; `90` → 90 minutes after; `0` → on time. The largest exact unit wins. */
export function splitOffset(minutes: number): ReminderOffsetParts {
  if (minutes === 0) return { direction: 'at', amount: 0, unit: 'days' };
  const size = Math.abs(minutes);
  const unit =
    REMINDER_UNITS.find((candidate) => size % UNIT_MINUTES[candidate] === 0) ?? 'minutes';
  return {
    direction: minutes < 0 ? 'before' : 'after',
    amount: size / UNIT_MINUTES[unit],
    unit,
  };
}

/** The `offset_minutes` of parts (inverse of {@link splitOffset}). */
export function offsetMinutesOf(parts: ReminderOffsetParts): number {
  if (parts.direction === 'at') return 0;
  const size = parts.amount * UNIT_MINUTES[parts.unit];
  return parts.direction === 'before' ? -size : size;
}

/** `00:00`, `00:30` … `23:30`: the times of day the dialog offers (date-only fields). */
export const TIME_OF_DAY_STEPS: readonly string[] = Array.from({ length: 48 }, (_, index) => {
  const hour = String(Math.floor(index / 2)).padStart(2, '0');
  return `${hour}:${index % 2 === 0 ? '00' : '30'}`;
});

export { DEFAULT_DUE_TIME_OF_DAY };

/** The reminder of a field (`null`: off, not a `datetime`, or malformed). */
export function reminderOfField(
  field: Pick<FieldDto, 'type' | 'options'>,
): DateReminderOption | null {
  if (field.type !== 'datetime') return null;
  const raw = field.options['reminder'];
  if (raw === undefined || raw === null) return null;
  const parsed = dateReminderOptionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Whether a `datetime` field's values are dates without a time. */
export function isDateOnlyField(field: Pick<FieldDto, 'options'>): boolean {
  const style = field.options['style'];
  const format =
    typeof style === 'object' && style !== null && !Array.isArray(style)
      ? (style as Record<string, unknown>)['format']
      : undefined;
  return typeof format === 'string' ? isDateOnlyFormat(format as DatetimeFormat) : true;
}

/** Fields a `field_user` reminder may name: live `user` / `created_by` fields of the table. */
export function recipientFieldsOf(fields: readonly FieldDto[]): FieldDto[] {
  return fields.filter((field) =>
    (DATE_REMINDER_USER_FIELD_TYPES as readonly string[]).includes(field.type),
  );
}

/**
 * Whether the recipient field of a `field_user` reminder can still be used:
 * `missing` (deleted, or not among `fields`), `wrong_type` (converted to
 * another type) — the scan then lets the reminder pass (CONTRACTS §22.6).
 * Only meaningful for someone who sees every field of the table (schema
 * rights): for others a field may only be hidden.
 */
export type RecipientFieldState = 'ok' | 'missing' | 'wrong_type';

export function recipientFieldState(
  reminder: DateReminderOption,
  fields: readonly FieldDto[],
): RecipientFieldState {
  if (reminder.recipients !== 'field_user') return 'ok';
  const field = fields.find((item) => item.id === reminder.user_field_id);
  if (field === undefined) return 'missing';
  return (DATE_REMINDER_USER_FIELD_TYPES as readonly string[]).includes(field.type)
    ? 'ok'
    : 'wrong_type';
}

export interface DueInput {
  readonly dateOnly: boolean;
  /** `YYYY-MM-DD` (date-only) or an ISO instant. */
  readonly value: string;
  readonly offsetMinutes: number;
  /** `HH:MM`; `null` = 09:00 (date-only values only). */
  readonly timeOfDay: string | null;
  /** Zone of date-only values: the field's, else the organization's. */
  readonly timeZone: string;
}

/** When a value is reminded of (epoch ms), as the server computes it; `null` for a bad value. */
export function reminderDueAt(input: DueInput): number | null {
  const offset = input.offsetMinutes * 60_000;
  if (!input.dateOnly) {
    const at = Date.parse(input.value);
    return Number.isNaN(at) ? null : at + offset;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(input.value);
  if (match === null) return null;
  const [hour = 9, minute = 0] = (input.timeOfDay ?? DEFAULT_DUE_TIME_OF_DAY)
    .split(':')
    .map(Number);
  return (
    wallTimeToEpoch(
      {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour,
        minute,
        second: 0,
        millisecond: 0,
      },
      input.timeZone,
    ) + offset
  );
}

/**
 * An example value for the preview: the date a week after `now` in
 * `timeZone` (`YYYY-MM-DD`), or 17:00 that day in that zone (ISO instant)
 * for a field with a time.
 */
export function exampleValueOf(now: Date, dateOnly: boolean, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now.getTime() + 7 * 86_400_000));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  if (dateOnly) return date;
  const [year, month, day] = date.split('-').map(Number);
  return new Date(
    wallTimeToEpoch(
      {
        year: year ?? 1970,
        month: month ?? 1,
        day: day ?? 1,
        hour: 17,
        minute: 0,
        second: 0,
        millisecond: 0,
      },
      timeZone,
    ),
  ).toISOString();
}

/** "1 day before, at 09:00" / "15 minutes before" / "on time" (namespace `grid`, `reminder.*`). */
export function reminderTimingText(
  t: TFunction<'grid'>,
  reminder: Pick<DateReminderOption, 'offset_minutes' | 'time_of_day'>,
  dateOnly: boolean,
): string {
  const parts = splitOffset(reminder.offset_minutes);
  const offset =
    parts.direction === 'at'
      ? t(dateOnly ? 'reminder.onDay' : 'reminder.onTime')
      : t(`reminder.${parts.direction}`, {
          amount: t(`reminder.units.${parts.unit}`, { count: parts.amount }),
        });
  return dateOnly
    ? t('reminder.atTime', { offset, time: reminder.time_of_day ?? DEFAULT_DUE_TIME_OF_DAY })
    : offset;
}

/** A hint of a column header (T554): what the reminder does, or why it is not sent. */
export interface ReminderHeaderHint {
  readonly text: string;
  /** The recipient field is gone (shown only to people with schema rights). */
  readonly warning: boolean;
}

/**
 * Header hints of the reminding fields among `fields` (every live field of
 * the table the user reads): "Reminder: 1 day before, at 09:00 (Asia/…) ·
 * to the people in Owner". `canManage`: the user sees every field, so a
 * recipient field that is not there was deleted or converted — warn.
 * Others never learn the name of a field they cannot read.
 */
export function reminderHeaderHints(
  fields: readonly FieldDto[],
  canManage: boolean,
  t: TFunction<'grid'>,
): ReadonlyMap<string, ReminderHeaderHint> {
  const hints = new Map<string, ReminderHeaderHint>();
  for (const field of fields) {
    const reminder = reminderOfField(field);
    if (reminder === null) continue;
    const state = recipientFieldState(reminder, fields);
    if (canManage && state !== 'ok') {
      hints.set(field.id, { text: t('reminder.headerBroken'), warning: true });
      continue;
    }
    const timing = reminderTimingText(t, reminder, isDateOnlyField(field));
    let to: string;
    if (reminder.recipients === 'users') {
      to = t('reminder.toMembers', { count: reminder.user_ids.length });
    } else {
      const recipient = fields.find((item) => item.id === reminder.user_field_id);
      to =
        recipient === undefined
          ? t('reminder.toAField')
          : t('reminder.toField', { field: recipient.name });
    }
    hints.set(field.id, { text: t('reminder.header', { timing, to }), warning: false });
  }
  return hints;
}
