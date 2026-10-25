import { DEFAULT_DUE_TIME_OF_DAY } from '@cellhive/contracts';
import { isValidTimeZone, toWallTime, wallTimeToEpoch } from '@cellhive/field-types';

import type { DueBound, DueValueKind } from '../records/due/due-scan.js';

/**
 * When a date value is "reached" (SPEC §11.2 `record.date_reached`, BACKLOG
 * T508; S5b date reminders use the same rule, ADR-29 §1). Part of the shared
 * time scan core (ADR-34 §1, BACKLOG T546; moved from `automation/time`,
 * which re-exports it). Pure.
 *
 * - `instant` values (`timestamptz`): the value plus `offsetMinutes`;
 * - `date` values (`YYYY-MM-DD`): `timeOfDay` (default `09:00`) of that day
 *   in `timeZone` — the field's own zone, else the organization's (ADR-21)
 *   — plus `offsetMinutes`. A wall time skipped by DST fires at the shifted
 *   instant, a repeated one at the earlier instant.
 */
export interface DueRule {
  readonly kind: DueValueKind;
  readonly offsetMinutes: number;
  /** `HH:MM`, date values only; `null` = `09:00`. */
  readonly timeOfDay: string | null;
  /** IANA zone of date values. */
  readonly timeZone: string;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The instant (epoch ms) a value is reached at, or `null` for a value that is not a date. */
export function dueAt(rule: DueRule, value: string): number | null {
  const offset = rule.offsetMinutes * MINUTE_MS;
  if (rule.kind === 'instant') {
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : at + offset;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const [hour, minute] = (rule.timeOfDay ?? DEFAULT_DUE_TIME_OF_DAY).split(':').map(Number) as [
    number,
    number,
  ];
  return (
    wallTimeToEpoch(
      {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour,
        minute,
        second: 0,
        millisecond: 0,
      },
      rule.timeZone,
    ) + offset
  );
}

function isoDate(epochMs: number, timeZone: string): string {
  const wall = toWallTime(epochMs, timeZone);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/**
 * The column range holding every value reached within `(from, to]` (epoch
 * ms): exact for `instant` values; for `date` values a day wider on each
 * side (zone offsets, DST), so callers keep only the rows whose
 * {@link dueAt} falls in the window.
 */
export function valueRangeOf(
  rule: DueRule,
  from: number,
  to: number,
): { readonly lower: DueBound; readonly upper: string } {
  const offset = rule.offsetMinutes * MINUTE_MS;
  if (rule.kind === 'instant') {
    return {
      lower: { value: new Date(from - offset).toISOString(), inclusive: false },
      upper: new Date(to - offset).toISOString(),
    };
  }
  return {
    lower: { value: isoDate(from - offset - DAY_MS, rule.timeZone), inclusive: true },
    upper: isoDate(to - offset + DAY_MS, rule.timeZone),
  };
}

/** The first valid IANA zone of `candidates` (field, organization, instance default). */
export function firstTimeZone(...candidates: readonly unknown[]): string {
  for (const zone of candidates) {
    if (typeof zone === 'string' && isValidTimeZone(zone)) return zone;
  }
  return 'UTC';
}
