import { SSRF_BLOCK_REASONS, type SsrfBlockReason } from './errors.js';

/**
 * `http_ssrf_blocked_total{reason}` (ADR-35 §3, SPEC §19): outbound calls
 * refused by the SSRF guard in this process. Kept here without a metrics
 * library so `server-core` stays dependency-free; the process exposing
 * `/metrics` reads {@link ssrfBlockedCounts} when scraped (the API's
 * `MetricsService`). Labels are the reason only — never a host or tenant.
 */
const counts = new Map<SsrfBlockReason, number>(SSRF_BLOCK_REASONS.map((reason) => [reason, 0]));

export function recordSsrfBlocked(reason: SsrfBlockReason): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

/** Blocks so far in this process, per reason (every reason present). */
export function ssrfBlockedCounts(): ReadonlyMap<SsrfBlockReason, number> {
  return new Map(counts);
}
