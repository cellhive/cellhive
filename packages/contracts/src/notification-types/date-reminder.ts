import { z } from 'zod';

import { isoDateSchema, isoDateTimeSchema } from '../common.js';
import { idOf } from '../ids.js';

/**
 * `date.reminder` (ADR-29 §1, ADR-34 §1; produced from T547): a reminder of
 * the `datetime` field `field_id` of a record (`entity_type = record`).
 * `due_at`: when it was due (offset and time of day applied); `value`: the
 * stored-form value of **that date field** when it was reminded
 * (`YYYY-MM-DD` for a date-only field, else an ISO 8601 UTC instant).
 *
 * A narrow exception to "ids only" (ADR-29 §1, ADR-34 §1): every recipient
 * was checked to read that field when it was written, and the reminder keeps
 * showing the value it was about after the record changes. Never the value
 * of another field.
 */
export const dateReminderDataSchema = z.strictObject({
  field_id: idOf('fld'),
  due_at: isoDateTimeSchema,
  value: z.union([isoDateSchema, isoDateTimeSchema]),
});
export type DateReminderData = z.infer<typeof dateReminderDataSchema>;
