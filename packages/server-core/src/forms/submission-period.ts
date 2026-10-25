import { toWallTime, wallTimeToEpoch, type WallTime } from '@cellhive/field-types';

import type { SubmissionLimit } from '@cellhive/contracts';

/**
 * The calendar period of a per-person submission limit that contains an
 * instant (BACKLOG S3 decision 9): the person may submit once in
 * `[start, next)`. `once` covers all time (`start` = epoch, `next` =
 * `null`); `none` has no period.
 */
export interface SubmissionPeriod {
  readonly start: Date;
  /** Start of the next period; `null` for `once`. */
  readonly next: Date | null;
}

function midnight(year: number, month: number, day: number): WallTime {
  return { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 };
}

/** Wall date `days` after `wall` (calendar arithmetic, month/year overflow handled). */
function plusDays(wall: WallTime, days: number): WallTime {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return midnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * The period of `limit` containing `now`, in `timeZone` (an IANA zone the
 * runtime knows): a calendar day, an ISO week (Monday 00:00 to the next
 * Monday) or a calendar month, each starting at local midnight (the first
 * valid instant of the day when DST skips midnight).
 */
export function submissionPeriod(
  limit: SubmissionLimit,
  now: Date,
  timeZone: string,
): SubmissionPeriod | null {
  if (limit === 'none') return null;
  if (limit === 'once') return { start: new Date(0), next: null };
  const today = toWallTime(now.getTime(), timeZone);
  let first: WallTime;
  let after: WallTime;
  if (limit === 'daily') {
    first = midnight(today.year, today.month, today.day);
    after = plusDays(first, 1);
  } else if (limit === 'weekly') {
    // getUTCDay of the wall date: 0 = Sunday … 6 = Saturday; ISO weeks start on Monday.
    const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    first = plusDays(midnight(today.year, today.month, today.day), -((weekday + 6) % 7));
    after = plusDays(first, 7);
  } else {
    first = midnight(today.year, today.month, 1);
    after =
      today.month === 12
        ? midnight(today.year + 1, 1, 1)
        : midnight(today.year, today.month + 1, 1);
  }
  return {
    start: new Date(wallTimeToEpoch(first, timeZone)),
    next: new Date(wallTimeToEpoch(after, timeZone)),
  };
}
