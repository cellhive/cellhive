import { expect, test } from '@playwright/test';

import { budgeted, expectBudgets, recordPerf } from './perf-results';
import { BENCH_EMAIL, BENCH_PASSWORD, runSeed } from './seed';
import { apiSignIn, ok } from './support';

/**
 * T314 performance budget on `seed:bench` (200 000 records): a kanban view
 * grouped by "Trạng thái" shows its first cards within 1.5 s (cold cache)
 * and loads only the first page of each column (FRONTEND §11.1: never
 * every record; `PERF_BUDGETS` holds the product and `ci-runner` budgets).
 * Tagged @perf: `pnpm test:e2e:perf` runs it.
 */

const FIRST_CARDS_MARK = 'app:kanban:first-cards';

let boardPath = '';

test.describe('T314 kanban performance @perf', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(3_600_000);
    const out = await runSeed('seed-bench.js');
    const table = /table:\s+(tbl_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    const base = /base:\s+(bse_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    if (table === undefined || base === undefined) {
      throw new Error(`Unexpected seed output:\n${out}`);
    }
    // A personal kanban view of the bench user, grouped by the status.
    const page = await browser.newPage();
    await apiSignIn(page, BENCH_EMAIL, BENCH_PASSWORD);
    const fields = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/tables/${table}/fields`,
    );
    const status = fields.items.find((field) => field.name === 'Trạng thái');
    const view = await ok<{ id: string }>(page, 'POST', `/tables/${table}/views`, {
      name: `Kanban ${String(Date.now())}`,
      type: 'kanban',
      is_personal: true,
      config: { kanban: { group_field: status?.id ?? null } },
    });
    await page.close();
    boardPath = `/b/${base}/t/${table}/v/${view.id}`;
  });

  test('first cards < 1.5 s with a cold cache, only the first page of each column', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.addInitScript(() => {
      window.localStorage.setItem('cellhive.language', 'en');
    });
    const page = await context.newPage();
    await apiSignIn(page, BENCH_EMAIL, BENCH_PASSWORD);
    await page.goto('/');
    await expect(page).toHaveURL(/\/o\//u);

    const offsets: number[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/records/query')) {
        const body = request.postDataJSON() as { offset?: number };
        offsets.push(body.offset ?? 0);
      }
    });
    await page.goto(boardPath);
    await page.waitForFunction(
      (mark) => performance.getEntriesByName(mark).length > 0,
      FIRST_CARDS_MARK,
    );
    const firstCards = await page.evaluate(
      (mark) => performance.getEntriesByName(mark)[0]?.startTime ?? Number.POSITIVE_INFINITY,
      FIRST_CARDS_MARK,
    );
    test.info().annotations.push({ type: 'first cards (ms)', description: firstCards.toFixed(0) });
    process.stdout.write(`[perf] kanban first cards: ${firstCards.toFixed(0)} ms\n`);
    const metrics = { 'first cards': budgeted('t314 first cards', firstCards) };
    await recordPerf(browser, metrics);
    expectBudgets(metrics);
    await page.waitForLoadState('networkidle');
    expect(offsets.length).toBeGreaterThan(0);
    expect(offsets.every((offset) => offset === 0)).toBe(true);
    await context.close();
  });
});
