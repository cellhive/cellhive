import { expect, test, type Browser, type Page } from '@playwright/test';

import { pngBytes, uploadFile } from './attachments';
import { frameMetrics, frameStats, recordPerf } from './perf-results';
import { settle, settleMetric, watchNetwork } from './perf-settle';
import { BENCH_EMAIL, BENCH_PASSWORD, runSeed } from './seed';
import { apiSignIn, ok } from './support';

/**
 * T422 performance (opt-in, `pnpm test:e2e:perf`): the grid of `seed:bench`
 * (200 000 records, its 2 link columns) with an attachment column whose
 * first 3 000 records hold 3 images each (thumbnails drawn lazily on the
 * canvas, T418/T407). First data < 1.5 s and, while scrolling through the
 * rows with images, frames > 32 ms < 5 % (FRONTEND §11.1), like T202.
 *
 * Frames are sampled only once the page has settled after its first data,
 * the first thumbnails included (`perf-settle.ts`: network quiet 500 ms,
 * fonts, one idle callback, 10 animation frames without a long animation
 * frame; it replaces a fixed 1 s wait); the first data is still read cold,
 * before that. The wait is the metric `settle before steady`.
 */
const FIRST_DATA_MARK = 'app:grid:first-data';
const FIRST_DATA_BUDGET_MS = 1_500;
const LONG_FRAME_MS = 32;
const LONG_FRAME_BUDGET = 0.05;
const WITH_FILES = 3_000;
const PAGE = 1_000;
const ROW_HEIGHT = 34;

let gridPath = '';

async function signedInPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  watchNetwork(page);
  await apiSignIn(page, BENCH_EMAIL, BENCH_PASSWORD);
  return page;
}

test.describe('T422 grid with link and attachment columns @perf', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(3_600_000);
    const out = await runSeed('seed-bench.js');
    const table = /table:\s+(tbl_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    const base = /base:\s+(bse_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    if (table === undefined || base === undefined) {
      throw new Error(`Unexpected seed output:\n${out}`);
    }
    const page = await signedInPage(browser);
    await page.goto('/');
    const field = await ok<{ id: string }>(page, 'POST', `/tables/${table}/fields`, {
      name: `Tệp ${String(Date.now())}`,
      type: 'attachment',
      options: {},
    });
    const ids: string[] = [];
    for (let offset = 0; ids.length < WITH_FILES; offset += PAGE) {
      const answer = await ok<{ records: { id: string }[] }>(
        page,
        'POST',
        `/tables/${table}/records/query`,
        { fields: [], offset, limit: PAGE, include_total: false },
      );
      ids.push(...answer.records.map((record) => record.id));
    }
    const colors: [number, number, number][] = [
      [59, 130, 246],
      [234, 88, 12],
      [22, 163, 74],
    ];
    const files = [];
    for (const [index, rgb] of colors.entries()) {
      files.push(
        await uploadFile(
          page,
          { tableId: table, fieldId: field.id },
          { name: `ảnh ${String(index)}.png`, mime: 'image/png', bytes: pngBytes(rgb, 640, 480) },
        ),
      );
    }
    const cell = files.map((file) => ({ id: file.id }));
    // The first record takes the uploads; the others copy them (shared objects, S4 #12).
    await ok(page, 'PATCH', `/tables/${table}/records?field_key_type=id`, {
      records: [{ id: ids[0], fields: { [field.id]: cell } }],
    });
    for (let start = 1; start < WITH_FILES; start += 500) {
      await ok(page, 'PATCH', `/tables/${table}/records?field_key_type=id`, {
        records: ids
          .slice(start, Math.min(WITH_FILES, start + 500))
          .map((id) => ({ id, fields: { [field.id]: cell } })),
      });
    }
    const fields = await ok<{ items: { id: string; is_primary: boolean; type: string }[] }>(
      page,
      'GET',
      `/tables/${table}/fields`,
    );
    // Primary, the two links and the files first; the other fields follow as in T202.
    const first = fields.items.filter(
      (item) => item.is_primary || item.type === 'link' || item.id === field.id,
    );
    const view = await ok<{ id: string }>(page, 'POST', `/tables/${table}/views`, {
      name: `T422 files ${String(Date.now())}`,
      type: 'grid',
      is_personal: true,
      config: {
        field_order: [
          ...first.map((item) => item.id),
          ...fields.items.filter((item) => !first.includes(item)).map((item) => item.id),
        ],
      },
    });
    gridPath = `/b/${base}/t/${table}/v/${view.id}`;
    await page.context().close();
  });

  test('first data < 1.5 s, frames > 32 ms < 5 % over rows with images', async ({ browser }) => {
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
    // Let the first thumbnails arrive (network quiet), then scroll the rows with images
    // (5 rows per frame).
    const settled = await settle(page, 'files grid');
    const deltas = await page.evaluate(
      ([pixelsPerFrame, target]) =>
        new Promise<number[]>((resolve) => {
          const scroller = document.querySelector<HTMLElement>('.ob-grid .dvn-scroller');
          if (scroller === null) {
            resolve([]);
            return;
          }
          const end = Math.min(target, scroller.scrollHeight - scroller.clientHeight);
          const out: number[] = [];
          let last = performance.now();
          const frame = (now: number) => {
            out.push(now - last);
            last = now;
            scroller.scrollTop = Math.min(scroller.scrollTop + pixelsPerFrame, end);
            if (scroller.scrollTop >= end - 1) resolve(out);
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame((now) => {
            last = now;
            requestAnimationFrame(frame);
          });
        }),
      [ROW_HEIGHT * 5, ROW_HEIGHT * (WITH_FILES - 30)] as const,
    );
    const report = frameStats(deltas, LONG_FRAME_MS);
    process.stdout.write(
      `[perf] files grid first data: ${firstData.toFixed(0)} ms, frames: ${JSON.stringify(report)}\n`,
    );
    test.info().annotations.push({
      type: 'files grid',
      description: JSON.stringify({ firstData: Math.round(firstData), ...report }),
    });
    await recordPerf(
      browser,
      {
        'first data': { value: Math.round(firstData), unit: 'ms', budget: FIRST_DATA_BUDGET_MS },
        ...frameMetrics(report),
        ...settleMetric(settled),
      },
      { ...report, settle: settled },
    );
    expect(firstData).toBeLessThan(FIRST_DATA_BUDGET_MS);
    expect(report.ratio).toBeLessThan(LONG_FRAME_BUDGET);
    await expect(page.getByRole('status').filter({ hasText: 'records' })).toBeVisible();
    await page.context().close();
  });
});
