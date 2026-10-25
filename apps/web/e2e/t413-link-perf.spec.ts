import { expect, test } from '@playwright/test';

import { recordPerf } from './perf-results';
import { BENCH_EMAIL, BENCH_PASSWORD, runSeed } from './seed';
import { apiSignIn, ok } from './support';

/**
 * T413 performance (opt-in, `pnpm test:e2e:perf`): on the `seed:bench`
 * table (200 000 records) a self-link field is added; the picker of a
 * cell shows its first candidates < 500 ms after Enter (the picker chunk
 * is preloaded with the grid, the first page is 50 candidates).
 */
const PICKER_BUDGET_MS = 500;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

test.describe('T413 link picker performance @perf', () => {
  let path = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(3_600_000);
    const out = await runSeed('seed-bench.js');
    const table = /table:\s+(tbl_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    const base = /base:\s+(bse_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    if (table === undefined || base === undefined) {
      throw new Error(`Unexpected seed output:\n${out}`);
    }
    const page = await browser.newPage();
    await apiSignIn(page, BENCH_EMAIL, BENCH_PASSWORD);
    const link = await ok<{ id: string }>(page, 'POST', `/tables/${table}/fields`, {
      name: `Liên quan ${String(Date.now())}`,
      type: 'link',
      options: { link_table: table },
    });
    const fields = await ok<{ items: { id: string; is_primary: boolean }[] }>(
      page,
      'GET',
      `/tables/${table}/fields`,
    );
    const view = await ok<{ id: string }>(page, 'POST', `/tables/${table}/views`, {
      name: `T413 perf ${String(Date.now())}`,
      type: 'grid',
      is_personal: true,
      config: {
        hidden_fields: fields.items
          .filter((field) => !field.is_primary && field.id !== link.id)
          .map((field) => field.id),
      },
    });
    path = `/b/${base}/t/${table}/v/${view.id}`;
    await page.close();
  });

  test('the picker shows its first candidates < 500 ms after Enter', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.addInitScript(() => {
      window.localStorage.setItem('cellhive.language', 'en');
    });
    const page = await context.newPage();
    await page.goto('/login');
    await apiSignIn(page, BENCH_EMAIL, BENCH_PASSWORD);
    await page.goto(path);
    await page.waitForFunction(
      () => performance.getEntriesByName('app:grid:first-data').length > 0,
    );
    const box = await page.locator('.ob-grid [data-testid="data-grid-canvas"]').boundingBox();
    if (box === null) throw new Error('grid not laid out');
    await page.mouse.click(box.x + 80, box.y + HEADER_HEIGHT + ROW_HEIGHT / 2);
    await page.keyboard.press('ArrowRight');
    // The chunk is preloaded while the grid shows (GridPage `Link.preload`).
    await page.waitForTimeout(1_000);
    // Measured in the page: from the key to the first option in the DOM (a frame-precise poll).
    const request = page.waitForResponse((response) => response.url().includes('/link-candidates'));
    await page.evaluate(() => {
      const state = window as unknown as { t413Start?: number; t413Epoch?: number };
      document.addEventListener(
        'keydown',
        () => {
          state.t413Start = performance.now();
          state.t413Epoch = Date.now();
        },
        { capture: true, once: true },
      );
    });
    await page.keyboard.press('Enter');
    const shownHandle = await page.waitForFunction(
      () => {
        if (document.querySelector('[role="option"]') === null) return null;
        const state = window as unknown as { t413Start?: number };
        return performance.now() - (state.t413Start ?? 0);
      },
      undefined,
      { polling: 'raf' },
    );
    const elapsed = (await shownHandle.jsonValue()) ?? Number.POSITIVE_INFINITY;
    const timing = (await request).request().timing();
    const epoch = await page.evaluate(
      () => (window as unknown as { t413Epoch?: number }).t413Epoch ?? 0,
    );
    process.stdout.write(
      `[perf] request sent after: ${(timing.startTime - epoch).toFixed(0)} ms\n`,
    );
    process.stdout.write(
      `[perf] link-candidates request: ${(timing.responseEnd - timing.requestStart).toFixed(0)} ms\n`,
    );
    process.stdout.write(`[perf] link picker first candidates: ${elapsed.toFixed(0)} ms\n`);
    await recordPerf(browser, {
      'picker first candidates': {
        value: Math.round(elapsed),
        unit: 'ms',
        budget: PICKER_BUDGET_MS,
      },
      'link-candidates request': {
        value: Math.round(timing.responseEnd - timing.requestStart),
        unit: 'ms',
      },
    });
    test.info().annotations.push({ type: 'picker (ms)', description: elapsed.toFixed(0) });
    expect(elapsed).toBeLessThan(PICKER_BUDGET_MS);
    await context.close();
  });
});
