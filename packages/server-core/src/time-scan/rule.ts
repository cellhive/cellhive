import { dueValueKindOf, type DueFieldLike } from '../records/due/due-scan.js';

import { firstTimeZone, type DueRule } from './due.js';

/** When a consumer fires relative to the date value (trigger config, reminder option). */
export interface DueTiming {
  /** −43 200 … 43 200 (validated by the consumer's contract). */
  readonly offsetMinutes: number;
  /** `HH:MM` for date-only values; `null` = `09:00`. */
  readonly timeOfDay: string | null;
}

/**
 * The due rule of a date field (ADR-21, ADR-34 §1): its value kind
 * (`dueValueKindOf`) and, for date-only values, the zone they are read in —
 * the field's own `options.timezone`, else the organization's, else the
 * instance default, else `UTC` (the first valid IANA zone). `null` when the
 * field cannot be scanned (not a date, a virtual formula/lookup, a list).
 * Pure.
 */
export function dueRuleOf(
  field: DueFieldLike,
  timing: DueTiming,
  zones: { readonly organization: unknown; readonly fallback: string },
): DueRule | null {
  const kind = dueValueKindOf(field);
  if (kind === null) return null;
  return {
    kind,
    offsetMinutes: timing.offsetMinutes,
    timeOfDay: timing.timeOfDay,
    timeZone: firstTimeZone(fieldTimeZone(field.options), zones.organization, zones.fallback),
  };
}

function fieldTimeZone(options: unknown): unknown {
  return typeof options === 'object' && options !== null && !Array.isArray(options)
    ? (options as Record<string, unknown>)['timezone']
    : undefined;
}
