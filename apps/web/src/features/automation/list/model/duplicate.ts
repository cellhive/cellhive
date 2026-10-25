/**
 * Why duplicating an automation failed (T556; CONTRACTS §21 "Nhân bản",
 * T551), so the screen can explain it rather than only name an error code.
 * Pure: reads the problem fields only.
 */

/** The parts of an API error read here (`ApiError` of `lib/api/client`). */
export interface DuplicateProblem {
  readonly status: number;
  readonly code: string;
  readonly errors: readonly {
    readonly code: string;
    readonly params?: Readonly<Record<string, unknown>> | undefined;
  }[];
}

export type DuplicateFailure =
  /** `BUTTON_IN_USE` with `params.reason = duplicate`: a button runs only one automation. */
  | 'button'
  /**
   * `AUTOMATION_INVALID` because the copy runs with the caller's permissions
   * and the source uses tables, fields, views or senders outside them (P43).
   */
  | 'permissions'
  /** Another `422`: the source's definition no longer saves (e.g. a missing email image). */
  | 'invalid'
  /** `403`: visible but no longer managed by the caller. */
  | 'forbidden'
  /** `404`: deleted, or no longer visible. */
  | 'gone'
  | 'other';

/** Detail codes of `AUTOMATION_INVALID` that mean "outside the caller's permissions". */
const PERMISSION_CODES = new Set([
  'PERMISSION_DENIED',
  'UNKNOWN_TABLE',
  'UNKNOWN_FIELD',
  'UNKNOWN_VIEW',
  'FIELD_READ_ONLY',
  'EMAIL_IDENTITY_NOT_USABLE',
]);

export function duplicateFailureOf(problem: DuplicateProblem): DuplicateFailure {
  if (problem.status === 404) return 'gone';
  if (problem.status === 403) return 'forbidden';
  if (problem.status !== 422) return 'other';
  if (
    problem.errors.some(
      (item) => item.code === 'BUTTON_IN_USE' && item.params?.['reason'] === 'duplicate',
    )
  ) {
    return 'button';
  }
  if (problem.errors.some((item) => PERMISSION_CODES.has(item.code))) return 'permissions';
  return 'invalid';
}
