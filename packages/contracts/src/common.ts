import { z } from 'zod';

/**
 * ISO 8601 timestamp in UTC with a `Z` suffix (CONTRACTS §1.1), e.g.
 * `2026-09-20T03:15:00.000Z`. Offsets such as `+07:00` are rejected.
 */
export const isoDateTimeSchema = z.iso
  .datetime({ offset: false, local: false })
  .meta({ description: 'ISO 8601 UTC timestamp', example: '2026-09-20T03:15:00.000Z' });

/** Calendar date without time (`YYYY-MM-DD`). */
export const isoDateSchema = z.iso
  .date()
  .meta({ description: 'Calendar date (YYYY-MM-DD)', example: '2026-09-20' });

/** Serializes a Date the way the API emits timestamps (always UTC, millisecond precision). */
/** A boolean query-string parameter: `true`/`1` or `false`/`0`. */
export const booleanQueryParam = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export function toIsoDateTime(date: Date): string {
  return date.toISOString();
}
