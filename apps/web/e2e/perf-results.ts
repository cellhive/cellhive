import { expect, test, type Browser } from '@playwright/test';

/**
 * Numbers of the `@perf` specs (FRONTEND §11.1, BACKLOG T801) and their
 * budgets (T900). A spec calls `recordPerf` before its `expect`s, so a red
 * budget still has its number; `perf-reporter.ts` gathers them into
 * `perf-results.json`.
 */

/** Name of the test attachment the reporter reads. */
export const PERF_ATTACHMENT = 'perf-metrics';

/**
 * Budget profile (FRONTEND §11.1, two tiers since T820): `product` is the
 * user-facing target and the default; `ci-runner` is the regression bound of
 * the 2-core `ubuntu-latest` runner that `perf.yml` sets (`PERF_PROFILE`).
 */
export type PerfProfile = 'product' | 'ci-runner';

function profileFromEnv(): PerfProfile {
  const value = process.env['PERF_PROFILE'] || 'product';
  if (value !== 'product' && value !== 'ci-runner') {
    throw new Error(`PERF_PROFILE must be product or ci-runner, got '${value}'`);
  }
  return value;
}

export const PERF_PROFILE = profileFromEnv();

interface Budget {
  unit: 'ms' | '%';
  /** FRONTEND §11.1 / S§21, never changed here: the value must stay below it. */
  product: number | null;
  /** Regression bound of the runner: the value must not exceed it. */
  'ci-runner': number | null;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** Runner bound of a timing (T820): max(product, max(baseline) × 1.25), rounded up to 50 ms. */
const timing = (product: number, baselineMax: number): Budget => ({
  unit: 'ms',
  product,
  'ci-runner': Math.max(product, Math.ceil((baselineMax * 1.25) / 50) * 50),
});

/**
 * The one budget table of the `@perf` specs (FRONTEND §11.1 lists the same
 * numbers); `null` = recorded only. Timings: `timing(product, slowest run of
 * the baseline on main)` — baseline runs in F§11.1; a runner bound changes
 * only in a commit that cites its baseline runs, never automatically.
 * Frames > 32 ms: the product bound covers the whole scroll; on the runner
 * the `steady` phase is only recorded (software rendering on 2 cores,
 * 14–36 % after settling) and `jump` / `back` must stay ≤ 10 %. t422 and
 * t468 scroll once at a steady pace, so the runner records their frames only.
 */
export const PERF_BUDGETS = {
  't202 first data': timing(1_500, 1_506),
  't312 first data': timing(1_500, 2_021),
  't314 first cards': timing(1_500, 1_975),
  't413 picker first candidates': timing(500, 333),
  't417 roots first data': timing(1_500, 1_551),
  't417 branch opens': timing(300, 141),
  't422 first data': timing(1_500, 1_425),
  't468 first data': timing(1_500, 1_512),
  't818 dashboard data': timing(2_000, 2_567),
  'frames > 32 ms': { unit: '%', product: 5, 'ci-runner': null },
  'steady frames > 32 ms': { unit: '%', product: null, 'ci-runner': null },
  'jump frames > 32 ms': { unit: '%', product: null, 'ci-runner': 10 },
  'back frames > 32 ms': { unit: '%', product: null, 'ci-runner': 10 },
} satisfies Record<string, Budget>;

export type BudgetName = keyof typeof PERF_BUDGETS;

export interface PerfMetric {
  value: number;
  unit: 'ms' | '%';
  /** Bound of the active profile the spec asserts, when there is one. */
  budget?: number;
  /** Both profiles' bounds (`null` = recorded only), for the job summary. */
  budgets?: Record<PerfProfile, number | null>;
}

export interface PerfAttachment {
  browser: string;
  metrics: Record<string, PerfMetric>;
  /** Anything else worth keeping (frame stats per scroll phase…). */
  details?: unknown;
}

/** A number of `PERF_BUDGETS` (rounded as recorded) with the bounds of both profiles. */
export function budgeted(name: BudgetName, value: number): PerfMetric {
  const row: Budget = PERF_BUDGETS[name];
  const bound = row[PERF_PROFILE];
  return {
    value: row.unit === 'ms' ? Math.round(value) : round(value),
    unit: row.unit,
    ...(bound === null ? {} : { budget: bound }),
    budgets: { product: row.product, 'ci-runner': row['ci-runner'] },
  };
}

/** Product bounds are strict ("< 1.5 s", S§21); runner bounds are maxima (≤). */
export function withinBudget(value: number, bound: number, profile = PERF_PROFILE): boolean {
  return profile === 'product' ? value < bound : value <= bound;
}

/** Asserts every recorded metric that has a bound in the active profile. */
export function expectBudgets(metrics: Record<string, PerfMetric>): void {
  for (const [name, metric] of Object.entries(metrics)) {
    if (metric.budget === undefined) continue;
    const message = `${name}: ${String(metric.value)} ${metric.unit}, ${PERF_PROFILE} budget ${PERF_PROFILE === 'product' ? '<' : '≤'} ${String(metric.budget)}`;
    expect(withinBudget(metric.value, metric.budget), message).toBe(true);
  }
}

export interface FrameStats {
  frames: number;
  long: number;
  ratio: number;
  p50: number;
  p95: number;
  max: number;
}

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

/** The numbers of one scroll: share of frames > 32 ms (`PERF_BUDGETS`), p50, p95. */
export function frameMetrics(stats: FrameStats): Record<string, PerfMetric> {
  return {
    'frames > 32 ms': budgeted('frames > 32 ms', stats.ratio * 100),
    'frames p50': { value: stats.p50, unit: 'ms' },
    'frames p95': { value: stats.p95, unit: 'ms' },
  };
}

/** A scroll in three phases (T202 harness): the whole scroll, then each phase's share. */
export function phaseFrameMetrics(phases: {
  steady: FrameStats;
  jump: FrameStats;
  back: FrameStats;
  all: FrameStats;
}): Record<string, PerfMetric> {
  return {
    ...frameMetrics(phases.all),
    'steady frames > 32 ms': budgeted('steady frames > 32 ms', phases.steady.ratio * 100),
    'jump frames > 32 ms': budgeted('jump frames > 32 ms', phases.jump.ratio * 100),
    'back frames > 32 ms': budgeted('back frames > 32 ms', phases.back.ratio * 100),
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
