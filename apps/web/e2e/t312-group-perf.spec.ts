import { expect, test, type Browser, type Page } from '@playwright/test';

import { budgeted, expectBudgets, frameStats, phaseFrameMetrics, recordPerf } from './perf-results';
import { settle, settleMetric, watchNetwork } from './perf-settle';
import { BENCH_EMAIL, BENCH_PASSWORD, runSeed } from './seed';
import { apiSignIn, ok } from './support';

/**
 * T312 performance budget (FRONTEND §11.1) on `seed:bench` (200 000
 * records): a grid view grouped by "Trạng thái" then "Khu vực" (two levels,
 * virtual headers) — first data < 1.5 s with a cold cache, and scrolling
 * the whole table with frames > 32 ms < 5 % (the T202 harness; product
 * budgets, `PERF_BUDGETS` holds both profiles). Tagged @perf:
 * `pnpm test:e2e:perf` runs it.
 *
 * Frames are sampled only once the page has settled after its first data
 * (`perf-settle.ts`: network quiet 500 ms, fonts, one idle callback, 10
 * animation frames without a long animation frame); the first data is still
 * read cold, before that. The wait is the metric `settle before steady`.
 */

const FIRST_DATA_MARK = 'app:grid:first-data';
let gridPath = '';

async function signedInPage(browser: Browser): Promise<Page> {
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

/** Scrolls the grid by `step` px per animation frame until `to`, recording frame times. */
async function scrollByFrames(page: Page, step: number, to: number): Promise<number[]> {
  return page.evaluate(
    ([pixelsPerFrame, target]) =>
      new Promise<number[]>((resolve) => {
        const scroller = document.querySelector<HTMLElement>('.ob-grid .dvn-scroller');
        if (scroller === null) {
          resolve([]);
          return;
        }
        const end = Math.min(target, scroller.scrollHeight - scroller.clientHeight);
        const direction = end >= scroller.scrollTop ? 1 : -1;
        const deltas: number[] = [];
        let last = performance.now();
        const frame = (now: number) => {
          deltas.push(now - last);
          last = now;
          const next = scroller.scrollTop + direction * pixelsPerFrame;
          scroller.scrollTop = direction > 0 ? Math.min(next, end) : Math.max(next, end);
          if (Math.abs(scroller.scrollTop - end) < 1) resolve(deltas);
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

test.describe('T312 grouped grid performance @perf', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(3_600_000);
    const out = await runSeed('seed-bench.js');
    const table = /table:\s+(tbl_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    const base = /base:\s+(bse_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    if (table === undefined || base === undefined) {
      throw new Error(`Unexpected seed output:\n${out}`);
    }
    // A personal grid view of the bench user grouped by status, then region.
    const page = await browser.newPage();
    await apiSignIn(page, BENCH_EMAIL, BENCH_PASSWORD);
    const fields = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/tables/${table}/fields`,
    );
    const id = (name: string) => fields.items.find((field) => field.name === name)?.id;
    const view = await ok<{ id: string }>(page, 'POST', `/tables/${table}/views`, {
      name: `Grouped ${String(Date.now())}`,
      type: 'grid',
      is_personal: true,
      config: {
        group: [
          { field: id('Trạng thái'), direction: 'asc' },
          { field: id('Khu vực'), direction: 'asc' },
        ],
      },
    });
    await page.close();
    gridPath = `/b/${base}/t/${table}/v/${view.id}`;
  });

  test('first data < 1.5 s and scrolling 200 000 grouped rows, frames > 32 ms < 5 %', async ({
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
    process.stdout.write(`[perf] grouped first data: ${firstData.toFixed(0)} ms\n`);
    // The count is the sum of the groups: exact even above 100 000 rows.
    // (T320a) with the number of top-level groups.
    await expect(page.getByRole('status').filter({ hasText: /records · / })).toHaveText(
      /^200,000 records · \d+ groups?$/u,
    );
    const rowHeight = 34;
    const settled = await settle(page, 'grouped');
    const steady = await scrollByFrames(page, rowHeight * 20, rowHeight * 10_000);
    const height = await page.evaluate(
      () => document.querySelector<HTMLElement>('.ob-grid .dvn-scroller')?.scrollHeight ?? 0,
    );
    const jump = await scrollByFrames(page, Math.ceil(height / 300), height);
    const back = await scrollByFrames(page, rowHeight * 5, height - rowHeight * 2_000);
    const all = [...steady, ...jump, ...back];
    const report = {
      steady: frameStats(steady),
      jump: frameStats(jump),
      back: frameStats(back),
      all: frameStats(all),
    };
    test.info().annotations.push({ type: 'frames', description: JSON.stringify(report) });
    process.stdout.write(`[perf] grouped frames: ${JSON.stringify(report)}\n`);
    const metrics = {
      'first data': budgeted('t312 first data', firstData),
      ...phaseFrameMetrics('t312', report),
    };
    await recordPerf(
      browser,
      { ...metrics, ...settleMetric(settled) },
      { ...report, settle: settled },
    );

    // The last rows load (their group's blocks, nothing collapsed).
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.ob-grid .dvn-scroller');
      if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
    });
    const table = page.locator('table[role="grid"]');
    // Every record plus the group headers (and the column header row).
    await expect
      .poll(async () => Number(await table.getAttribute('aria-rowcount')), { timeout: 15_000 })
      .toBeGreaterThan(200_000);
    const rows = Number(await table.getAttribute('aria-rowcount'));
    // The last record: after it come its group's "+" row and the spacers closing
    // the two cards (T320a); `aria-rowindex` counts the column header row.
    const lastRow = page
      .locator(`table[role="grid"] tr[aria-rowindex="${String(rows - 3)}"] td`)
      .first();
    await expect(lastRow).not.toHaveText('', { timeout: 15_000 });

    expectBudgets(metrics);
    await page.context().close();
  });
});
