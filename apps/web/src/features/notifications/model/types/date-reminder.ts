import { NO_EXTRAS, quoted, str, type ItemContext, type ItemPill, type ItemView } from './shared';

import type { NotificationDto } from '@cellhive/contracts';

/** Where the reminded date stands for the viewer now. */
export type ReminderStatus = 'upcoming' | 'today' | 'overdue';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

/** `YYYY-MM-DD` of `now` in `timeZone`. */
export function localDate(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Upcoming / due today / overdue, from the reminded value (the date field's
 * own value — CONTRACTS §22.1): a date-only value against today in the
 * viewer's time zone; an instant against now. Computed when shown, so an
 * old "upcoming" reminder reads "overdue" once the date has passed.
 */
export function reminderStatus(value: string, now: Date, timeZone: string): ReminderStatus {
  if (DATE_ONLY.test(value)) {
    const today = localDate(now, timeZone);
    if (value > today) return 'upcoming';
    return value === today ? 'today' : 'overdue';
  }
  return Date.parse(value) > now.getTime() ? 'upcoming' : 'overdue';
}

/** `GMT+7` of a zone at `now` (empty when the zone is unknown). */
function zoneOffset(timeZone: string, locale: string, now: Date): string {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'shortOffset' })
        .formatToParts(now)
        .find((part) => part.type === 'timeZoneName')?.value ?? ''
    );
  } catch {
    return '';
  }
}

const PILL_TONE: Record<ReminderStatus, ItemPill['tone']> = {
  upcoming: 'neutral',
  today: 'warning',
  overdue: 'danger',
};

/**
 * `date.reminder` (T547, CONTRACTS §22.1, §22.6): "«record» is due on
 * «field» at 09:00, 18 Oct 2026" with an upcoming / due today / overdue
 * chip. A date-only value keeps its calendar day (no time zone shift); an
 * instant and the moment of the reminder (`due_at`) are shown in the
 * viewer's time zone (`users.timezone`), the zone named next to it.
 */
export function describeDateReminder(item: NotificationDto, ctx: ItemContext): ItemView {
  const value = str(item, 'value');
  const dueAt = str(item, 'due_at');
  const fieldId = str(item, 'field_id');
  const field = fieldId === null ? null : ctx.fieldName(fieldId);
  const record = quoted(item.entity.title, ctx, 'item.aRecord');
  if (value === null) {
    return {
      kind: 'reminder',
      title: ctx.t('item.reminderUnknown', { record }),
      body: null,
      ...NO_EXTRAS,
    };
  }
  const dateOnly = DATE_ONLY.test(value);
  const status = reminderStatus(value, ctx.now, ctx.format.timeZone);
  const when = dateOnly
    ? ctx.t('item.reminderOn', {
        date: new Intl.DateTimeFormat(ctx.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
          new Date(`${value}T00:00:00Z`),
        ),
      })
    : ctx.t('item.reminderAt', { time: ctx.format.dateTime(value) });
  const key = `item.reminder.${status}${field === null ? 'NoField' : ''}`;
  const title = ctx.t(key, {
    record,
    field: field === null ? undefined : ctx.t('item.quoted', { text: field }),
    when,
  });
  // When it was reminded, in the viewer's zone: always for a date-only value
  // (the time of day is the field's setting), for an instant only when an
  // offset moved it away from the value.
  const showDueAt = dueAt !== null && (dateOnly || Date.parse(dueAt) !== Date.parse(value));
  const offset = zoneOffset(ctx.format.timeZone, ctx.locale, ctx.now);
  return {
    kind: 'reminder',
    title,
    body: showDueAt
      ? ctx.t('item.reminderSent', {
          time: ctx.format.dateTime(dueAt),
          zone: offset === '' ? ctx.format.timeZone : offset,
        })
      : null,
    pill: { label: ctx.t(`item.reminderStatus.${status}`), tone: PILL_TONE[status] },
    records: null,
    report: null,
  };
}
