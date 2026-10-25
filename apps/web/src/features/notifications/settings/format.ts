/**
 * Labels of the daily digest hour (BACKLOG S5 design decision #7: whole
 * hours 00:00–23:00 in the user's time zone).
 */

/** `8` → `08:00` (24-hour clock in every language, as the board shows). */
export function hourLabel(hour: number, locale: string): string {
  const date = new Date(Date.UTC(2026, 0, 1, hour, 0));
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(date);
}

/** `Asia/Ho_Chi_Minh` → `Asia/Ho_Chi_Minh (GMT+7)`; an unknown zone is shown as is. */
export function timeZoneLabel(timeZone: string, locale: string, now: Date = new Date()): string {
  try {
    const offset = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(now)
      .find((part) => part.type === 'timeZoneName')?.value;
    return offset === undefined || offset === '' ? timeZone : `${timeZone} (${offset})`;
  } catch {
    return timeZone;
  }
}
