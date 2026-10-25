/**
 * The `schedule` trigger's helpers (T521; SPEC §11.2, board "S5 ·
 * Automation builder - trigger và điều kiện"): quick choices (daily,
 * weekly, monthly) ⇄ a five-field cron, and the next runs in a time zone,
 * shown under the cron. Pure; the server (T508) checks the cron again and
 * refuses more often than every 5 minutes.
 */

/** Five-field cron sets: minute, hour, day of month, month, weekday (0 = Sunday). */
export interface CronSets {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: readonly number[];
  readonly months: readonly number[];
  readonly weekdays: readonly number[];
  /** `*` in the day field / the weekday field (cron: both restricted → either matches). */
  readonly anyDay: boolean;
  readonly anyWeekday: boolean;
}

function range(from: number, to: number, step = 1): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value += step) out.push(value);
  return out;
}

/** One cron field (any, steps of any, `a`, `a-b`, `a-b/n`, lists); `null` when not valid. */
function parseField(text: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/u.exec(part);
    if (match === null) return null;
    const [, base = '', stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return null;
    let from = min;
    let to = max;
    if (base !== '*') {
      const [a = '', b] = base.split('-');
      from = Number(a);
      to = b === undefined ? (stepText === undefined ? from : max) : Number(b);
    }
    if (from < min || to > max || from > to) return null;
    for (const value of range(from, to, step)) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseCron(cron: string): CronSets | null {
  const parts = cron.trim().split(/\s+/u);
  if (parts.length !== 5) return null;
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = parts;
  const minutes = parseField(minute, 0, 59);
  const hours = parseField(hour, 0, 23);
  const days = parseField(day, 1, 31);
  const months = parseField(month, 1, 12);
  const weekdays = parseField(weekday, 0, 7);
  if (minutes === null || hours === null || days === null || months === null || weekdays === null) {
    return null;
  }
  return {
    minutes,
    hours,
    days,
    months,
    weekdays: [...new Set(weekdays.map((value) => value % 7))].sort((a, b) => a - b),
    anyDay: day === '*',
    anyWeekday: weekday === '*',
  };
}

/** Quick choices of the schedule panel; anything else is edited as cron. */
export type SchedulePreset =
  | { readonly kind: 'daily'; readonly hour: number; readonly minute: number }
  | {
      readonly kind: 'weekly';
      readonly hour: number;
      readonly minute: number;
      /** 0 = Sunday … 6 = Saturday, at least one. */
      readonly weekdays: readonly number[];
    }
  | {
      readonly kind: 'monthly';
      readonly hour: number;
      readonly minute: number;
      readonly day: number;
    }
  | { readonly kind: 'cron'; readonly cron: string };

function single(text: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/u.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

/** The quick choice a cron reads as, else `cron`. */
export function presetOf(cron: string): SchedulePreset {
  const raw: SchedulePreset = { kind: 'cron', cron: cron.trim() };
  const parts = cron.trim().split(/\s+/u);
  if (parts.length !== 5) return raw;
  const [minutePart = '', hourPart = '', dayPart = '', monthPart = '', weekdayPart = ''] = parts;
  const minute = single(minutePart, 0, 59);
  const hour = single(hourPart, 0, 23);
  if (minute === null || hour === null || monthPart !== '*') return raw;
  if (dayPart === '*' && weekdayPart === '*') return { kind: 'daily', hour, minute };
  if (dayPart === '*') {
    const weekdays = parseField(weekdayPart, 0, 7);
    if (weekdays === null) return raw;
    return {
      kind: 'weekly',
      hour,
      minute,
      weekdays: [...new Set(weekdays.map((value) => value % 7))].sort((a, b) => a - b),
    };
  }
  const day = single(dayPart, 1, 31);
  if (weekdayPart === '*' && day !== null) return { kind: 'monthly', hour, minute, day };
  return raw;
}

/** `1,2,3,4,5` → `1-5` (runs of three or more). */
function compactList(values: readonly number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length;) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] ?? 0) + 1) end += 1;
    const from = sorted[index] ?? 0;
    const to = sorted[end] ?? 0;
    parts.push(
      end - index >= 2 ? `${String(from)}-${String(to)}` : sorted.slice(index, end + 1).join(','),
    );
    index = end + 1;
  }
  return parts.join(',');
}

export function cronOf(preset: SchedulePreset): string {
  switch (preset.kind) {
    case 'daily':
      return `${String(preset.minute)} ${String(preset.hour)} * * *`;
    case 'weekly':
      return `${String(preset.minute)} ${String(preset.hour)} * * ${compactList(
        preset.weekdays.length === 0 ? [1] : preset.weekdays,
      )}`;
    case 'monthly':
      return `${String(preset.minute)} ${String(preset.hour)} ${String(preset.day)} * *`;
    case 'cron':
      return preset.cron;
  }
}

// --- Time zones ------------------------------------------------------------------------

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall time of an instant in a zone. */
export function wallTimeOf(epochMs: number, timeZone: string): WallTime {
  const parts: Record<string, number> = {};
  for (const part of formatterOf(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts['year'] ?? 1970,
    month: parts['month'] ?? 1,
    day: parts['day'] ?? 1,
    hour: (parts['hour'] ?? 0) % 24,
    minute: parts['minute'] ?? 0,
  };
}

function utcOfWall(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/** The instant of a wall time in a zone; `null` when it does not exist (a DST gap). */
export function instantOf(wall: WallTime, timeZone: string): number | null {
  const guess = utcOfWall(wall);
  let instant = guess;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = utcOfWall(wallTimeOf(instant, timeZone)) - instant;
    const next = guess - offset;
    if (next === instant) break;
    instant = next;
  }
  const back = wallTimeOf(instant, timeZone);
  return utcOfWall(back) === guess ? instant : null;
}

export function isTimeZone(timeZone: string): boolean {
  try {
    formatterOf(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Days searched ahead before giving up (a cron like `0 0 31 2 *` never fires). */
const SEARCH_DAYS = 4 * 366;

/**
 * The next `count` runs after `from` of a cron in a time zone (cron rules:
 * when both the day and the weekday are restricted, either matches). Wall
 * times that do not exist (DST gap) are skipped; `null` for an invalid cron
 * or zone.
 */
export function nextRuns(cron: string, timeZone: string, from: Date, count = 5): Date[] | null {
  const sets = parseCron(cron);
  if (sets === null || !isTimeZone(timeZone)) return null;
  const start = from.getTime();
  const today = wallTimeOf(start, timeZone);
  const out: Date[] = [];
  for (let offset = 0; offset < SEARCH_DAYS && out.length < count; offset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!sets.months.includes(month)) continue;
    const dayMatch = sets.days.includes(day);
    const weekdayMatch = sets.weekdays.includes(date.getUTCDay());
    const matches =
      sets.anyDay || sets.anyWeekday
        ? (sets.anyDay || dayMatch) && (sets.anyWeekday || weekdayMatch)
        : dayMatch || weekdayMatch;
    if (!matches) continue;
    for (const hour of sets.hours) {
      for (const minute of sets.minutes) {
        const instant = instantOf(
          { year: date.getUTCFullYear(), month, day, hour, minute },
          timeZone,
        );
        if (instant === null || instant <= start) continue;
        out.push(new Date(instant));
        if (out.length === count) return out;
      }
    }
  }
  return out;
}

/** Fewest minutes between two runs the server accepts (SPEC §11.2). */
export const MIN_SCHEDULE_MINUTES = 5;

/** Whether two of the next runs are closer than 5 minutes (the server refuses it). */
export function tooFrequent(runs: readonly Date[]): boolean {
  for (let index = 1; index < runs.length; index += 1) {
    const gap = (runs[index]?.getTime() ?? 0) - (runs[index - 1]?.getTime() ?? 0);
    if (gap < MIN_SCHEDULE_MINUTES * 60_000) return true;
  }
  return false;
}
