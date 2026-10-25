import type { PerfMetric } from './perf-results';
import type { Page, Request } from '@playwright/test';

/**
 * "Settled" condition of the `@perf` grid specs (FRONTEND §11.1, BACKLOG T818
 * follow-up): the frame-time budget is about steady scrolling, so the first
 * scroll phase (`steady`) starts only once the page has stopped working on its
 * own start-up (lazy chunks, the first blocks of rows, the realtime socket,
 * thumbnails, JIT warm-up). Runs 40147573116 / 40177286397 / 40214587132 had
 * almost all their long frames in `steady` (28–31 % on EPYC) and 0–2 % in
 * `jump` / `back`: scrolling began right after `app:grid:first-data`.
 *
 * The condition is fixed, in this order:
 * 1. **network quiet**: no HTTP request of the page in flight for
 *    `NETWORK_QUIET_MS` in a row (WebSocket frames are not requests);
 * 2. **fonts** loaded (`document.fonts.ready`);
 * 3. **idle**: one `requestIdleCallback` runs (the main thread had nothing queued);
 * 4. **quiet frames**: `QUIET_FRAMES` animation frames in a row with no
 *    `long-animation-frame` (or `longtask`) entry — no layout/script work ≥ 50 ms.
 *
 * Honesty rules: it only *waits* before sampling, never drops a sample once
 * sampling has begun, and the first-data metric is still read cold (before
 * this). When a step does not happen within its timeout the spec measures
 * anyway — exactly the old behaviour — and the report says `settled: false`
 * with the step that timed out, so a red number is never hidden behind a
 * longer wait. Every spec puts the report in its `details` and the wait in
 * the metric `settle before steady`.
 */

export const NETWORK_QUIET_MS = 500;
export const NETWORK_TIMEOUT_MS = 30_000;
export const IDLE_TIMEOUT_MS = 10_000;
export const QUIET_FRAMES = 10;
export const FRAMES_TIMEOUT_MS = 10_000;

export interface NetworkWatch {
  /** Requests started and not yet finished or failed. */
  inFlight: () => number;
  /** `<resource type> <path>` of the requests in flight (no query string). */
  pendingPaths: () => string[];
  /** `performance.now()`-like time (ms, Node clock) of the last start or end. */
  lastActivity: () => number;
}

/**
 * Tracks the page's HTTP requests; call it right after `newPage()` so that the
 * first navigation's requests are counted too.
 */
const watches = new WeakMap<Page, NetworkWatch>();

export function watchNetwork(page: Page): NetworkWatch {
  const pending = new Set<Request>();
  let last = Date.now();
  page.on('request', (request) => {
    pending.add(request);
    last = Date.now();
  });
  const done = (request: Request) => {
    pending.delete(request);
    last = Date.now();
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  // A navigation cancels the old document's requests without a `requestfailed`
  // (seen: fonts and API calls of `/` stayed "in flight" after `goto(gridPath)`):
  // when the main frame commits a new document, only its navigation can still be
  // pending from before.
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    for (const request of pending) {
      if (!request.isNavigationRequest()) pending.delete(request);
    }
    last = Date.now();
  });
  const watch = {
    inFlight: () => pending.size,
    pendingPaths: () =>
      [...pending].map((request) => `${request.resourceType()} ${new URL(request.url()).pathname}`),
    lastActivity: () => last,
  };
  watches.set(page, watch);
  return watch;
}

export interface SettleReport {
  settled: boolean;
  /** The step that timed out, when `settled` is false. */
  timed_out?: 'network' | 'idle' | 'frames';
  /** Total wait before sampling (ms). */
  wait_ms: number;
  network_ms: number;
  idle_ms: number;
  frames_ms: number;
  /** Long animation frames (or long tasks) seen while waiting for quiet frames. */
  long_frames_seen: number;
  /** Requests still in flight when the network step timed out. */
  pending?: string[];
}

async function networkQuiet(watch: NetworkWatch): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const now = Date.now();
    if (watch.inFlight() === 0 && now - watch.lastActivity() >= NETWORK_QUIET_MS) return true;
    if (now - started > NETWORK_TIMEOUT_MS) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Waits for the settled condition above; returns what it waited, for the report. */
export async function settleBeforeSampling(page: Page, watch: NetworkWatch): Promise<SettleReport> {
  const started = Date.now();
  const network = await networkQuiet(watch);
  const networkMs = Date.now() - started;
  const inPage = await page.evaluate(
    async ([idleTimeout, quietFrames, framesTimeout]) => {
      await document.fonts.ready;
      const idleStarted = performance.now();
      const idle = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(false);
        }, idleTimeout);
        requestIdleCallback(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      const idleMs = performance.now() - idleStarted;
      const framesStarted = performance.now();
      let longSeen = 0;
      let longSinceFrame = 0;
      const type = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
        ? 'long-animation-frame'
        : 'longtask';
      const observer = new PerformanceObserver((list) => {
        const count = list.getEntries().length;
        longSeen += count;
        longSinceFrame += count;
      });
      observer.observe({ type, buffered: false });
      const frames = await new Promise<boolean>((resolve) => {
        let quiet = 0;
        const frame = () => {
          if (longSinceFrame > 0) quiet = 0;
          else quiet += 1;
          longSinceFrame = 0;
          if (quiet >= quietFrames) resolve(true);
          else if (performance.now() - framesStarted > framesTimeout) resolve(false);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      observer.disconnect();
      return { idle, idleMs, frames, framesMs: performance.now() - framesStarted, longSeen };
    },
    [IDLE_TIMEOUT_MS, QUIET_FRAMES, FRAMES_TIMEOUT_MS] as const,
  );
  const timedOut = !network ? 'network' : !inPage.idle ? 'idle' : !inPage.frames ? 'frames' : null;
  return {
    settled: timedOut === null,
    ...(timedOut === null ? {} : { timed_out: timedOut }),
    wait_ms: Date.now() - started,
    network_ms: networkMs,
    idle_ms: Math.round(inPage.idleMs),
    frames_ms: Math.round(inPage.framesMs),
    long_frames_seen: inPage.longSeen,
    ...(network ? {} : { pending: watch.pendingPaths() }),
  };
}

/**
 * Waits for the settled condition on a page given to `watchNetwork` and logs
 * it (`[perf] <label> settle: …`).
 */
export async function settle(page: Page, label: string): Promise<SettleReport> {
  const watch = watches.get(page);
  if (watch === undefined) throw new Error('settle(): call watchNetwork(page) after newPage()');
  const report = await settleBeforeSampling(page, watch);
  process.stdout.write(`[perf] ${label} settle: ${JSON.stringify(report)}\n`);
  return report;
}

/** The wait as a metric of the job summary (no budget: it is not a measurement). */
export function settleMetric(report: SettleReport): Record<string, PerfMetric> {
  return { 'settle before steady': { value: report.wait_ms, unit: 'ms' } };
}
