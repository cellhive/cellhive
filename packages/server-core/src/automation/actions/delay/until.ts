import { wallTimeToEpoch } from '@cellhive/field-types';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * The instant `until` of a `delay` stands for (BACKLOG T506), from a
 * resolved value of SPEC §11.4 (a date cell in `cell_format=json`, a step
 * output, a template's text): an ISO instant with offset as is;
 * `YYYY-MM-DD` = midnight and `YYYY-MM-DDTHH:mm[:ss]` = that wall time,
 * both in `timeZone` (the organization's). A one-item list counts as its
 * item. `null` for anything else (empty, not a date, an impossible day).
 */
export function parseUntil(value: unknown, timeZone: string): Date | null {
  const single = Array.isArray(value) && value.length === 1 ? (value as unknown[])[0] : value;
  if (typeof single !== 'string') return null;
  const text = single.trim();
  if (INSTANT.test(text)) {
    const at = Date.parse(text);
    return Number.isNaN(at) ? null : new Date(at);
  }
  const date = DATE.exec(text);
  const wall = date === null ? WALL.exec(text) : null;
  const parts = date ?? wall;
  if (parts === null) return null;
  const [year, month, day, hour, minute, second] = parts
    .slice(1)
    .map((part: string | undefined) => (part === undefined ? 0 : Number(part)));
  const fields = {
    year: year ?? 0,
    month: month ?? 0,
    day: day ?? 0,
    hour: hour ?? 0,
    minute: minute ?? 0,
    second: second ?? 0,
    millisecond: 0,
  };
  if (fields.month < 1 || fields.month > 12 || fields.day < 1 || fields.day > 31) return null;
  if (fields.hour > 23 || fields.minute > 59 || fields.second > 59) return null;
  // An impossible day (31 June) does not round-trip.
  const check = new Date(Date.UTC(fields.year, fields.month - 1, fields.day));
  if (check.getUTCMonth() !== fields.month - 1 || check.getUTCDate() !== fields.day) return null;
  try {
    return new Date(wallTimeToEpoch(fields, timeZone));
  } catch {
    return null;
  }
}
