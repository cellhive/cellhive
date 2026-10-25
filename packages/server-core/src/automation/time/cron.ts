import { toWallTime, wallTimeToEpoch, type WallTime } from '@cellhive/field-types';

/**
 * Five-field cron expressions of the `schedule` trigger (SPEC §11.2, BACKLOG
 * T508), parsed by code of the repository (no dependency): `minute hour
 * day-of-month month day-of-week`, each field `*`, a number, a range `a-b`,
 * a step `*\/n`, `a-b/n` or `a/n`, or a comma list of those. Months and days
 * accept English three-letter names (`JAN`, `MON`); day-of-week 0 and 7 are
 * Sunday. When both day-of-month and day-of-week are restricted, a day
 * matching either fires (Vixie cron). No `@hourly` macros, `L`, `W`, `#`,
 * `?` or seconds.
 *
 * Fire times are wall times in an IANA time zone, turned into instants with
 * the runtime's tz data (`wallTimeToEpoch`, Temporal's `compatible` mode): a
 * wall time repeated when clocks go back fires once (the earlier instant), a
 * wall time skipped when clocks go forward fires at the shifted instant.
 * Pure: no I/O, no clock.
 */

export interface CronSchedule {
  /** The expression as given, trimmed. */
  readonly source: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 = Sunday … 6 = Saturday. */
  readonly daysOfWeek: ReadonlySet<number>;
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

export type CronParseResult =
  | { readonly ok: true; readonly schedule: CronSchedule }
  | {
      readonly ok: false;
      /** Which field is wrong (`fields` when the count is not 5). */
      readonly field: CronFieldName | 'fields';
      readonly message: string;
    };

export type CronFieldName = 'minute' | 'hour' | 'day_of_month' | 'month' | 'day_of_week';

/** The `schedule` trigger fires at most every 5 minutes (SPEC §11.2). */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 5;

const MONTH_NAMES = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

interface FieldSpec {
  readonly name: CronFieldName;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  /** First value of `names` (1 for months, 0 for days). */
  readonly nameBase?: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day_of_month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  // 7 is Sunday too; folded to 0 below.
  { name: 'day_of_week', min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

class FieldError extends Error {}

function parseValue(text: string, spec: FieldSpec): number {
  if (/^\d{1,2}$/u.test(text)) {
    const value = Number(text);
    if (value < spec.min || value > spec.max) {
      throw new FieldError(`${text} is out of range ${String(spec.min)}-${String(spec.max)}`);
    }
    return value;
  }
  const index = spec.names?.indexOf(text.toUpperCase()) ?? -1;
  if (index >= 0 && spec.nameBase !== undefined) return index + spec.nameBase;
  throw new FieldError(`"${text}" is not a value`);
}

function parseField(text: string, spec: FieldSpec): { values: number[]; star: boolean } {
  const values = new Set<number>();
  let star = false;
  for (const part of text.split(',')) {
    if (part === '') throw new FieldError('Empty list item');
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined || range === undefined || range === '') {
      throw new FieldError(`"${part}" is not a value`);
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/u.test(stepText) || Number(stepText) < 1) {
        throw new FieldError(`"${stepText}" is not a step`);
      }
      step = Number(stepText);
    }
    let start: number;
    let end: number;
    if (range === '*') {
      start = spec.min;
      end = spec.max === 7 ? 6 : spec.max;
      // Vixie cron: a field starting with `*` (even `*/n`) is unrestricted
      // for the day-of-month / day-of-week rule.
      star = true;
    } else if (range.includes('-')) {
      const [from, to, more] = range.split('-');
      if (more !== undefined || from === undefined || to === undefined) {
        throw new FieldError(`"${range}" is not a range`);
      }
      start = parseValue(from, spec);
      end = parseValue(to, spec);
      if (end < start) throw new FieldError(`"${range}" is a decreasing range`);
    } else {
      start = parseValue(range, spec);
      // `a/n` runs from a to the end of the field.
      end = stepText === undefined ? start : spec.max;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values: [...values].sort((a, b) => a - b), star };
}

/** Parses a five-field cron expression. */
export function parseCron(expression: string): CronParseResult {
  const source = expression.trim();
  const parts = source.split(/\s+/u);
  if (parts.length !== 5 || source === '') {
    return { ok: false, field: 'fields', message: 'Expected five fields' };
  }
  const parsed: { values: number[]; star: boolean }[] = [];
  for (const [index, spec] of FIELDS.entries()) {
    try {
      parsed.push(parseField(parts[index] ?? '', spec));
    } catch (error) {
      if (!(error instanceof FieldError)) throw error;
      return { ok: false, field: spec.name, message: error.message };
    }
  }
  const [minute, hour, dom, month, dow] = parsed as [
    { values: number[]; star: boolean },
    { values: number[]; star: boolean },
    { values: number[]; star: boolean },
    { values: number[]; star: boolean },
    { values: number[]; star: boolean },
  ];
  return {
    ok: true,
    schedule: {
      source,
      minutes: minute.values,
      hours: hour.values,
      daysOfMonth: new Set(dom.values),
      months: new Set(month.values),
      daysOfWeek: new Set(dow.values.map((day) => day % 7)),
      dayOfMonthRestricted: !dom.star,
      dayOfWeekRestricted: !dow.star,
    },
  };
}

/**
 * The shortest gap, in wall-clock minutes, between two fire times on
 * consecutive matching days (a day's last fire and the next day's first
 * count, as if both days matched): what "at most every 5 minutes" checks.
 * `Infinity` with a single fire time a day.
 */
export function minIntervalMinutes(schedule: CronSchedule): number {
  const times: number[] = [];
  for (const hour of schedule.hours) {
    for (const minute of schedule.minutes) times.push(hour * 60 + minute);
  }
  times.sort((a, b) => a - b);
  if (times.length < 2) return Infinity;
  let min = 1440 - (times.at(-1) ?? 0) + (times[0] ?? 0);
  for (let index = 1; index < times.length; index += 1) {
    min = Math.min(min, (times[index] ?? 0) - (times[index - 1] ?? 0));
  }
  return min;
}

/** A calendar day (`month` 1–12). */
interface Day {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function dayMatches(schedule: CronSchedule, day: Day): boolean {
  if (!schedule.months.has(day.month)) return false;
  const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
  const dom = schedule.daysOfMonth.has(day.day);
  const dow = schedule.daysOfWeek.has(weekday);
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) return dom || dow;
  if (schedule.dayOfMonthRestricted) return dom;
  if (schedule.dayOfWeekRestricted) return dow;
  return true;
}

function addDays(day: Day, delta: number): Day {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + delta));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Days searched back for a fire time (covers `0 0 29 2 *`: 8 years). */
const MAX_DAYS_BACK = 366 * 8 + 2;

/**
 * Fire times of `schedule` in `timeZone` within `(after, atOrBefore]`
 * (epoch ms), latest first, at most `limit` of them. Distinct instants only
 * (two wall times mapping to one instant fire once).
 */
export function fireTimesBetween(
  schedule: CronSchedule,
  timeZone: string,
  after: number,
  atOrBefore: number,
  limit: number,
): number[] {
  const out: number[] = [];
  if (atOrBefore <= after || limit < 1) return out;
  // Wall times shifted by DST land up to a few hours later: look a day ahead.
  const start = toWallTime(atOrBefore, timeZone);
  let day: Day = addDays({ year: start.year, month: start.month, day: start.day }, 1);
  const minutesDesc = [...schedule.minutes].reverse();
  const hoursDesc = [...schedule.hours].reverse();
  const stop = toWallTime(after, timeZone);
  const stopDay = addDays({ year: stop.year, month: stop.month, day: stop.day }, -1);
  const seen = new Set<number>();
  for (let n = 0; n <= MAX_DAYS_BACK; n += 1, day = addDays(day, -1)) {
    if (
      day.year < stopDay.year ||
      (day.year === stopDay.year &&
        (day.month < stopDay.month || (day.month === stopDay.month && day.day < stopDay.day)))
    ) {
      break;
    }
    if (!dayMatches(schedule, day)) continue;
    for (const hour of hoursDesc) {
      for (const minute of minutesDesc) {
        const wall: WallTime = { ...day, hour, minute, second: 0, millisecond: 0 };
        const at = wallTimeToEpoch(wall, timeZone);
        if (at > atOrBefore || at <= after || seen.has(at)) continue;
        seen.add(at);
        out.push(at);
      }
    }
    // Shifted wall times may come out of order around a DST change.
    if (out.length >= limit) break;
  }
  out.sort((a, b) => b - a);
  return out.slice(0, limit);
}

/** The latest fire time at or before `atOrBefore` and after `after`, or `null`. */
export function latestFireTime(
  schedule: CronSchedule,
  timeZone: string,
  after: number,
  atOrBefore: number,
): number | null {
  return fireTimesBetween(schedule, timeZone, after, atOrBefore, 1)[0] ?? null;
}

/** The first fire time strictly after `after` (within a year), or `null`. */
export function nextFireTime(
  schedule: CronSchedule,
  timeZone: string,
  after: number,
): number | null {
  const horizon = after + 366 * 8 * 86_400_000;
  // Search forward a day at a time, latest-first within the day window.
  for (let from = after; from < horizon; from += 86_400_000) {
    const found = fireTimesBetween(schedule, timeZone, from, from + 86_400_000, 10_000);
    const first = found.at(-1);
    if (first !== undefined) return first;
  }
  return null;
}
