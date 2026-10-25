import { z } from 'zod';

import {
  DEFAULT_DUE_TIME_OF_DAY,
  MAX_DATE_OFFSET_MINUTES,
} from './automation-triggers/date-reached.js';
import { idOf } from './ids.js';

/**
 * Date reminders (CONTRACTS §2 `datetime`, §22.6; ADR-29 §1, ADR-34 §1;
 * BACKLOG T547): `options.reminder` of a `datetime` field. One reminder per
 * field: when the date of a record (plus `offset_minutes`; a date-only
 * value at `time_of_day` in the field's zone, else the organization's —
 * ADR-21) passes, a `date.reminder` notification goes to the users of a
 * `user` / `created_by` field of the record (`field_user`, read when the
 * reminder fires) or to a fixed list of members (`users`). Who may see it
 * is checked per recipient when it is sent (record + the date field).
 */

/** Members of a fixed recipient list at most (`recipients: users`). */
export const MAX_DATE_REMINDER_USER_IDS = 50;

/** Reminders queued per field per scan at most; the rest waits for the next scan. */
export const DATE_REMINDER_MAX_PER_SCAN = 1000;

/** Field types a `field_user` reminder may name (same table as the date field). */
export const DATE_REMINDER_USER_FIELD_TYPES = ['user', 'created_by'] as const;

/** Who receives the reminders of a field. */
export const DATE_REMINDER_RECIPIENTS = ['field_user', 'users'] as const;
export type DateReminderRecipients = (typeof DATE_REMINDER_RECIPIENTS)[number];

const reminderTiming = {
  offset_minutes: z
    .int()
    .min(-MAX_DATE_OFFSET_MINUTES)
    .max(MAX_DATE_OFFSET_MINUTES)
    .default(0)
    .meta({
      description:
        'Minutes after (positive) or before (negative) the date, ' +
        `−${String(MAX_DATE_OFFSET_MINUTES)} … ${String(MAX_DATE_OFFSET_MINUTES)}`,
    }),
  time_of_day: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, { message: 'Expected HH:MM' })
    .nullable()
    .default(null)
    .meta({
      description:
        `Date-only fields only: time of day in the field’s zone (\`null\` = ${DEFAULT_DUE_TIME_OF_DAY}); ` +
        'must be `null` on a field with a time',
    }),
};

export const dateReminderOptionSchema = z
  .discriminatedUnion('recipients', [
    z.strictObject({
      ...reminderTiming,
      recipients: z.literal('field_user'),
      user_field_id: idOf('fld').meta({
        description:
          'A `user` or `created_by` field of the same table, read when the reminder fires',
      }),
    }),
    z.strictObject({
      ...reminderTiming,
      recipients: z.literal('users'),
      user_ids: z
        .array(idOf('usr'))
        .min(1)
        .max(MAX_DATE_REMINDER_USER_IDS)
        .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate user id' })
        .meta({
          description: `1–${String(MAX_DATE_REMINDER_USER_IDS)} members of the organization`,
        }),
    }),
  ])
  .meta({
    id: 'DateReminderOption',
    description:
      '`options.reminder` of a `datetime` field (`null` = off; CONTRACTS §22.6). When a record’s ' +
      'date plus `offset_minutes` passes (date-only values at `time_of_day`, default 09:00, in the ' +
      'field’s time zone, else the organization’s), a `date.reminder` notification goes to the ' +
      'users of `user_field_id` at that moment or to `user_ids`; each recipient must read the ' +
      'record and the date field (and, with `field_user`, the recipient field) when it is sent. ' +
      'Turning it on or changing it never reminds of ' +
      'moments already passed. Saving it needs the right to change the schema.',
  });
export type DateReminderOption = z.infer<typeof dateReminderOptionSchema>;
export type DateReminderOptionInput = z.input<typeof dateReminderOptionSchema>;
