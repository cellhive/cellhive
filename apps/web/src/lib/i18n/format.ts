import { canonicalTimeZone } from '@cellhive/contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { meQuery } from '../session/session';
import { useSessionless } from '../session/sessionless';

export interface Formatters {
  locale: string;
  timeZone: string;
  dateTime: (value: string | Date) => string;
  date: (value: string | Date) => string;
  number: (value: number) => string;
  relative: (value: string | Date, now?: Date) => string;
}

const RELATIVE_STEPS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

/**
 * `Intl` formatters for a locale and time zone (FRONTEND §9.1, SPEC §18).
 * Cell values will use the `field-types` formatters instead.
 */
export function createFormatters(locale: string, timeZone: string): Formatters {
  const dateTimeFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone });
  const numberFormat = new Intl.NumberFormat(locale);
  const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const toDate = (value: string | Date) => (typeof value === 'string' ? new Date(value) : value);
  return {
    locale,
    timeZone,
    dateTime: (value) => dateTimeFormat.format(toDate(value)),
    date: (value) => dateFormat.format(toDate(value)),
    number: (value) => numberFormat.format(value),
    relative: (value, now = new Date()) => {
      let amount = (toDate(value).getTime() - now.getTime()) / 1000;
      for (const [unit, size] of RELATIVE_STEPS) {
        if (Math.abs(amount) < size) return relativeFormat.format(Math.round(amount), unit);
        amount /= size;
      }
      return relativeFormat.format(Math.round(amount), 'year');
    },
  };
}

/** The browser's zone by IANA primary name (Chrome says `Asia/Saigon`, Postgres knows `Asia/Ho_Chi_Minh`). */
function browserTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return canonicalTimeZone(zone) ?? zone;
}

/**
 * Formatters for the current UI language and the user's time zone (the
 * browser's on screens without a session, T421b).
 */
export function useFormatters(): Formatters {
  const { i18n } = useTranslation();
  const sessionless = useSessionless();
  const { data: me } = useQuery({ ...meQuery(), enabled: !sessionless });
  const timeZone = me?.timezone ?? browserTimeZone();
  return useMemo(() => createFormatters(i18n.language, timeZone), [i18n.language, timeZone]);
}

/**
 * `format.number` for the current UI language without the session (public
 * share pages): counts read "2.000" in Vietnamese, "2,000" in English.
 */
export function useNumberFormat(): (value: number) => string {
  const { i18n } = useTranslation();
  return useMemo(() => {
    const numberFormat = new Intl.NumberFormat(i18n.language);
    return (value: number) => numberFormat.format(value);
  }, [i18n.language]);
}

export { browserTimeZone };
