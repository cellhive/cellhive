/**
 * Metrics of the outbound HTTP outbox (ADR-35 §4, SPEC §19, BACKLOG T605),
 * kept in the process without a metrics library (like
 * `net/metrics.ts`): `http_deliveries_total{outcome}` and
 * `http_delivery_duration_seconds` (one observation per call that reached
 * the network). Labels never carry a host, an organization or a user. The
 * backlog gauge `http_delivery_oldest_pending_seconds` is read from the
 * database instead (`measureHttpDeliveryBacklog`), so any process can
 * expose it.
 */

/**
 * `succeeded` / `failed` (final), `retry` (a temporary failure, tried
 * again later), `deferred` (the pacer said wait — not an attempt).
 */
export const HTTP_DELIVERY_OUTCOMES = ['succeeded', 'failed', 'retry', 'deferred'] as const;
export type HttpDeliveryOutcomeLabel = (typeof HTTP_DELIVERY_OUTCOMES)[number];

/** Upper bounds (seconds) of the duration histogram; the call times out at 10 s. */
export const HTTP_DELIVERY_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

const outcomes = new Map<HttpDeliveryOutcomeLabel, number>(
  HTTP_DELIVERY_OUTCOMES.map((outcome) => [outcome, 0]),
);
const bucketCounts = HTTP_DELIVERY_DURATION_BUCKETS.map(() => 0);
let durationCount = 0;
let durationSum = 0;

export function recordHttpDeliveryOutcome(outcome: HttpDeliveryOutcomeLabel): void {
  outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
}

export function observeHttpDeliveryDuration(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  durationCount += 1;
  durationSum += seconds;
  HTTP_DELIVERY_DURATION_BUCKETS.forEach((bound, index) => {
    if (seconds <= bound) bucketCounts[index] = (bucketCounts[index] ?? 0) + 1;
  });
}

/**
 * `http_secret_host_blocked_total{reason}` (T701, ADR-36 §4): deliveries
 * refused because the URL's host is not an allowed host of their auth or
 * signing secret (`not_listed`), or the transition period of a secret
 * without a list is over (`legacy_expired`). Never a host or tenant label.
 */
export const SECRET_HOST_BLOCK_REASONS = ['not_listed', 'legacy_expired'] as const;
export type SecretHostBlockReason = (typeof SECRET_HOST_BLOCK_REASONS)[number];

const secretHostBlocks = new Map<SecretHostBlockReason, number>(
  SECRET_HOST_BLOCK_REASONS.map((reason) => [reason, 0]),
);

export function recordSecretHostBlocked(reason: SecretHostBlockReason): void {
  secretHostBlocks.set(reason, (secretHostBlocks.get(reason) ?? 0) + 1);
}

/** Blocks so far in this process, per reason (every reason present). */
export function secretHostBlockedCounts(): ReadonlyMap<SecretHostBlockReason, number> {
  return new Map(secretHostBlocks);
}

/**
 * `http_deliveries_rescued_total` (T702, ADR-36 §5): `http.deliver` jobs
 * added again by the cron `http.deliveries_rescue` for deliveries whose
 * job was lost. No label.
 */
let rescued = 0;

export function recordHttpDeliveriesRescued(count: number): void {
  if (Number.isInteger(count) && count > 0) rescued += count;
}

/** Rescues so far in this process. */
export function httpDeliveriesRescuedCount(): number {
  return rescued;
}

export interface HttpDeliveryMetricsSnapshot {
  readonly outcomes: ReadonlyMap<HttpDeliveryOutcomeLabel, number>;
  /** Cumulative counts per bucket bound (`le`), as Prometheus expects. */
  readonly durationBuckets: readonly { readonly le: number; readonly count: number }[];
  readonly durationCount: number;
  readonly durationSum: number;
}

/** Counts so far in this process (every outcome present). */
export function httpDeliveryMetrics(): HttpDeliveryMetricsSnapshot {
  return {
    outcomes: new Map(outcomes),
    durationBuckets: HTTP_DELIVERY_DURATION_BUCKETS.map((le, index) => ({
      le,
      count: bucketCounts[index] ?? 0,
    })),
    durationCount,
    durationSum,
  };
}
