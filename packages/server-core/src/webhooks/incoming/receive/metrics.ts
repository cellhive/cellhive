import type { CausationTokenFailure } from '../../../automation/causation/token.js';

/**
 * Counters of the incoming webhook route (BACKLOG T603, SPEC §19), kept
 * without a metrics library like `net/metrics.ts`; the API's
 * `MetricsService` reads them when `/metrics` is scraped. Labels are the
 * outcome or the rejection reason only — never a hook, base or tenant.
 */

/** `webhook_requests_total{result}`. */
export const WEBHOOK_REQUEST_RESULTS = [
  'accepted',
  'duplicate',
  'unauthorized',
  'rate_limited',
  'too_large',
  'unsupported',
  'malformed',
  'not_found',
  'unavailable',
] as const;
export type WebhookRequestResult = (typeof WEBHOOK_REQUEST_RESULTS)[number];

/** `automation_causation_rejected_total{reason}` (ADR-27, CONTRACTS §10). */
export const CAUSATION_REJECTION_REASONS = [
  'malformed',
  'bad_tag',
  'expired',
  'target_mismatch',
] as const satisfies readonly CausationTokenFailure[];

const requests = new Map<WebhookRequestResult, number>(
  WEBHOOK_REQUEST_RESULTS.map((result) => [result, 0]),
);
const rejections = new Map<CausationTokenFailure, number>(
  CAUSATION_REJECTION_REASONS.map((reason) => [reason, 0]),
);

export function recordWebhookRequest(result: WebhookRequestResult): void {
  requests.set(result, (requests.get(result) ?? 0) + 1);
}

export function recordCausationRejected(reason: CausationTokenFailure): void {
  rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
}

/** Requests so far in this process, per result (every result present). */
export function webhookRequestCounts(): ReadonlyMap<WebhookRequestResult, number> {
  return new Map(requests);
}

/** Causation tokens rejected so far in this process, per reason (every reason present). */
export function causationRejectedCounts(): ReadonlyMap<CausationTokenFailure, number> {
  return new Map(rejections);
}
