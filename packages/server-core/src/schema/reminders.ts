import {
  DATE_REMINDER_USER_FIELD_TYPES,
  dateReminderOptionSchema,
  type DateReminderOption,
  type Id,
  type ProblemErrorItem,
} from '@cellhive/contracts';

import { OrgMembersRepository } from '../db/repositories/org-members.repository.js';
import { AppError } from '../errors/app-error.js';
import { DateReminderCursorsRepository } from '../notifications/reminders/date-reminder-cursors.repository.js';

import { FieldsRepository } from './fields.repository.js';

import type { Db } from '../db/create-db.js';
import type { OrgScope } from '../db/repository.js';

/**
 * The schema side of date reminders (CONTRACTS §22.6, BACKLOG T547,
 * ADR-34 §1): `SchemaService` only calls these two functions.
 *
 * - {@link validateDateReminder}: the references of `options.reminder`
 *   (the shape is checked by the `datetime` options schema) — a
 *   `field_user` reminder names a live `user` / `created_by` field of the
 *   same table, a `users` reminder lists members of the organization.
 * - {@link syncDateReminder}: keeps `meta.date_reminder_cursors` equal to
 *   "this field reminds", in the transaction of the field change: turned on
 *   or changed (offset, time of day, recipients, format, zone), or the field
 *   became a reminding `datetime` again (restored from the trash, a
 *   conversion finished or reverted) → armed at `now` (no catch-up of
 *   moments already passed); turned off, deleted, converted to another type
 *   → removed.
 */

/** The part of a field row a reminder depends on. */
export interface ReminderFieldLike {
  readonly type: string;
  readonly options: unknown;
  readonly deleted_at: Date | null;
  readonly purged_at: Date | null;
}
type FieldLike = ReminderFieldLike;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The reminder of a stored field, or `null` (not a `datetime`, off, malformed). */
export function reminderOf(field: {
  readonly type: string;
  readonly options: unknown;
}): DateReminderOption | null {
  if (field.type !== 'datetime') return null;
  const raw = record(field.options)?.['reminder'];
  if (raw === undefined || raw === null) return null;
  const parsed = dateReminderOptionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * What decides when a field reminds and whom (reminder, display format —
 * date-only or not —, zone), as a comparable key; `null` when the field
 * does not remind (off, not a live `datetime`). Pure.
 */
export function reminderKey(field: FieldLike | null): string | null {
  if (field === null || field.deleted_at !== null || field.purged_at !== null) return null;
  const reminder = reminderOf(field);
  if (reminder === null) return null;
  const options = record(field.options) ?? {};
  const style = record(options['style']);
  return JSON.stringify([reminder, style?.['format'] ?? null, options['timezone'] ?? null]);
}

/**
 * Checks the references of `options` (a `datetime` field's parsed options)
 * for a field of `tableId`: `422 VALIDATION_FAILED` with paths under
 * `options.reminder` (`UNKNOWN_FIELD`, `INVALID_FIELD_TYPE`,
 * `USER_NOT_FOUND`). Nothing to check without a reminder, nor when it is
 * the reminder the field already has (`previous`, its stored options): a
 * change of another option never fails on a reference that went stale
 * since (the scan lets such a reminder pass).
 */
export async function validateDateReminder(
  db: Db,
  scope: OrgScope,
  tableId: Id<'tbl'>,
  options: unknown,
  previous?: { readonly type: string; readonly options: unknown },
): Promise<void> {
  const path = 'options.reminder';
  const reminder = reminderOf({ type: 'datetime', options });
  if (reminder === null) return;
  if (previous !== undefined && JSON.stringify(reminderOf(previous)) === JSON.stringify(reminder)) {
    return;
  }
  const errors: ProblemErrorItem[] = [];
  if (reminder.recipients === 'field_user') {
    const field = await new FieldsRepository(db).getById(scope, reminder.user_field_id);
    if (field?.table_id !== tableId) {
      errors.push({
        path: `${path}.user_field_id`,
        code: 'UNKNOWN_FIELD',
        message: 'No field of this table has this id',
      });
    } else if (!(DATE_REMINDER_USER_FIELD_TYPES as readonly string[]).includes(field.type)) {
      errors.push({
        path: `${path}.user_field_id`,
        code: 'INVALID_FIELD_TYPE',
        message: 'Reminders go to the users of a user or created_by field',
        params: { type: field.type, expected: [...DATE_REMINDER_USER_FIELD_TYPES] },
      });
    }
  } else {
    const members = new Set(
      (await new OrgMembersRepository(db).listWithUserByIds(scope, reminder.user_ids)).map(
        (member) => member.user_id,
      ),
    );
    reminder.user_ids.forEach((userId, index) => {
      if (!members.has(userId)) {
        errors.push({
          path: `${path}.user_ids[${String(index)}]`,
          code: 'USER_NOT_FOUND',
          message: 'Not a member of the organization',
        });
      }
    });
  }
  if (errors.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The reminder names a field or a user it cannot use.',
      errors,
    });
  }
}

/** What {@link syncDateReminder} did. */
export type DateReminderSync = 'armed' | 'removed' | 'unchanged';

/**
 * Brings the cursor of a field in line with its change from `before` to
 * `after` (`null`: not there), in the caller's transaction (`scope.tx`).
 */
export async function syncDateReminder(
  db: Db,
  scope: OrgScope,
  fieldId: Id<'fld'>,
  before: FieldLike | null,
  after: FieldLike | null,
  now: Date = new Date(),
): Promise<DateReminderSync> {
  if (scope.tx === undefined) throw new TypeError('syncDateReminder needs a transaction scope');
  const was = reminderKey(before);
  const is = reminderKey(after);
  const cursors = new DateReminderCursorsRepository(db);
  if (is === null) {
    return (await cursors.remove(scope, [fieldId])) > 0 || was !== null ? 'removed' : 'unchanged';
  }
  if (was === is) return 'unchanged';
  await cursors.arm(scope, fieldId, now);
  return 'armed';
}

/** Removes the cursors of fields that are gone for good (their table purged). */
export async function removeDateReminders(
  db: Db,
  scope: OrgScope,
  fieldIds: readonly Id<'fld'>[],
): Promise<number> {
  return new DateReminderCursorsRepository(db).remove(scope, fieldIds);
}
