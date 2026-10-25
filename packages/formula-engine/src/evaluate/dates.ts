import { timeZoneOffset, toWallTime, wallTimeAsUtc, type WallTime } from '@cellhive/field-types';

/**
 * Calendar arithmetic of the TS evaluator (T453). A `date` is a day number
 * (days since 1970-01-01, proleptic Gregorian), a `datetime` an instant in
 * epoch milliseconds. Converting between them always takes the formula's
 * time zone as a parameter (ADR-21): the machine's zone is never read.
 * Years are limited to 1–9999; anything outside is `null`. The rules mirror
 * the `fx.*` functions of the SQL compiler (T454, migration 0021).
 */

export const DAY_MS = 86_400_000;
export const MIN_YEAR = 1;
export const MAX_YEAR = 9999;
/** Day numbers of 0001-01-01 and 9999-12-31. */
export const MIN_DAY = daysFromCivil(MIN_YEAR, 1, 1);
export const MAX_DAY = daysFromCivil(MAX_YEAR, 12, 31);

export interface Civil {
  year: number;
  month: number;
  day: number;
}

/** Day number of a civil date (H. Hinnant's `days_from_civil`). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Civil date of a day number (`civil_from_days`). */
export function civilFromDays(days: number): Civil {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 30;
}

export function inRange(day: number): boolean {
  return Number.isFinite(day) && day >= MIN_DAY && day <= MAX_DAY;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/**
 * `DATE(y, m, d)` (`fx.date`): 1 January of `year` + (m − 1) months +
 * (d − 1) days, months and days rolling over; the year must be 1–9999 and
 * the rolled month within years 1–9999.
 */
export function makeDate(year: number, month: number, day: number): number | null {
  if (year < MIN_YEAR || year > MAX_YEAR || Math.abs(month) > 120_000) return null;
  if (Math.abs(day) > 1_000_000) return null;
  const months = year * 12 + (month - 1);
  if (months < 12 || months > 119_999) return null;
  const y = Math.floor(months / 12);
  const result = daysFromCivil(y, months - y * 12 + 1, 1) + (day - 1);
  return inRange(result) ? result : null;
}

/** Largest month count EDATE/EOMONTH accept (`fx.edate`). */
const MAX_MONTHS = 12_000;

/** The same day `months` later, clamped to the end of the month (EDATE). */
export function addMonths(days: number, months: number): number | null {
  if (!inRange(days) || Math.abs(months) > MAX_MONTHS) return null;
  const { year, month, day } = civilFromDays(days);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  return daysFromCivil(y, m, Math.min(day, daysInMonth(y, m)));
}

/** Last day of the month `months` later (EOMONTH). */
export function endOfMonth(days: number, months: number): number | null {
  if (!inRange(days) || Math.abs(months) > MAX_MONTHS) return null;
  const { year, month } = civilFromDays(days);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  return daysFromCivil(y, m, daysInMonth(y, m));
}

/** Day number of an instant's local date in `timeZone`. */
export function localDay(ms: number, timeZone: string): number {
  const wall = toWallTime(ms, timeZone);
  return daysFromCivil(wall.year, wall.month, wall.day);
}

/** Wall-clock reading of an instant in `timeZone`. */
export function localWall(ms: number, timeZone: string): WallTime {
  return toWallTime(ms, timeZone);
}

/**
 * The instant clocks in `timeZone` show `wall` — PostgreSQL's rule for
 * `timestamp AT TIME ZONE tz` (`DetermineTimeZoneOffset`): a time skipped
 * when clocks go forward is read with the offset before the change (so it
 * moves forward), a time repeated when clocks go back is the later
 * instant (the offset after the change).
 */
export function zonedToEpoch(wall: WallTime, timeZone: string): number {
  const local = wallTimeAsUtc(wall);
  const before = local - timeZoneOffset(local - DAY_MS, timeZone);
  const after = local - timeZoneOffset(local + DAY_MS, timeZone);
  const matches = (epoch: number) => wallTimeAsUtc(toWallTime(epoch, timeZone)) === local;
  const valid = [before, after].filter(matches);
  return valid.length === 0 ? before : Math.max(...valid);
}

/** Instant of local midnight of a day in `timeZone` (`fx.date_to_ts`). */
export function startOfDay(days: number, timeZone: string): number {
  const { year, month, day } = civilFromDays(days);
  return zonedToEpoch(
    { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 },
    timeZone,
  );
}

/** Instants datetime arithmetic accepts (`fx.ts_ok`): 0001-01-02 to 9999-12-30 UTC. */
export function instantInRange(ms: number): boolean {
  return ms >= (MIN_DAY + 1) * DAY_MS && ms <= (MAX_DAY - 1) * DAY_MS;
}

/** The same wall-clock time `months` later (EDATE of a datetime, `fx.edate`). */
export function addMonthsToInstant(ms: number, months: number, timeZone: string): number | null {
  if (!instantInRange(ms) || Math.abs(months) > MAX_MONTHS) return null;
  const wall = toWallTime(ms, timeZone);
  const shifted = addMonths(daysFromCivil(wall.year, wall.month, wall.day), months);
  if (shifted === null) return null;
  return zonedToEpoch({ ...wall, ...civilFromDays(shifted) }, timeZone);
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `YYYY-MM-DD`. */
export function isoDate(days: number): string {
  const { year, month, day } = civilFromDays(days);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC). */
export function isoInstant(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  const rest = ms - days * DAY_MS;
  const hour = Math.floor(rest / 3_600_000);
  const minute = Math.floor((rest % 3_600_000) / 60_000);
  const second = Math.floor((rest % 60_000) / 1000);
  const milli = rest % 1000;
  return `${isoDate(days)}T${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(milli, 3)}Z`;
}

/** `YYYY-MM-DD HH:mm:ss` wall time of an instant in `timeZone` (datetime as text). */
export function localText(ms: number, timeZone: string): string {
  const wall = toWallTime(ms, timeZone);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
}

const DATE_TEXT =
  /^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?\s*$/i;

export type ParsedDate = { kind: 'date'; day: number } | { kind: 'datetime'; ms: number };

/**
 * Date text: `YYYY-M-D` or `YYYY/M/D`, optionally followed by ` H:mm`,
 * ` H:mm:ss` or `THH:mm:ss.sss`, optionally with `Z` or a `±HH:mm` offset.
 * Without an offset the wall time is read in `timeZone`. `null` for
 * anything else or an impossible date (`2023-02-30`, `24:00`).
 * A date without a time is a `date`, anything else a `datetime`.
 */
export function parseDateText(text: string, timeZone: string): ParsedDate | null {
  const match = DATE_TEXT.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  const days = daysFromCivil(year, month, day);
  const offsetText = match[8];
  if (match[4] === undefined && offsetText === undefined) return { kind: 'date', day: days };
  const hour = Number(match[4] ?? '0');
  const minute = Number(match[5] ?? '0');
  const second = Number(match[6] ?? '0');
  const millisecond = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (offsetText === undefined) {
    const ms = zonedToEpoch({ year, month, day, hour, minute, second, millisecond }, timeZone);
    return { kind: 'datetime', ms };
  }
  let offset = 0;
  if (offsetText.toUpperCase() !== 'Z') {
    const digits = offsetText.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2) || '0');
    if (hours > 23 || minutes > 59) return null;
    offset = (hours * 60 + minutes) * 60_000 * (offsetText.startsWith('-') ? -1 : 1);
  }
  const ms =
    days * DAY_MS + hour * 3_600_000 + minute * 60_000 + second * 1000 + millisecond - offset;
  return { kind: 'datetime', ms };
}

const TODATE_TEXT =
  /^ *(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)? *$/;

/**
 * `TODATE(text)` (`fx.todate`): `YYYY-M-D` or `YYYY/M/D`, optionally
 * followed by ` H:mm[:ss]` (or `T…`), a wall-clock time in `timeZone`;
 * `null` for anything else or an impossible date or time.
 */
export function parseTodate(text: string, timeZone: string): number | null {
  const match = TODATE_TEXT.exec(text);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const hour = Number(match[4] ?? '0');
  const minute = Number(match[5] ?? '0');
  const second = Number(match[6] ?? '0');
  if (year < MIN_YEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return zonedToEpoch({ year, month, day, hour, minute, second, millisecond: 0 }, timeZone);
}

const WALL_CLOCK_TEXT = /^ *(\d{1,2}):(\d{2})(?::(\d{2}))? *$/;

/**
 * A bare wall-clock time, `H:mm[:ss]` (Lark's `HOUR("11:40:59")`); `null`
 * for anything else. Part of the text coercion of the wall-clock reading
 * functions (`HOUR`, `MINUTE`, `SECOND`, `TEXT` with a date pattern), never
 * of the day-based ones.
 */
export function parseWallClock(
  text: string,
): Omit<WallTime, 'year' | 'month' | 'day' | 'millisecond'> | null {
  const match = WALL_CLOCK_TEXT.exec(text);
  if (match === null) return null;
  const [hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

/**
 * The text of a wall-clock parameter (`HOUR`, `MINUTE`, `SECOND`, `TEXT`
 * with a date pattern): the `TODATE` rule first, else a bare time read at
 * 1970-01-01 in the zone (what `fx.wall_time` builds, migration 0025).
 */
export function parseTodateWall(text: string, timeZone: string): WallTime | null {
  const instant = parseTodate(text, timeZone);
  if (instant !== null) return localWall(instant, timeZone);
  const only = parseWallClock(text);
  if (only === null) return null;
  return { year: 1970, month: 1, day: 1, ...only, millisecond: 0 };
}

// ---------------------------------------------------------------------------
// DATEDIF, WEEKNUM, WORKDAY, NETWORKDAYS

/** Whole months from `start` to `end` (`start ≤ end`). */
function wholeMonths(start: Civil, end: Civil): number {
  const months = (end.year - start.year) * 12 + (end.month - start.month);
  return end.day < start.day ? months - 1 : months;
}

/**
 * `DATEDIF(start, end, unit)`: `Y`, `M`, `D` whole years/months/days;
 * `YM` months and `MD` days left over after whole years/months; `YD` days
 * left over after whole years (a 29 February start is clamped to 28
 * February). `null` when `start > end` or for an unknown unit.
 */
export function datedif(start: number, end: number, unit: string): number | null {
  if (start > end) return null;
  const from = civilFromDays(start);
  const to = civilFromDays(end);
  const months = wholeMonths(from, to);
  switch (unit.toUpperCase()) {
    case 'Y':
      return Math.floor(months / 12);
    case 'M':
      return months;
    case 'D':
      return end - start;
    case 'YM':
      return months % 12;
    case 'MD':
      return end - (addMonths(start, months) ?? start);
    case 'YD':
      return end - (addMonths(start, Math.floor(months / 12) * 12) ?? start);
    default:
      return null;
  }
}

/**
 * `WEEKNUM(date, type)`: the week holding 1 January is week 1; weeks start
 * on Sunday (type 1) or Monday (type 2). `null` for another type.
 */
export function weeknum(days: number, type: number): number | null {
  if (type !== 1 && type !== 2) return null;
  const { year } = civilFromDays(days);
  const first = daysFromCivil(year, 1, 1);
  const offset = (weekdayOf(first) - (type === 1 ? 0 : 1) + 7) % 7;
  return Math.floor((days - first + offset) / 7) + 1;
}

/** `WEEKDAY(date, type)`: type 1 Sunday = 1 … Saturday = 7, type 2 Monday = 1 … Sunday = 7. */
export function weekday(days: number, type: number): number | null {
  const sunday0 = weekdayOf(days);
  if (type === 1) return sunday0 + 1;
  if (type === 2) return ((sunday0 + 6) % 7) + 1;
  return null;
}

export function isWeekend(days: number): boolean {
  const day = weekdayOf(days);
  return day === 0 || day === 6;
}

/** Largest day count WORKDAY accepts (`fx.workday`). */
export const MAX_WORKDAYS = 100_000;

/** `n ≠ 0` working days from `start`, weekends skipped (no holidays). */
function stepWorkdays(start: number, n: number): number {
  const direction = n > 0 ? 1 : -1;
  const count = Math.abs(n);
  // Any 7 consecutive days hold exactly 5 working days.
  const weeks = Math.floor((count - 1) / 5);
  let day = start + direction * 7 * weeks;
  let left = count - 5 * weeks;
  while (left > 0) {
    day += direction;
    if (!isWeekend(day)) left -= 1;
  }
  return day;
}

/** Working days in [from, to] (from ≤ to), weekends excluded. */
function weekdaysBetween(from: number, to: number): number {
  const total = to - from + 1;
  const weeks = Math.floor(total / 7);
  let count = weeks * 5;
  for (let day = from + weeks * 7; day <= to; day += 1) if (!isWeekend(day)) count += 1;
  return count;
}

/** Distinct working-day holidays. */
function holidaySet(holidays: readonly number[]): number[] {
  return [...new Set(holidays)].filter((day) => !isWeekend(day)).sort((a, b) => a - b);
}

/**
 * `WORKDAY(start, days, holidays)`: the working day `days` working days
 * after (before, when negative) `start`; weekends and holidays are
 * skipped, `start` itself is never counted (so `days = 0` gives `start`).
 */
export function workday(start: number, days: number, holidays: readonly number[]): number | null {
  if (!inRange(start) || Math.abs(days) > MAX_WORKDAYS) return null;
  if (days === 0) return start;
  const skip = holidaySet(holidays);
  const direction = days > 0 ? 1 : -1;
  let from = start;
  let result = stepWorkdays(start, days);
  for (;;) {
    const [low, high] = [from, result];
    // Holidays passed over: in (from, result] going forward, [result, from) going back.
    const passed = skip.filter((day) =>
      direction > 0 ? day > low && day <= high : day < low && day >= high,
    ).length;
    if (passed === 0) break;
    from = result;
    result = stepWorkdays(result, direction * passed);
  }
  return inRange(result) ? result : null;
}

/**
 * `NETWORKDAYS(start, end, holidays)`: working days from `start` to `end`,
 * both included, minus holidays in that range; negative when `end < start`.
 */
export function networkdays(start: number, end: number, holidays: readonly number[]): number {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const skipped = holidaySet(holidays).filter((day) => day >= from && day <= to).length;
  const count = weekdaysBetween(from, to) - skipped;
  return start <= end ? count : -count;
}
