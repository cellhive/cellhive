import { isApiError } from '../api/client';

import { REASONS } from './model';

import type { ButtonDisabledReason } from '@cellhive/contracts';

/**
 * Clicks of button fields (T525, CONTRACTS §21 "Button"): what a refused
 * click means for the user, and how a finished run reads.
 */

/** What a refused click means for the user (CONTRACTS §21 "Kiểm theo thứ tự"). */
export type ClickFailure =
  /** `429`: `seconds` from `Retry-After` (≥ 1). */
  | { readonly kind: 'rate_limited'; readonly seconds: number }
  /** `422 BUTTON_DISABLED`: the state changed since the cell was read. */
  | { readonly kind: 'disabled'; readonly reason: ButtonDisabledReason }
  /** `403`: below `min_permission`. */
  | { readonly kind: 'permission' }
  /** `404`: the record, the field or the table is gone for the user. */
  | { readonly kind: 'gone' }
  | { readonly kind: 'error' };

/** Wait when a `429` has no usable `Retry-After`. */
const DEFAULT_RETRY_SECONDS = 60;

export function clickFailureOf(error: unknown): ClickFailure {
  if (!isApiError(error)) return { kind: 'error' };
  if (error.status === 429) {
    const seconds = error.retry_after;
    return {
      kind: 'rate_limited',
      seconds:
        seconds === undefined || !Number.isFinite(seconds)
          ? DEFAULT_RETRY_SECONDS
          : Math.max(1, Math.ceil(seconds)),
    };
  }
  if (error.status === 404) return { kind: 'gone' };
  if (error.status === 403) return { kind: 'permission' };
  if (error.status === 422) {
    const detail = error.errors.find((item) => item.code === 'BUTTON_DISABLED');
    const reason = detail?.params?.['reason'];
    if (detail !== undefined) {
      return {
        kind: 'disabled',
        reason:
          typeof reason === 'string' && REASONS.has(reason)
            ? (reason as ButtonDisabledReason)
            : 'condition',
      };
    }
  }
  return { kind: 'error' };
}

/** Statuses `automation.run.finished` carries. */
export type FinishedStatus = 'succeeded' | 'failed' | 'skipped' | 'cancelled';

/** Toast variant of a finished run (board "Kết quả và giới hạn"). */
export function finishedVariant(status: FinishedStatus): 'success' | 'error' | 'info' {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'error';
  return 'info';
}
