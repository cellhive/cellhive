import { expect, test, type Browser, type Page } from '@playwright/test';

import { settleAfterBulkWrites } from './perf-db';
import { budgeted, expectBudgets, recordPerf } from './perf-results';
import { BENCH_EMAIL, BENCH_PASSWORD, runSeed } from './seed';
import { apiSignIn, ok } from './support';

/**
 * T417 performance budget on `seed:bench` (200 000 records) made a tree of
 * 10 levels: the first 50 000 records are roots, the others hang in chains
 * (level n+1 under level n), about 16 700 records per level. With a cold
 * cache the roots' first data < 1.5 s (FRONTEND §11.1) and opening a branch
 * shows its children < 300 ms (product budgets; `PERF_BUDGETS` holds both
 * profiles). Tagged @perf: `pnpm test:e2e:perf` runs it.
 */

const FIRST_DATA_MARK = 'app:grid:first-data';
const BRANCH_ROWS_MARK = 'app:tree:branch-rows';
const ROOTS = 50_000;
const LEVELS = 10;
const PAGE = 1_000;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

let gridPath = '';

async function signedInPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  await apiSignIn(page, BENCH_EMAIL, BENCH_PASSWORD);
  return page;
}

/** Adds the parent field and hangs the records in chains; returns the first root's id. */
async function buildTree(page: Page, table: string): Promise<string> {
  await ok(page, 'POST', `/tables/${table}/fields`, { name: 'Parent', type: 'parent' });
  // Every record id in `__auto` order.
  const ids: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const answer = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${table}/records/query`,
      { fields: [], offset, limit: PAGE, include_total: false },
    );
    ids.push(...answer.records.map((record) => record.id));
    if (answer.records.length < PAGE) break;
  }
  const perLevel = Math.ceil((ids.length - ROOTS) / (LEVELS - 1));
  const started = Date.now();
  for (let start = ROOTS; start < ids.length; start += PAGE) {
    const records = ids.slice(start, start + PAGE).map((id, index) => {
      const at = start + index;
      const parent = at - ROOTS < perLevel ? at - ROOTS : at - perLevel;
      return { id, fields: {}, parent_id: ids[parent] };
    });
    await ok(page, 'PATCH', `/tables/${table}/records`, { records });
  }
  process.stdout.write(
    `[perf] tree built: ${String(ids.length)} records, ${String(perLevel)} per level below the roots, ${String(Date.now() - started)} ms\n`,
  );
  // Setup, not a budget change (BACKLOG T818): the 150 PATCH batches above
  // queue ~150 000 events.dispatch jobs; measure once the worker is done
  // with them and the table is analyzed, as S4-review did by hand.
  const settled = await settleAfterBulkWrites();
  process.stdout.write(
    `[perf] settled after the tree build: ${String(settled.jobs)} dispatch jobs drained in ${String(settled.drainedMs)} ms, VACUUM (ANALYZE) ${String(settled.vacuumMs)} ms\n`,
  );
  return ids[0] ?? '';
}

test.describe('T417 sub-record tree performance @perf', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(3_600_000);
    const out = await runSeed('seed-bench.js');
    const table = /table:\s+(tbl_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    const base = /base:\s+(bse_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    if (table === undefined || base === undefined) {
      throw new Error(`Unexpected seed output:\n${out}`);
    }
    const page = await signedInPage(browser);
    const fields = await ok<{ items: { type: string }[] }>(page, 'GET', `/tables/${table}/fields`);
    // A later run of `--repeat-each` (perf.yml `repeat`) finds the tree the first one built:
    // a table has one parent field.
    const firstRoot = fields.items.some((field) => field.type === 'parent')
      ? ((
          await ok<{ records: { id: string }[] }>(page, 'POST', `/tables/${table}/records/query`, {
            fields: [],
            offset: 0,
            limit: 1,
            include_total: false,
          })
        ).records[0]?.id ?? '')
      : await buildTree(page, table);
    // Server time of the two requests the grid waits for (roots, then a branch).
    const timed = async (body: Record<string, unknown>) => {
      const start = Date.now();
      await ok(page, 'POST', `/tables/${table}/records/tree`, body);
      return Date.now() - start;
    };
    const rootsMs = await timed({ offset: 0, limit: 200 });
    const rootsWarmMs = await timed({ offset: 0, limit: 200 });
    const branchMs = await timed({ parent_id: firstRoot, offset: 0, limit: 200 });
    process.stdout.write(
      `[perf] records/tree roots: ${String(rootsMs)} ms (again: ${String(rootsWarmMs)} ms), branch: ${String(branchMs)} ms\n`,
    );
    const view = await ok<{ id: string }>(page, 'POST', `/tables/${table}/views`, {
      name: `Tree ${String(Date.now())}`,
      type: 'grid',
      is_personal: true,
      config: { tree: { enabled: true, show_ancestors: true }, row_height: 'short' },
    });
    await page.context().close();
    gridPath = `/b/${base}/t/${table}/v/${view.id}`;
  });

  test('roots first data < 1.5 s, a branch opens < 300 ms', async ({ browser }) => {
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
    const first = page.getByTestId('glide-cell-1-0');
    await expect(first).not.toHaveText('');
    const second = (await page.getByTestId('glide-cell-1-1').textContent()) ?? '';
    // Opening the first root: from the pointer down on its caret until the branch's first
    // rows are laid out (`app:tree:branch-rows`) and the next frame is drawn.
    const box = await page.locator('.ob-grid [data-testid="data-grid-canvas"]').boundingBox();
    if (box === null) throw new Error('grid not laid out');
    await page.evaluate(() => {
      const state = window as unknown as { __pressedAt?: number };
      window.addEventListener(
        'pointerdown',
        () => {
          state.__pressedAt = performance.now();
        },
        { capture: true, once: true },
      );
    });
    // Gutter of 5-digit row numbers: 56 px; the caret of a root is 4…24 px into the cell.
    await page.mouse.click(box.x + 56 + 14, box.y + HEADER_HEIGHT + ROW_HEIGHT / 2);
    const expand = await page.evaluate(
      (mark) =>
        new Promise<number>((resolve) => {
          const start = (window as unknown as { __pressedAt?: number }).__pressedAt ?? 0;
          const check = () => {
            const entry = performance.getEntriesByName(mark).at(-1);
            if (entry !== undefined && entry.startTime >= start) {
              requestAnimationFrame(() => {
                resolve(performance.now() - start);
              });
            } else requestAnimationFrame(check);
          };
          check();
        }),
      BRANCH_ROWS_MARK,
    );
    // And the accessibility table follows (glide debounces it by 200 ms).
    await expect(page.getByTestId('glide-cell-1-1')).not.toHaveText(second);
    process.stdout.write(
      `[perf] tree roots first data: ${firstData.toFixed(0)} ms, expand: ${expand.toFixed(0)} ms\n`,
    );
    test.info().annotations.push({
      type: 'tree',
      description: JSON.stringify({ firstData: Math.round(firstData), expand: Math.round(expand) }),
    });
    const metrics = {
      'roots first data': budgeted('t417 roots first data', firstData),
      'branch opens': budgeted('t417 branch opens', expand),
    };
    await recordPerf(browser, metrics);
    expectBudgets(metrics);
    await page.context().close();
  });
});
