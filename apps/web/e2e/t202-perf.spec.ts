import { expect, test, type Browser, type Page } from '@playwright/test';

import { frameMetrics, recordPerf } from './perf-results';
import { settle, settleMetric, watchNetwork } from './perf-settle';
import { BENCH_EMAIL, BENCH_PASSWORD, runSeed } from './seed';
import { apiSignIn } from './support';

/**
 * T202 performance budget (FRONTEND §11.1) on `seed:bench` data: 200 000
 * records × 30 fields. Tagged @perf: `pnpm test:e2e:perf` runs it (seeding
 * takes minutes), `pnpm test:e2e` skips it.
 *
 * - first data of the grid (cold cache) < 1.5 s
 * - scrolling from the first to the last row does not hang
 * - frames longer than 32 ms < 5 %
 *
 * Frames are sampled only once the page has settled after its first data
 * (`perf-settle.ts`: network quiet 500 ms, fonts, one idle callback, 10
 * animation frames without a long animation frame); the first data is still
 * read cold, before that. The wait is the metric `settle before steady`.
 */

const FIRST_DATA_MARK = 'app:grid:first-data';
const FIRST_DATA_BUDGET_MS = 1_500;
const LONG_FRAME_MS = 32;
const LONG_FRAME_BUDGET = 0.05;

interface FrameStats {
  frames: number;
  long: number;
  ratio: number;
  p50: number;
  p95: number;
  max: number;
}

function stats(deltas: readonly number[]): FrameStats {
  const sorted = [...deltas].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const long = deltas.filter((delta) => delta > LONG_FRAME_MS).length;
  return {
    frames: deltas.length,
    long,
    ratio: long / Math.max(1, deltas.length),
    p50: Math.round(at(0.5) * 10) / 10,
    p95: Math.round(at(0.95) * 10) / 10,
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
  };
}

let gridPath = '';

async function signedInPage(browser: Browser): Promise<Page> {
  // A new context: nothing cached (HTTP cache, query cache) from an earlier page.
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  watchNetwork(page);
  await apiSignIn(page, BENCH_EMAIL, BENCH_PASSWORD);
  await page.goto('/');
  await expect(page).toHaveURL(/\/o\//u);
  return page;
}

/**
 * Scrolls the grid's scroller by `step` px per animation frame until `to`,
 * recording the time between frames (the page's own frame rate).
 */
async function scrollByFrames(page: Page, step: number, to: number): Promise<number[]> {
  return page.evaluate(
    ([pixelsPerFrame, target]) =>
      new Promise<number[]>((resolve) => {
        const scroller = document.querySelector<HTMLElement>('.ob-grid .dvn-scroller');
        if (scroller === null) {
          resolve([]);
          return;
        }
        const bottom = () => scroller.scrollHeight - scroller.clientHeight;
        const direction = Math.min(target, bottom()) >= scroller.scrollTop ? 1 : -1;
        const deltas: number[] = [];
        let last = performance.now();
        const frame = (now: number) => {
          deltas.push(now - last);
          last = now;
          // The row count of an estimated table is corrected as blocks load (the
          // grid may get shorter on the way): the end is read again each frame (T470).
          const end = Math.min(target, bottom());
          const next = scroller.scrollTop + direction * pixelsPerFrame;
          scroller.scrollTop = direction > 0 ? Math.min(next, end) : Math.max(next, end);
          if (scroller.scrollTop === end || Math.abs(scroller.scrollTop - end) < 1) resolve(deltas);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame((now) => {
          last = now;
          requestAnimationFrame(frame);
        });
      }),
    [step, to] as const,
  );
}

test.describe('T202 grid performance @perf', () => {
  test.beforeAll(async () => {
    test.setTimeout(3_600_000);
    const out = await runSeed('seed-bench.js');
    const table = /table:\s+(tbl_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    const base = /base:\s+(bse_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    if (table === undefined || base === undefined)
      throw new Error(`Unexpected seed output:\n${out}`);
    gridPath = `/b/${base}/t/${table}`;
  });

  test('first data < 1.5 s with a cold cache', async ({ browser }) => {
    const page = await signedInPage(browser);
    await page.goto(gridPath);
    await page.waitForFunction(
      (mark) => performance.getEntriesByName(mark).length > 0,
      FIRST_DATA_MARK,
    );
    const firstData = await page.evaluate(
      (mark) => performance.getEntriesByName(mark)[0]?.startTime ?? Number.POSITIVE_INFINITY,
      FIRST_DATA_MARK,
    );
    test.info().annotations.push({ type: 'first data (ms)', description: firstData.toFixed(0) });
    process.stdout.write(`[perf] first data: ${firstData.toFixed(0)} ms\n`);
    await recordPerf(browser, {
      'first data': { value: Math.round(firstData), unit: 'ms', budget: FIRST_DATA_BUDGET_MS },
    });
    expect(firstData).toBeLessThan(FIRST_DATA_BUDGET_MS);
    // Above 100 000 rows the API sends `total_estimate` (CONTRACTS §1.1).
    await expect(page.getByRole('status').filter({ hasText: 'records' })).toHaveText(
      /^About [\d,]+ records$/u,
    );
    await page.context().close();
  });

  test('scrolls 200 000 rows top to bottom without hanging, frames > 32 ms < 5 %', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const page = await signedInPage(browser);
    await page.goto(gridPath);
    await page.waitForFunction(
      (mark) => performance.getEntriesByName(mark).length > 0,
      FIRST_DATA_MARK,
    );
    const rowHeight = 34;
    const settled = await settle(page, 'grid');

    // Steady fast scrolling (wheel / trackpad): 20 rows per frame for ~10 000 rows.
    const steady = await scrollByFrames(page, rowHeight * 20, rowHeight * 10_000);
    // Top to bottom (scroll bar drag): the whole table in ~300 frames.
    const height = await page.evaluate(
      () => document.querySelector<HTMLElement>('.ob-grid .dvn-scroller')?.scrollHeight ?? 0,
    );
    const jump = await scrollByFrames(page, Math.ceil(height / 300), height);
    // And back up a little, slowly, at the end of the table.
    const back = await scrollByFrames(page, rowHeight * 5, height - rowHeight * 2_000);

    const all = [...steady, ...jump, ...back];
    const report = { steady: stats(steady), jump: stats(jump), back: stats(back), all: stats(all) };
    test.info().annotations.push({ type: 'frames', description: JSON.stringify(report) });
    process.stdout.write(`[perf] frames: ${JSON.stringify(report)}\n`);
    await recordPerf(
      browser,
      { ...frameMetrics(report.all), ...settleMetric(settled) },
      { ...report, settle: settled },
    );

    // The end of the table loads: the count becomes exact and the last rows have data.
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.ob-grid .dvn-scroller');
      if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
    });
    await expect(page.getByRole('status').filter({ hasText: 'records' })).toHaveText(
      '200,000 records',
      { timeout: 15_000 },
    );
    // The estimate may be short of the table (pg statistics): the count grew to
    // the exact end while the scroll position stayed at the estimated end, so
    // go to the (new) bottom before looking at the last row.
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.ob-grid .dvn-scroller');
      if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
    });
    const lastRow = page.locator('table[role="grid"] tr[aria-rowindex="200001"] td').first();
    await expect(lastRow).not.toHaveText('', { timeout: 15_000 });

    expect(report.all.ratio).toBeLessThan(LONG_FRAME_BUDGET);
    await page.context().close();
  });
});
