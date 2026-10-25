import type { FieldConversionState, FieldDto } from '@cellhive/contracts';

/**
 * Type conversions of fields as the field list reports them (`conversion`,
 * CONTRACTS §4.4; T414). Shared by the grid (locked column, banners), the
 * record panel (read-only field), the view toolbar and the field dialogs.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A conversion of the field is running: its schema is locked (`409 SCHEMA_LOCKED`). */
export function isFieldConverting(field: Pick<FieldDto, 'conversion'>): boolean {
  return field.conversion?.status === 'running';
}

/**
 * Its values are being converted: they show the old definition, read-only
 * (BACKLOG S4 design decision #8). Link conversions keep taking record
 * writes (the junction keeps its structure, CONTRACTS §4.4).
 */
export function locksFieldValues(field: Pick<FieldDto, 'conversion'>): boolean {
  return isFieldConverting(field) && field.conversion?.link_change === undefined;
}

/** Whole days left before `until` (at least 1 while not past), `0` once past. */
export function daysLeft(until: string, now: number = Date.now()): number {
  const left = Date.parse(until) - now;
  if (!Number.isFinite(left) || left <= 0) return 0;
  return Math.ceil(left / DAY_MS);
}

/** The last conversion of the field while it can still be undone (7 days), else `null`. */
export function revertibleConversion(
  field: Pick<FieldDto, 'conversion'>,
  now: number = Date.now(),
): FieldConversionState | null {
  const conversion = field.conversion;
  if (conversion === null || conversion === undefined) return null;
  if (conversion.status !== 'succeeded') return null;
  return daysLeft(conversion.revertible_until, now) > 0 ? conversion : null;
}
