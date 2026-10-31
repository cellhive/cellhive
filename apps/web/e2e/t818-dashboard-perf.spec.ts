import { expect, test } from '@playwright/test';

import { settleAfterBulkWrites } from './perf-db';
import { budgeted, expectBudgets, recordPerf } from './perf-results';
import { BENCH_EMAIL, BENCH_PASSWORD, runSeed } from './seed';
import { apiSignIn, ok } from './support';

/**
 * T818 performance budget on `seed:bench` (200 000 records): a dashboard of
 * five data widgets (KPI, stacked bar, weekly line, pie, top-10 table) shows
 * every widget's data within 2 s on a cold widget cache (Mốc S7, S§22: the
 * product budget; the nightly `perf` job asserts the `ci-runner` one, both in
 * `PERF_BUDGETS`). Tagged @perf: `pnpm test:e2e:perf` runs it; alone, with
 * `--grep T818` (`perf.yml` input `grep`), it has no CPU contention left over
 * from the earlier specs.
 */

const WIDGETS = 5;

let dashboardPath = '';

test.describe('T818 dashboard performance @perf', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(3_600_000);
    const out = await runSeed('seed-bench.js');
    const table = /table:\s+(tbl_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    const base = /base:\s+(bse_[0-9A-Za-z]{16})/u.exec(out)?.[1];
    if (table === undefined || base === undefined) {
      throw new Error(`Unexpected seed output:\n${out}`);
    }
    // Setup, not a budget change: earlier specs (t417, t468) rewrite the
    // bench table; measure once their events are dispatched and it is analyzed.
    const settled = await settleAfterBulkWrites();
    process.stdout.write(
      `[perf] settled before the dashboard: ${String(settled.jobs)} dispatch jobs drained in ${String(settled.drainedMs)} ms, VACUUM (ANALYZE) ${String(settled.vacuumMs)} ms\n`,
    );
    const page = await browser.newPage();
    await apiSignIn(page, BENCH_EMAIL, BENCH_PASSWORD);
    const fields = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/tables/${table}/fields`,
    );
    const field = (name: string): string => {
      const found = fields.items.find((item) => item.name === name);
      if (found === undefined) throw new Error(`The bench table has no field ${name}`);
      return found.id;
    };
    // A new dashboard each run: its widgets have no cached data yet.
    const dashboard = await ok<{ id: string }>(page, 'POST', `/bases/${base}/dashboards`, {
      name: `Perf ${String(Date.now())}`,
    });
    const widget = (body: Record<string, unknown>) =>
      ok(page, 'POST', `/dashboards/${dashboard.id}/widgets`, body);
    const amount = [{ id: 'm1', aggregation: 'sum', field: field('Số tiền') }];
    const count = [{ id: 'm1', aggregation: 'count' }];
    await widget({
      type: 'kpi',
      title: 'Revenue',
      config: { table_id: table, metrics: amount },
      layout: { x: 0, y: 0, w: 4, h: 4 },
    });
    await widget({
      type: 'bar',
      title: 'Status by region',
      config: {
        table_id: table,
        dimension: { field: field('Trạng thái') },
        series_dimension: { field: field('Khu vực') },
        metrics: count,
        display: { stack: 'stacked' },
      },
      layout: { x: 4, y: 0, w: 8, h: 6 },
    });
    await widget({
      type: 'line',
      title: 'Orders per week',
      config: {
        table_id: table,
        dimension: { field: field('Ngày tạo đơn'), date_bucket: 'week' },
        metrics: count,
        sort: 'dimension_asc',
        limit: 30,
      },
      layout: { x: 0, y: 6, w: 6, h: 6 },
    });
    await widget({
      type: 'pie',
      title: 'Revenue by channel',
      config: { table_id: table, dimension: { field: field('Kênh') }, metrics: amount },
      layout: { x: 6, y: 6, w: 6, h: 6 },
    });
    await widget({
      type: 'table',
      title: 'Top 10',
      config: {
        table_id: table,
        table: {
          mode: 'records',
          fields: [field('Mã'), field('Trạng thái'), field('Số tiền')],
          sort: { field: field('Số tiền'), direction: 'desc' },
          limit: 10,
        },
      },
      layout: { x: 0, y: 12, w: 12, h: 6 },
    });
    await page.close();
    dashboardPath = `/b/${base}/d/${dashboard.id}`;
  });

  test('five widgets show their data < 2 s with a cold widget cache', async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.addInitScript(() => {
      window.localStorage.setItem('cellhive.language', 'en');
    });
    const page = await context.newPage();
    await apiSignIn(page, BENCH_EMAIL, BENCH_PASSWORD);
    // The app's chunks in the browser cache, as for the other budgets.
    await page.goto('/');
    await expect(page).toHaveURL(/\/o\//u);

    // `cache` of each data answer (CONTRACTS §28.5): a cold dashboard is all `miss`.
    const caches: Promise<string>[] = [];
    page.on('response', (response) => {
      if (/\/widgets\/[^/]+\/data$/u.test(new URL(response.url()).pathname)) {
        caches.push(
          response
            .json()
            .then((body: { cache?: string }) => body.cache ?? '?')
            .catch(() => '?'),
        );
      }
    });
    await page.goto(dashboardPath);
    // The first frame where every widget has its data and no skeleton is left.
    await page.waitForFunction(
      (widgets) => {
        const state = window as unknown as { __dashboardReady?: number };
        const done = performance
          .getEntriesByType('resource')
          .filter((entry) => /\/widgets\/[^/]+\/data$/u.test(new URL(entry.name).pathname));
        if (
          done.length >= widgets &&
          document.querySelectorAll('[data-testid="widget-skeleton"]').length === 0
        ) {
          state.__dashboardReady ??= performance.now();
          return true;
        }
        return false;
      },
      WIDGETS,
      { polling: 'raf', timeout: 60_000 },
    );
    const measured = await page.evaluate(() => {
      const entries = performance
        .getEntriesByType('resource')
        .filter((entry) => /\/widgets\/[^/]+\/data$/u.test(new URL(entry.name).pathname))
        .map((entry) => entry as PerformanceResourceTiming);
      return {
        ready: (window as unknown as { __dashboardReady?: number }).__dashboardReady ?? -1,
        lastResponse: Math.max(...entries.map((entry) => entry.responseEnd)),
        requests: entries.map((entry) => Math.round(entry.responseEnd - entry.requestStart)),
      };
    });
    const sortedRequests = [...measured.requests].sort((a, b) => a - b);
    const cache = await Promise.all(caches);
    process.stdout.write(
      `[perf] dashboard 5 widgets: all data shown ${measured.ready.toFixed(0)} ms, last response ${measured.lastResponse.toFixed(0)} ms, requests ${sortedRequests.join('/')} ms, cache ${cache.join(',')}\n`,
    );
    const metrics = {
      'dashboard data': budgeted('t818 dashboard data', measured.ready),
      'slowest widget request': {
        value: sortedRequests[sortedRequests.length - 1] ?? -1,
        unit: 'ms' as const,
      },
    };
    await recordPerf(browser, metrics, { requests: sortedRequests, cache });
    expect(measured.requests.length).toBe(WIDGETS);
    expect(cache.every((value) => value === 'miss')).toBe(true);
    expectBudgets(metrics);
    await context.close();
  });
});
