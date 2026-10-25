/**
 * A plain-language reading of the common five-field cron expressions of a
 * `schedule` trigger (SPEC §11.2) for the automation list (T520): every N
 * minutes, every hour at :MM, every day, weekdays, one weekday, one day of
 * the month. Anything else is shown as the expression itself. Pure; the
 * caller translates the {@link CronReading}.
 */
export type CronReading =
  | { readonly kind: 'minutes'; readonly every: number }
  | { readonly kind: 'hourly'; readonly minute: number }
  | { readonly kind: 'daily'; readonly hour: number; readonly minute: number }
  | { readonly kind: 'weekdays'; readonly hour: number; readonly minute: number }
  | {
      readonly kind: 'weekly';
      /** 0 = Sunday … 6 = Saturday (cron `7` is Sunday too). */
      readonly weekday: number;
      readonly hour: number;
      readonly minute: number;
    }
  | {
      readonly kind: 'monthly';
      readonly day: number;
      readonly hour: number;
      readonly minute: number;
    }
  | { readonly kind: 'raw'; readonly cron: string };

function int(part: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/u.test(part)) return null;
  const value = Number(part);
  return value >= min && value <= max ? value : null;
}

export function readCron(cron: string): CronReading {
  const raw: CronReading = { kind: 'raw', cron: cron.trim() };
  const parts = cron.trim().split(/\s+/u);
  if (parts.length !== 5) return raw;
  const [minutePart = '', hourPart = '', dayPart = '', monthPart = '', weekdayPart = ''] = parts;
  if (monthPart !== '*') return raw;
  const every = /^\*\/(\d{1,2})$/u.exec(minutePart);
  if (every !== null && hourPart === '*' && dayPart === '*' && weekdayPart === '*') {
    const step = Number(every[1]);
    return step >= 1 && step <= 59 ? { kind: 'minutes', every: step } : raw;
  }
  const minute = int(minutePart, 0, 59);
  if (minute === null) return raw;
  if (hourPart === '*') {
    return dayPart === '*' && weekdayPart === '*' ? { kind: 'hourly', minute } : raw;
  }
  const hour = int(hourPart, 0, 23);
  if (hour === null) return raw;
  if (dayPart === '*' && weekdayPart === '*') return { kind: 'daily', hour, minute };
  if (dayPart === '*' && weekdayPart === '1-5') return { kind: 'weekdays', hour, minute };
  if (dayPart === '*') {
    const weekday = int(weekdayPart, 0, 7);
    return weekday === null ? raw : { kind: 'weekly', weekday: weekday % 7, hour, minute };
  }
  if (weekdayPart === '*') {
    const day = int(dayPart, 1, 31);
    return day === null ? raw : { kind: 'monthly', day, hour, minute };
  }
  return raw;
}

/** "08:00" in the locale's clock (`8:00 AM` in English), independent of any time zone. */
export function formatClock(locale: string, hour: number, minute: number): string {
  // 24-hour locales read "08:00" (board), 12-hour ones "8:00 AM".
  const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
  return new Intl.DateTimeFormat(locale, {
    hour: cycle === 'h23' || cycle === 'h24' ? '2-digit' : 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2023, 0, 1, hour, minute)));
}

/** Weekday name in the locale; 0 = Sunday (1 January 2023 was a Sunday). */
export function weekdayName(locale: string, weekday: number): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2023, 0, 1 + weekday)),
  );
}

/**
 * The UTC offset of an IANA zone now ("GMT+7"), or the zone itself when the
 * runtime cannot name the offset; `null` for an unknown zone.
 */
export function zoneOffsetLabel(timeZone: string, now = new Date()): string | null {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(now)
      .find((item) => item.type === 'timeZoneName');
    return part?.value ?? timeZone;
  } catch {
    return null;
  }
}
