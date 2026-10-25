import { z } from 'zod';

import { idOf } from '../ids.js';

/** Bound of `offset_minutes` (± 30 days, SPEC §11.2). */
export const MAX_DATE_OFFSET_MINUTES = 43_200;

/** Time of day of a date-only field when `time_of_day` is `null` (SPEC §11.2). */
export const DEFAULT_DUE_TIME_OF_DAY = '09:00';

/**
 * `record.date_reached` (SPEC §11.2, BACKLOG T508): fires once per (record,
 * value) when the date of `field_id` plus `offset_minutes` passes, for
 * moments that pass after the automation was turned on. `field_id`: a
 * `datetime` field, `created_at`, or a **stored** formula/lookup of a date
 * type the saver reads (virtual → `INVALID_FIELD_TYPE`). Date-only values
 * fire at `time_of_day` (default `09:00`) in the field's time zone (its
 * `options.timezone`, else the organization's — ADR-21). A changed value
 * fires again for the new value; trashed records and records outside the
 * read rule of `run_as` never fire. Run data: `due_at` (CONTRACTS §21
 * "Trigger thời gian").
 */
export const dateReachedTriggerSchema = z
  .strictObject({
    type: z.literal('record.date_reached'),
    table_id: idOf('tbl'),
    field_id: idOf('fld'),
    offset_minutes: z
      .int()
      .min(-MAX_DATE_OFFSET_MINUTES)
      .max(MAX_DATE_OFFSET_MINUTES)
      .default(0)
      .meta({ description: 'Minutes after (positive) or before (negative) the date' }),
    time_of_day: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, { message: 'Expected HH:MM' })
      .nullable()
      .default(null)
      .meta({ description: 'Date-only fields: time of day in the field’s zone (default 09:00)' }),
  })
  .meta({
    id: 'DateReachedTrigger',
    description:
      'Fires once per (record, value) when the date of `field_id` plus `offset_minutes` passes ' +
      'after the automation was turned on; a new value fires again. `field_id`: `datetime`, ' +
      '`created_at` or a stored formula/lookup of a date type (virtual → `INVALID_FIELD_TYPE`). ' +
      'Date-only values fire at `time_of_day` (default 09:00) in the field’s time zone. Trashed ' +
      'records and records `run_as` cannot read never fire. Run data: `due_at`',
  });
