import { DATE_LOCALE, nameOf, quoted } from './shared.js';

import type { MailLocale } from '../../templates.js';

/**
 * `date.reminder` in an email (T542, ADR-34 §1): the date field's name and
 * the reminded value of **that field** (`data.value`, which the recipient
 * reads — checked when sent); the record shows as the item's record.
 */
export interface DateReminderEmailItem {
  readonly type: 'date.reminder';
  /** Name of the date field, when the recipient reads it (else the item is not sent). */
  readonly fieldName: string | null;
  /** `data.value`: `YYYY-MM-DD` (date-only field) or an ISO 8601 instant. */
  readonly value: string;
}

const TEXTS = {
  en: {
    due: (field: string | null, when: string) =>
      field === null ? `Reminder: due ${when}` : `Reminder: ${quoted(field)} is due ${when}`,
  },
  vi: {
    due: (field: string | null, when: string) =>
      field === null ? `Nhắc hạn: đến hạn ${when}` : `Nhắc hạn: ${quoted(field)} đến hạn ${when}`,
  },
} as const satisfies Record<MailLocale, unknown>;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The reminded value as the recipient reads dates: a calendar date as such
 * (no time zone shift), an instant in the recipient's time zone.
 */
export function formatReminderValue(value: string, locale: MailLocale, timeZone: string): string {
  const day = DATE_ONLY.exec(value);
  if (day !== null) {
    const at = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
    return new Intl.DateTimeFormat(DATE_LOCALE[locale], {
      timeZone: 'UTC',
      dateStyle: 'medium',
    }).format(at);
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return new Intl.DateTimeFormat(DATE_LOCALE[locale], {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);
}

export function dateReminderHeadline(
  item: DateReminderEmailItem,
  locale: MailLocale,
  timeZone: string,
): string {
  return TEXTS[locale].due(
    nameOf(item.fieldName),
    formatReminderValue(item.value, locale, timeZone),
  );
}
