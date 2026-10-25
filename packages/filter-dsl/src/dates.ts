import { toWallTime, wallTimeToEpoch } from '@cellhive/field-types';

/** A calendar day; `month` is 1–12. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A parsed `$date.exact`: a day, plus a wall-clock minute when the text had one. */
export interface ExactDate extends CivilDate {
  readonly time: { readonly hour: number; readonly minute: number } | null;
}

const EXACT_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
const DAY_MS = 86_400_000;

function civilToUtcMs(date: CivilDate): number {
  const utc = new Date(0);
  utc.setUTCFullYear(date.year, date.month - 1, date.day);
  return utc.getTime();
}

function utcMsToCivil(epochMs: number): CivilDate {
  const utc = new Date(epochMs);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

/** Parses `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` (SPEC §6.1 `$date.exact`); `null` when invalid. */
export function parseExactDate(text: string): ExactDate | null {
  const match = EXACT_DATE.exec(text);
  if (match === null) return null;
  const [, y = '', mo = '', d = '', h, mi] = match;
  const date = { year: Number(y), month: Number(mo), day: Number(d) };
  const roundTrip = utcMsToCivil(civilToUtcMs(date));
  if (roundTrip.month !== date.month || roundTrip.day !== date.day) return null;
  if (h === undefined || mi === undefined) return { ...date, time: null };
  const hour = Number(h);
  const minute = Number(mi);
  if (hour > 23 || minute > 59) return null;
  return { ...date, time: { hour, minute } };
}

export function addDays(date: CivilDate, days: number): CivilDate {
  return utcMsToCivil(civilToUtcMs(date) + days * DAY_MS);
}

export function addMonths(date: CivilDate, months: number): CivilDate {
  const utc = new Date(0);
  utc.setUTCFullYear(date.year, date.month - 1 + months, 1);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: 1 };
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
export function isoWeekday(date: CivilDate): number {
  const weekday = new Date(civilToUtcMs(date)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

export function formatCivilDate(date: CivilDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

/** The calendar day an instant falls on in `timeZone`. */
export function civilDateInZone(epochMs: number, timeZone: string): CivilDate {
  const wall = toWallTime(epochMs, timeZone);
  return { year: wall.year, month: wall.month, day: wall.day };
}

/** The instant a wall-clock time occurs in `timeZone` (DST gaps resolve forward). */
export function zonedEpoch(
  date: CivilDate,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  return wallTimeToEpoch({ ...date, hour, minute, second: 0, millisecond: 0 }, timeZone);
}

/** First instant of a calendar day in `timeZone` (not always 00:00 on DST days). */
export function startOfDay(date: CivilDate, timeZone: string): number {
  return zonedEpoch(date, 0, 0, timeZone);
}
