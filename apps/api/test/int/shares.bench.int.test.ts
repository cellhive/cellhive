/**
 * Opt-in bench (BACKLOG T305): `T305_BENCH=1 pnpm --filter @cellhive/api
 * test:int test/int/shares.bench` (`T305_BENCH_ROWS` to change the 200 000
 * rows). Seeds the `seed:bench` table through the services, shares a view
 * (filter + sort + group 2 levels) publicly and measures
 * `POST /api/v1/shares/:token/records/query` end to end (per-IP limit,
 * token resolution, creator access, query, serialization), limit 200, at the
 * first, middle and last page. Reports p50/p95; it never fails on them (the
 * target, p95 < 500 ms, is checked by humans).
 */
import {
  createdShareLinkSchema,
  fieldListSchema,
  recordListResponseSchema,
  viewSchema,
  type Id,
} from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShareRateLimits } from '../../src/common/rate-limit/share-rate-limits.js';
import { BENCH_EMAIL, BENCH_PASSWORD, seedBench } from '../../src/seed/bench-seed.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, type TestDatabase } from './database.js';
import { startTestApp, type TestApp } from './support.js';

const ROWS = Number(process.env['T305_BENCH_ROWS'] ?? 200_000);
const RUNS = 20;

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(process.env['T305_BENCH'] !== '1')('share link query bench', () => {
  let database: TestDatabase;
  let t: TestApp;
  let token: string;
  const report: string[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    t = await startTestApp({ DATABASE_URL: database.url, LOG_LEVEL: 'warn' });
    t.app.get(ShareRateLimits).read = { limit: 1_000_000, windowSeconds: 1 };
    const started = Date.now();
    const seeded = await seedBench(t.app, { rows: ROWS });
    report.push(`seeded ${String(ROWS)} rows in ${((Date.now() - started) / 1000).toFixed(0)} s`);

    const owner = new Browser(t.app);
    expect((await owner.login(BENCH_EMAIL, BENCH_PASSWORD)).statusCode).toBe(204);
    const fields = fieldListSchema.parse(
      (
        await owner.request({
          method: 'GET',
          url: `/api/v1/tables/${seeded.tableId}/fields?limit=1000`,
        })
      ).json(),
    ).items;
    const id = (name: string) => fields.find((field) => field.name === name)?.id as Id<'fld'>;
    const view = await owner.request({
      method: 'POST',
      url: `/api/v1/tables/${seeded.tableId}/views`,
      payload: {
        name: 'Shared bench',
        type: 'grid',
        config: {
          filter: {
            op: 'and',
            items: [{ field: id('Số tiền'), operator: 'gte', value: 5_000_000 }],
          },
          sort: [{ field: id('Hạn'), direction: 'asc' }],
          group: [
            { field: id('Trạng thái'), direction: 'asc' },
            { field: id('Khu vực'), direction: 'asc' },
          ],
          hidden_fields: [id('Email'), id('Điện thoại')],
        },
      },
    });
    expect(view.statusCode, view.body).toBe(201);
    const link = await owner.request({
      method: 'POST',
      url: `/api/v1/views/${viewSchema.parse(view.json()).id}/share-links`,
      payload: { audience: 'public' },
    });
    expect(link.statusCode, link.body).toBe(201);
    token = createdShareLinkSchema.parse(link.json()).token;
  }, 3_600_000);

  afterAll(async () => {
    process.stdout.write(
      `\nT305 share link bench (p of ${String(RUNS)} runs)\n${report.join('\n')}\n`,
    );
    await t.close();
    await database.drop();
  });

  async function measure(label: string, body: Record<string, unknown>) {
    const visitor = new Browser(t.app);
    const run = async (offset: number, includeTotal: boolean) => {
      const start = performance.now();
      const response = await visitor.request({
        method: 'POST',
        url: `/api/v1/shares/${token}/records/query`,
        payload: { ...body, offset, limit: 200, include_total: includeTotal },
      });
      const ms = performance.now() - start;
      expect(response.statusCode, response.body).toBe(200);
      return { ms, page: recordListResponseSchema.parse(response.json()) };
    };
    const { page } = await run(0, true);
    const matching =
      'total' in page ? page.total : 'total_estimate' in page ? page.total_estimate : 0;
    const offsets = {
      first: 0,
      middle: Math.floor(matching / 2),
      last: Math.max(0, matching - 200),
    };
    for (const [where, offset] of Object.entries(offsets)) {
      const samples: number[] = [];
      for (let i = 0; i < RUNS; i += 1) samples.push((await run(offset, where === 'first')).ms);
      report.push(
        `${label.padEnd(40)} ${where.padEnd(6)} offset=${String(offset).padStart(6)} matching=${String(matching)} p50=${percentile(samples, 50).toFixed(1)}ms p95=${percentile(samples, 95).toFixed(1)}ms`,
      );
    }
  }

  it(
    'query through the link (view filter + sort + group 2 levels)',
    { timeout: 1_800_000 },
    async () => {
      await measure('link: view only', {});
      await measure('link: + viewer filter + sort', {
        filter: { logic: 'and', conditions: [['Đã thanh toán', '==', true]] },
        sort: [{ field: 'Điểm', direction: 'desc' }],
      });
    },
  );
});
