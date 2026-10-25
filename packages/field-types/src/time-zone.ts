/**
 * Time zone arithmetic on top of `Intl.DateTimeFormat` only (no date
 * library, no fixed offsets), so DST rules come from the runtime's tz data.
 */

/** A wall-clock reading in some time zone; `month` is 1–12. */
export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = formatters.get(timeZone);
  if (dtf === undefined) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, dtf);
  }
  return dtf;
}

/** True when the runtime knows this IANA zone. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone === '') return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock time of an instant in `timeZone`. */
export function toWallTime(epochMs: number, timeZone: string): WallTime {
  const fields: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(epochMs)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return {
    year: fields['year'] ?? 0,
    month: fields['month'] ?? 0,
    day: fields['day'] ?? 0,
    // Some engines print midnight as 24 even with h23.
    hour: (fields['hour'] ?? 0) % 24,
    minute: fields['minute'] ?? 0,
    second: fields['second'] ?? 0,
    millisecond: ((epochMs % 1000) + 1000) % 1000,
  };
}

/** The wall time read as if it were UTC, in epoch ms. */
export function wallTimeAsUtc(wall: WallTime): number {
  const date = new Date(0);
  date.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  date.setUTCHours(wall.hour, wall.minute, wall.second, wall.millisecond);
  return date.getTime();
}

/** Offset of `timeZone` from UTC at an instant, in ms (e.g. +07:00 → 25 200 000). */
export function timeZoneOffset(epochMs: number, timeZone: string): number {
  return wallTimeAsUtc(toWallTime(epochMs, timeZone)) - epochMs;
}

/**
 * The instant at which clocks in `timeZone` show `wall`.
 *
 * Disambiguation follows Temporal's `compatible` mode: a time repeated when
 * clocks go back resolves to the earlier instant; a time skipped when clocks
 * go forward is pushed forward by the length of the gap.
 */
export function wallTimeToEpoch(wall: WallTime, timeZone: string): number {
  const local = wallTimeAsUtc(wall);
  const offsetBefore = timeZoneOffset(local - DAY_MS, timeZone);
  const offsetAfter = timeZoneOffset(local + DAY_MS, timeZone);
  const candidates = [local - offsetBefore, local - offsetAfter].filter(
    (epoch) => wallTimeAsUtc(toWallTime(epoch, timeZone)) === local,
  );
  return candidates.length > 0 ? Math.min(...candidates) : local - offsetBefore;
}
