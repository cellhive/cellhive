import { MAX_DATE_REMINDER_USER_IDS, type DateReminderOption } from '@cellhive/contracts';

import { isApiError } from '../../../../lib/api/client';
import {
  maxAmountOf,
  offsetMinutesOf,
  splitOffset,
  type ReminderDirection,
  type ReminderUnit,
} from '../../../../lib/schema/date-reminder';

import type { DraftIssue } from '../../draft';

/**
 * The "Reminder" part of the `datetime` field dialog (T554) as plain data:
 * the timing as the user picks it (direction, amount typed, unit), the time
 * of day of date-only fields, and the recipients. Pure functions only.
 */
export interface ReminderDraft {
  readonly enabled: boolean;
  readonly direction: ReminderDirection;
  /** As typed: a whole number of `unit`. */
  readonly amount: string;
  readonly unit: ReminderUnit;
  /** `HH:MM`; `null` = 09:00 (kept as `null` until the user picks a time). */
  readonly timeOfDay: string | null;
  readonly recipients: DateReminderOption['recipients'];
  /** `''` until a field is chosen. */
  readonly userFieldId: string;
  readonly userIds: readonly string[];
  /** The field had a reminder when the dialog opened: turning it off sends `reminder: null`. */
  readonly saved: boolean;
}

/** Path prefix of every reminder issue (`options.reminder.*`, CONTRACTS §2). */
export const REMINDER_PATH = 'options.reminder';

/** A reminder that is off; turning it on starts from "1 day before" (the board's first example). */
export const REMINDER_OFF: ReminderDraft = {
  enabled: false,
  direction: 'before',
  amount: '1',
  unit: 'days',
  timeOfDay: null,
  recipients: 'field_user',
  userFieldId: '',
  userIds: [],
  saved: false,
};

/** The draft of a saved `options.reminder` (`null`/absent: off). */
export function reminderDraftOf(reminder: DateReminderOption | null | undefined): ReminderDraft {
  if (reminder === null || reminder === undefined) return REMINDER_OFF;
  const parts = splitOffset(reminder.offset_minutes);
  return {
    enabled: true,
    direction: parts.direction,
    amount: parts.direction === 'at' ? '1' : String(parts.amount),
    unit: parts.unit,
    timeOfDay: reminder.time_of_day,
    recipients: reminder.recipients,
    userFieldId: reminder.recipients === 'field_user' ? reminder.user_field_id : '',
    userIds: reminder.recipients === 'users' ? reminder.user_ids : [],
    saved: true,
  };
}

/** The amount typed as a whole number, or `null`. */
function amountOf(draft: ReminderDraft): number | null {
  const typed = draft.amount.trim();
  return /^\d+$/u.test(typed) ? Number(typed) : null;
}

/**
 * The `reminder` key of the options: `null` to turn a saved reminder off,
 * absent while there is none (`PATCH` keeps keys it is not given).
 */
export function reminderOptionsOf(
  draft: ReminderDraft,
  dateOnly: boolean,
): { reminder?: Record<string, unknown> | null } {
  const option = reminderOptionOf(draft, dateOnly);
  if (option !== null) return { reminder: option };
  return draft.saved ? { reminder: null } : {};
}

/**
 * `options.reminder` of the body: `null` when off. A bad amount gives a
 * non-integer offset so that the contract schema reports it too; the time
 * of day is sent only for a date-only field (`422` otherwise).
 */
export function reminderOptionOf(
  draft: ReminderDraft,
  dateOnly: boolean,
): Record<string, unknown> | null {
  if (!draft.enabled) return null;
  const amount = amountOf(draft);
  const offset =
    draft.direction === 'at'
      ? 0
      : amount === null
        ? Number.NaN
        : offsetMinutesOf({ direction: draft.direction, amount, unit: draft.unit });
  const timing = { offset_minutes: offset, time_of_day: dateOnly ? draft.timeOfDay : null };
  return draft.recipients === 'field_user'
    ? { ...timing, recipients: 'field_user', user_field_id: draft.userFieldId }
    : { ...timing, recipients: 'users', user_ids: [...draft.userIds] };
}

/**
 * Problems the form finds itself, with codes of its own (translated by the
 * section): `REMINDER_AMOUNT` (`params.max`), `REMINDER_FIELD_REQUIRED`,
 * `REMINDER_USERS_REQUIRED`, `REMINDER_USERS_TOO_MANY` (`params.max`).
 */
export function reminderIssues(draft: ReminderDraft): DraftIssue[] {
  if (!draft.enabled) return [];
  const issues: DraftIssue[] = [];
  if (draft.direction !== 'at') {
    const amount = amountOf(draft);
    const max = maxAmountOf(draft.unit);
    if (amount === null || amount < 1 || amount > max) {
      issues.push({
        path: `${REMINDER_PATH}.offset_minutes`,
        detail: { code: 'REMINDER_AMOUNT', params: { max } },
      });
    }
  }
  if (draft.recipients === 'field_user' && draft.userFieldId === '') {
    issues.push({
      path: `${REMINDER_PATH}.user_field_id`,
      detail: { code: 'REMINDER_FIELD_REQUIRED' },
    });
  }
  if (draft.recipients === 'users') {
    if (draft.userIds.length === 0) {
      issues.push({
        path: `${REMINDER_PATH}.user_ids`,
        detail: { code: 'REMINDER_USERS_REQUIRED' },
      });
    } else if (draft.userIds.length > MAX_DATE_REMINDER_USER_IDS) {
      issues.push({
        path: `${REMINDER_PATH}.user_ids`,
        detail: { code: 'REMINDER_USERS_TOO_MANY', params: { max: MAX_DATE_REMINDER_USER_IDS } },
      });
    }
  }
  return issues;
}

/** `options.reminder.user_ids[2]` (server) → `options.reminder.user_ids.2` (form paths). */
export function normalizePath(path: string): string {
  return path.replace(/\[(\d+)\]/gu, '.$1');
}

/**
 * The `422 VALIDATION_FAILED` details of a save under `options.reminder`
 * (`UNKNOWN_FIELD` / `INVALID_FIELD_TYPE` on `user_field_id`,
 * `USER_NOT_FOUND` on `user_ids[i]`, shape errors), as form issues.
 */
export function serverReminderIssues(error: unknown): DraftIssue[] {
  if (!isApiError(error) || error.code !== 'VALIDATION_FAILED') return [];
  return error.errors
    .filter((item) => item.path === REMINDER_PATH || item.path.startsWith(`${REMINDER_PATH}.`))
    .map((item) => ({
      path: normalizePath(item.path),
      detail:
        item.params === undefined ? { code: item.code } : { code: item.code, params: item.params },
    }));
}

/** Whether every detail of `error` is a reminder one (then the section explains it, no banner). */
export function onlyReminderErrors(error: unknown): boolean {
  if (!isApiError(error) || error.code !== 'VALIDATION_FAILED' || error.errors.length === 0) {
    return false;
  }
  return error.errors.every(
    (item) => item.path === REMINDER_PATH || item.path.startsWith(`${REMINDER_PATH}.`),
  );
}

/** Index of the member of `user_ids` an issue path names (`options.reminder.user_ids.3` → 3). */
export function userIndexOf(path: string): number | null {
  const match = /^options\.reminder\.user_ids\.(\d+)$/u.exec(path);
  return match === null ? null : Number(match[1]);
}
