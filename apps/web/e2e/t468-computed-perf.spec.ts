import { expect, test, type Browser, type Page } from '@playwright/test';

import { budgeted, expectBudgets, frameMetrics, frameStats, recordPerf } from './perf-results';
import { settle, settleMetric, watchNetwork } from './perf-settle';
import { BENCH_EMAIL, BENCH_PASSWORD, runSeed } from './seed';
import { apiSignIn, ok } from './support';

/**
 * T468 performance (@perf, `pnpm test:e2e:perf`) on `seed:bench`: 200 000
 * records with its 2 link fields, plus 2 computed fields made here — a
 * stored formula and a virtual one (`TODAY()`):
 * - saving the stored formula shows the backfill progress on its header,
 *   then the cells get their values;
 * - first data of the grid < 1.5 s (cold cache), frames > 32 ms < 5 %
 *   (product budgets; `PERF_BUDGETS` holds both profiles, the runner records
 *   this steady scroll's frames only).
 *
 * Frames are sampled only once the page has settled after its first data and the move to
 * the computed columns
 * (`perf-settle.ts`: network quiet 500 ms, fonts, one idle callback, 10
 * animation frames without a long animation frame); the first data is still
 * read cold, before that. The wait is the metric `settle before steady`.
 */

const FIRST_DATA_MARK = 'app:grid:first-data';
const RUN = String(Date.now()).slice(-6);
const STORED = `Gấp đôi ${RUN}`;
const VIRTUAL = `Quá hạn ${RUN}`;
let gridPath = '';
let tableId = '';

async function signedInPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  watchNetwork(page);
  await page.goto('/login');
  await apiSignIn(page, BENCH_EMAIL, BENCH_PASSWORD);
  return page;
}

function header(page: Page, name: string) {
  return page.locator('table[role="grid"] th[role="columnheader"]', { hasText: name });
}

/** Moves the selection right until the column of `name` is in glide's accessibility table. */
async function revealColumn(page: Page, name: string): Promise<number> {
  const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('grid not laid out');
  await page.mouse.click(box.x + 80, box.y + 36 + 17);
  // The computed columns are the last ones: jump there first (T527: since T519 the bench
  // queue is empty, the backfill takes a few seconds and stepping across every column
  // showed the header only once the progress was over). Then step left or right.
  await page.keyboard.press('End');
  const end = await header(page, name)
    .getAttribute('aria-colindex', { timeout: 1_000 })
    .catch(() => null);
  if (end !== null) return Number(end);
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press('ArrowLeft');
    const column = await header(page, name)
      .getAttribute('aria-colindex', { timeout: 200 })
      .catch(() => null);
    if (column !== null) return Number(column);
  }
  await page.keyboard.press('Home');
  // Earlier @perf specs add link, attachment and parent columns to the bench table (T470).
  for (let step = 0; step < 200; step += 1) {
    const column = await header(page, name)
      .getAttribute('aria-colindex', { timeout: 200 })
      .catch(() => null);
    if (column !== null) return Number(column);
    await page.keyboard.press('ArrowRight');
  }
  throw new Error(`column ${name} not reached`);
}

test.describe('T468 computed columns @perf', () => {
  test.beforeAll(async () => {
    test.setTimeout(3_600_000);
    const out = await runSeed('seed-bench.js');
    const table = /table:\s+(tbl_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    const base = /base:\s+(bse_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    if (table === undefined || base === undefined)
      throw new Error(`Unexpected seed output:\n${out}`);
    tableId = table;
    gridPath = `/b/${base}/t/${table}`;
  });

  test('saving a formula on 200 000 rows: progress on the header, then values', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const page = await signedInPage(browser);
    await page.goto(gridPath);
    await page.waitForFunction(
      (mark) => performance.getEntriesByName(mark).length > 0,
      FIRST_DATA_MARK,
    );
    const started = Date.now();
    await ok(page, 'POST', `/tables/${tableId}/fields`, {
      name: STORED,
      type: 'formula',
      options: { expression: '[Số tiền] * 2', style: { type: 'plain', precision: 0 } },
    });
    await ok(page, 'POST', `/tables/${tableId}/fields`, {
      name: VIRTUAL,
      type: 'formula',
      options: { expression: 'IF(TODAY() > [Hạn], 1, 0)', style: { type: 'plain', precision: 0 } },
    });
    const column = await revealColumn(page, STORED);
    // The job may wait for the jobs earlier @perf specs left to the worker (T470).
    await expect(header(page, STORED)).toHaveAttribute('aria-label', /computing \d+%/u, {
      timeout: 120_000,
    });
    await page.screenshot({ path: test.info().outputPath('backfill-progress.png') });
    await expect(header(page, STORED)).not.toHaveAttribute('aria-label', /computing/u, {
      timeout: 120_000,
    });
    const backfill = Date.now() - started;
    process.stdout.write(`[perf] backfill 200k seen done after ${String(backfill)} ms\n`);
    await recordPerf(browser, { 'backfill 200k (seen done)': { value: backfill, unit: 'ms' } });
    await expect(page.getByTestId(`glide-cell-${String(column)}-0`)).toHaveText(/^\d+$/u, {
      timeout: 30_000,
    });
    await page.context().close();
  });

  test('first data < 1.5 s and frames > 32 ms < 5 % with 2 links + 2 computed columns', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
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
    process.stdout.write(`[perf] first data with computed: ${firstData.toFixed(0)} ms\n`);
    const first = { 'first data': budgeted('t468 first data', firstData) };
    await recordPerf(browser, first);
    expectBudgets(first);
    // Scroll right to the computed columns, then down ~10 000 rows, 20 rows a frame.
    await revealColumn(page, VIRTUAL);
    const settled = await settle(page, 'computed');
    const deltas = await page.evaluate(
      ([pixelsPerFrame, target]) =>
        new Promise<number[]>((resolve) => {
          const scroller = document.querySelector<HTMLElement>('.ob-grid .dvn-scroller');
          if (scroller === null) {
            resolve([]);
            return;
          }
          const out: number[] = [];
          let last = performance.now();
          const frame = (now: number) => {
            out.push(now - last);
            last = now;
            scroller.scrollTop = Math.min(scroller.scrollTop + pixelsPerFrame, target);
            if (scroller.scrollTop >= target - 1) resolve(out);
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame((now) => {
            last = now;
            requestAnimationFrame(frame);
          });
        }),
      [34 * 20, 34 * 10_000] as const,
    );
    const report = frameStats(deltas);
    const frames = frameMetrics(report);
    await recordPerf(
      browser,
      { ...frames, ...settleMetric(settled) },
      { ...report, settle: settled },
    );
    process.stdout.write(
      `[perf] frames: ${String(deltas.length)}, > 32 ms: ${(report.ratio * 100).toFixed(1)} %\n`,
    );
    expectBudgets(frames);
    await page.context().close();
  });
});
