import type { AiFeature } from '@cellhive/contracts';

/**
 * AI metrics of this process (research S8 §4.9, SPEC §19), kept without a
 * metrics library like the other `server-core` counters; the API's
 * `MetricsService` reads them when scraped and observes the request
 * duration through {@link observeAiDurations}. Labels are the feature, the
 * outcome and the token kind only — never an organization, user or field.
 */

/** `ok`, or the error code of a failed AI request (`AI_PROVIDER_ERROR`, `AI_TIMEOUT`…). */
export type AiRequestStatus = string;

export interface AiRequestOutcome {
  readonly feature: AiFeature;
  readonly status: AiRequestStatus;
  readonly durationMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Calls made (1 + repair rounds). */
  readonly attempts: number;
}

const requests = new Map<string, number>();
const tokens = new Map<string, number>();
const retries = new Map<AiFeature, number>();
let quotaExhausted = 0;
let durationObserver: ((feature: AiFeature, seconds: number) => void) | null = null;

const add = <K>(map: Map<K, number>, key: K, count: number) => {
  map.set(key, (map.get(key) ?? 0) + count);
};

/** One AI request (interactive, a batch or an action step) and its tokens. */
export function recordAiRequest(outcome: AiRequestOutcome): void {
  add(requests, `${outcome.feature}\u0000${outcome.status}`, 1);
  add(tokens, `${outcome.feature}\u0000prompt`, outcome.promptTokens);
  add(tokens, `${outcome.feature}\u0000completion`, outcome.completionTokens);
  if (outcome.attempts > 1) add(retries, outcome.feature, outcome.attempts - 1);
  durationObserver?.(outcome.feature, outcome.durationMs / 1000);
}

/** A call refused because the daily token quota was used up. */
export function recordAiQuotaExhausted(): void {
  quotaExhausted += 1;
}

/** The process exposing `/metrics` observes durations in its histogram. */
export function observeAiDurations(
  observer: ((feature: AiFeature, seconds: number) => void) | null,
): void {
  durationObserver = observer;
}

const split = (key: string): [string, string] => {
  const at = key.indexOf('\u0000');
  return [key.slice(0, at), key.slice(at + 1)];
};

/** `ai_requests_total{feature, status}` so far in this process. */
export function aiRequestCounts(): { feature: string; status: string; count: number }[] {
  return [...requests].map(([key, count]) => {
    const [feature, status] = split(key);
    return { feature, status, count };
  });
}

/** `ai_tokens_total{feature, kind}` so far in this process. */
export function aiTokenCounts(): { feature: string; kind: string; count: number }[] {
  return [...tokens].map(([key, count]) => {
    const [feature, kind] = split(key);
    return { feature, kind, count };
  });
}

/** `ai_output_retries_total{feature}`: repair rounds so far in this process. */
export function aiRetryCounts(): ReadonlyMap<AiFeature, number> {
  return retries;
}

/** `ai_quota_exhausted_total` so far in this process. */
export function aiQuotaExhaustedCount(): number {
  return quotaExhausted;
}
