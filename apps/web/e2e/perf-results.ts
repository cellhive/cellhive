import { test, type Browser } from '@playwright/test';

/**
 * Numbers of the `@perf` specs (FRONTEND §11.1, BACKLOG T801). A spec calls
 * `recordPerf` before its `expect`s, so a red budget still has its number;
 * `perf-reporter.ts` gathers them into `perf-results.json`.
 */

/** Name of the test attachment the reporter reads. */
export const PERF_ATTACHMENT = 'perf-metrics';

export interface PerfMetric {
  value: number;
  unit: 'ms' | '%';
  /** Upper bound of FRONTEND §11.1 the spec asserts, when there is one. */
  budget?: number;
}

export interface PerfAttachment {
  browser: string;
  metrics: Record<string, PerfMetric>;
  /** Anything else worth keeping (frame stats per scroll phase…). */
  details?: unknown;
}

export interface FrameStats {
  frames: number;
  long: number;
  ratio: number;
  p50: number;
  p95: number;
  max: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** Intervals between animation frames: count, share > `longMs`, p50, p95, max. */
export function frameStats(deltas: readonly number[], longMs = 32): FrameStats {
  const sorted = [...deltas].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const long = deltas.filter((delta) => delta > longMs).length;
  return {
    frames: deltas.length,
    long,
    ratio: long / Math.max(1, deltas.length),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

/** The three numbers of a scroll: share of frames > 32 ms (budget 5 %), p50, p95. */
export function frameMetrics(stats: FrameStats, prefix = 'frames'): Record<string, PerfMetric> {
  return {
    [`${prefix} > 32 ms`]: { value: round(stats.ratio * 100), unit: '%', budget: 5 },
    [`${prefix} p50`]: { value: stats.p50, unit: 'ms' },
    [`${prefix} p95`]: { value: stats.p95, unit: 'ms' },
  };
}

export async function recordPerf(
  browser: Browser,
  metrics: Record<string, PerfMetric>,
  details?: unknown,
): Promise<void> {
  const body: PerfAttachment = { browser: browser.version(), metrics, details };
  await test.info().attach(PERF_ATTACHMENT, {
    body: JSON.stringify(body),
    contentType: 'application/json',
  });
}
