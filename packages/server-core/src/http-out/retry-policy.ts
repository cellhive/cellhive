import {
  HTTP_DELIVERY_MAX_ATTEMPTS,
  HTTP_DELIVERY_MAX_RETRY_AFTER_MS,
  HTTP_DELIVERY_RETRY_DELAYS_MS,
  HTTP_DELIVERY_RETRY_JITTER,
  isTemporaryHttpStatus,
  type HttpDeliveryStepErrorCode,
} from '@cellhive/contracts';

import { TEMPORARY_UNRESOLVABLE_CAUSES, type OutboundErrorCode } from '../net/errors.js';

/**
 * Retry policy of the outbound HTTP outbox (ADR-35 §4, "Quyết định S5c"
 * #3, CONTRACTS §25.5) — pure, the clock and randomness are passed in:
 *
 * - six attempts: immediately, then after 10 s, 1 min, 5 min, 15 min,
 *   30 min, each delay ± 20 % jitter;
 * - temporary: network failure, timeout, a name the resolver could not
 *   answer for now (`ssrf_blocked` `unresolvable` with `cause` `timeout` /
 *   `temporary` — QA S5c), `408`, `425`, `429`, `5xx` but `501`;
 *   permanent: other `ssrf_blocked`, a response too large, `3xx`
 *   (redirects are never followed), other `4xx` (`410` included: the
 *   endpoint is gone), `501`;
 * - `Retry-After` (seconds or an HTTP date) of a `429`/`503`: at most one
 *   hour → the next attempt is the later of the schedule and that time, and
 *   the (organization, host) pauses until then; longer → `rate_limited`.
 */

/** What one attempt ended with. */
export type DeliveryAttemptResult =
  | {
      readonly kind: 'response';
      readonly status: number;
      /** Raw `Retry-After` header, if any. */
      readonly retryAfter?: string | null;
    }
  | {
      readonly kind: 'error';
      readonly code: OutboundErrorCode;
      readonly params?: Readonly<Record<string, string | number>>;
    };

/** Code and params of a failure (stored as `last_error`, and on the step when final). */
export interface DeliveryFailure {
  readonly code: HttpDeliveryStepErrorCode;
  readonly params: Readonly<Record<string, string | number>>;
}

export type RetryDecision =
  | { readonly action: 'succeed' }
  | {
      readonly action: 'retry';
      readonly at: Date;
      /** Pause every call of the organization to this host until then (`Retry-After`). */
      readonly pauseUntil: Date | null;
      /** Why this attempt failed. */
      readonly failure: DeliveryFailure;
    }
  | { readonly action: 'fail'; readonly failure: DeliveryFailure };

export interface RetryInput {
  readonly result: DeliveryAttemptResult;
  /** 1-based number of the attempt that just ended. */
  readonly attempt: number;
  readonly now: Date;
  /** `[0, 1)`; the jitter. */
  readonly random: () => number;
  readonly maxAttempts?: number;
}

const HTTP_DATE_MAX_LENGTH = 64;
const DIGITS = /^[0-9]{1,10}$/u;

/**
 * The instant a `Retry-After` value asks for, or `null` when it is missing
 * or invalid: delta-seconds (`120`) or an HTTP date
 * (`Wed, 21 Oct 2026 07:28:00 GMT`); a date in the past means "now".
 */
export function parseRetryAfter(value: string | null | undefined, now: Date): Date | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (text === '') return null;
  if (DIGITS.test(text)) return new Date(now.getTime() + Number(text) * 1000);
  if (text.length > HTTP_DATE_MAX_LENGTH || !/[a-z]/iu.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return new Date(Math.max(at, now.getTime()));
}

/**
 * Base delay before attempt `attempt + 1` with ± 20 % jitter, or `null`
 * when `attempt` was the last one.
 */
export function retryDelayAfter(
  attempt: number,
  random: () => number,
  maxAttempts = HTTP_DELIVERY_MAX_ATTEMPTS,
): number | null {
  if (attempt >= maxAttempts) return null;
  const base = HTTP_DELIVERY_RETRY_DELAYS_MS[attempt - 1];
  if (base === undefined) return null;
  const r = Math.min(Math.max(random(), 0), 0.999_999);
  return Math.round(base * (1 + (r * 2 - 1) * HTTP_DELIVERY_RETRY_JITTER));
}

function failureOf(result: DeliveryAttemptResult): DeliveryFailure {
  if (result.kind === 'response') return { code: 'http_status', params: { status: result.status } };
  return { code: result.code, params: { ...(result.params ?? {}) } };
}

function isTemporary(result: DeliveryAttemptResult): boolean {
  if (result.kind === 'response') return isTemporaryHttpStatus(result.status);
  if (result.code === 'ssrf_blocked') {
    const cause = result.params?.['cause'];
    return (
      result.params?.['reason'] === 'unresolvable' &&
      typeof cause === 'string' &&
      TEMPORARY_UNRESOLVABLE_CAUSES.has(cause)
    );
  }
  return result.code === 'http_timeout' || result.code === 'http_network';
}

/** What to do after an attempt (see the module comment). */
export function decideRetry(input: RetryInput): RetryDecision {
  const { result, attempt, now } = input;
  if (result.kind === 'response' && result.status >= 200 && result.status <= 299) {
    return { action: 'succeed' };
  }
  const failure = failureOf(result);
  if (!isTemporary(result)) return { action: 'fail', failure };

  let pauseUntil: Date | null = null;
  if (result.kind === 'response' && (result.status === 429 || result.status === 503)) {
    const asked = parseRetryAfter(result.retryAfter, now);
    if (asked !== null) {
      const waitMs = asked.getTime() - now.getTime();
      if (waitMs > HTTP_DELIVERY_MAX_RETRY_AFTER_MS) {
        return {
          action: 'fail',
          failure: {
            code: 'rate_limited',
            params: { status: result.status, retry_after_s: Math.ceil(waitMs / 1000) },
          },
        };
      }
      if (waitMs > 0) pauseUntil = asked;
    }
  }
  const delay = retryDelayAfter(attempt, input.random, input.maxAttempts);
  if (delay === null) {
    return {
      action: 'fail',
      failure: { ...failure, params: { ...failure.params, attempts: attempt } },
    };
  }
  const scheduled = now.getTime() + delay;
  const at = new Date(Math.max(scheduled, pauseUntil?.getTime() ?? 0));
  return { action: 'retry', at, pauseUntil, failure };
}
