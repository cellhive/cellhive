/**
 * Opt-in automation bench (BACKLOG T519, SPEC §21): `AUTOMATION_BENCH=1 pnpm
 * --filter @cellhive/api test:int test/int/automations.bench` seeds
 * `seed:bench` (200 000 rows, its automations off) on its own
 * Testcontainers database, runs the API and a worker, and reports:
 *
 * 1. dispatching 5 000 `record.updated` events against an enabled automation
 *    whose condition never holds (each event read as `run_as`);
 * 2. 1 000 runs started by one bulk change, under the organization cap of 5
 *    running runs (checked: never more than 5 `running` at once);
 * 3. one `update_records` step writing 10 000 records;
 * 4. the `record.date_reached` scan over the 200 000 rows ("Hạn").
 *
 * Load convention of the S4b benches: it runs only when the 1-minute load
 * (`uptime`) is below 8; otherwise it prints PENDING with this command and
 * skips. Never fails on the numbers (only on wrong results).
 */
import { loadavg } from 'node:os';

import { automationSchema, type Id } from '@cellhive/contracts';
import { AutomationTimeTriggers, SchemaService, type Db } from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BENCH_AUTOMATION_NAMES, BENCH_BULK_MARK } from '../../src/seed/bench-automations.js';
import {
  BENCH_EMAIL,
  BENCH_PASSWORD,
  seedBench,
  type BenchSeedResult,
} from '../../src/seed/bench-seed.js';
import { BENCH_ROWS } from '../../src/seed/bench-table.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { relaxRateLimits } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const COMMAND =
  'AUTOMATION_BENCH=1 pnpm --filter @cellhive/api test:int test/int/automations.bench';
const MAX_LOAD = 8;
const ROWS = Number(process.env['AUTOMATION_BENCH_ROWS'] ?? String(BENCH_ROWS));
const DAY_MS = 86_400_000;

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 900_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

describe.skipIf(process.env['AUTOMATION_BENCH'] !== '1')('automation bench (T519)', () => {
  const load = loadavg()[0] ?? 0;
  const pending = load >= MAX_LOAD;
  const report: string[] = [];
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let worker: WorkerHandle;
  let bench: BenchSeedResult;
  let browser: Browser;
  let ids: Id<'rec'>[] = [];
  const automations = new Map<string, Id<'aut'>>();

  async function call(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
    const response: LightMyRequestResponse = await browser.request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
    });
    return response;
  }

  async function patch(records: { id: Id<'rec'>; fields: Record<string, unknown> }[]) {
    for (let start = 0; start < records.length; start += 1_000) {
      const response = await call('PATCH', `/tables/${bench.tableId}/records?field_key_type=name`, {
        records: records.slice(start, start + 1_000),
      });
      expect(response.statusCode, response.body).toBe(200);
    }
  }

  async function toggle(name: string, state: 'enable' | 'disable') {
    const response = await call('POST', `/automations/${automations.get(name) ?? ''}/${state}`);
    expect(response.statusCode, response.body).toBe(200);
  }

  /** Every event dispatched and no run queued or running in the bench organization. */
  async function idle(): Promise<void> {
    await eventually(
      async () => {
        const { rows } = await sql<{ events: number; runs: number }>`
        SELECT (SELECT count(*)::int FROM meta.events
                 WHERE organization_id = ${bench.organizationId} AND dispatched_at IS NULL) AS events,
               (SELECT count(*)::int FROM meta.automation_runs
                 WHERE organization_id = ${bench.organizationId}
                   AND status IN ('queued', 'running')) AS runs
      `.execute(db.kysely);
        return rows[0]?.events === 0 && rows[0].runs === 0;
      },
      'idle',
      1_800_000,
      250,
    );
  }

  beforeAll(async () => {
    if (pending) {
      process.stdout.write(
        `PENDING automation bench: 1-minute load ${load.toFixed(1)} ≥ ${String(MAX_LOAD)}; run when idle:\n  ${COMMAND}\n`,
      );
      return;
    }
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, LOG_LEVEL: 'warn' });
    relaxRateLimits(t);
    const seeded = Date.now();
    bench = await seedBench(t.app, { rows: ROWS });
    report.push(
      `seed:bench ${String(ROWS)} rows in ${seconds(Date.now() - seeded)}; ${String(bench.settledEvents)} events settled, ${String(bench.automations)} automations`,
    );
    browser = new Browser(t.app);
    expect((await browser.login(BENCH_EMAIL, BENCH_PASSWORD)).statusCode).toBe(204);
    const listed = await call('GET', `/bases/${bench.baseId}/automations`);
    for (const item of listed.json<{ items: { id: Id<'aut'>; name: string }[] }>().items) {
      automations.set(item.name, item.id);
    }
    for (let offset = 0; offset < 16_000; offset += 1_000) {
      const page = await call('POST', `/tables/${bench.tableId}/records/query`, {
        offset,
        limit: 1_000,
      });
      expect(page.statusCode, page.body).toBe(200);
      ids.push(...page.json<{ records: { id: Id<'rec'> }[] }>().records.map((record) => record.id));
    }
    ids = ids.slice(0, 16_000);
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 50 });
    await idle();
  }, 3_600_000);

  afterAll(async () => {
    if (pending) return;
    process.stdout.write(
      `Automation bench (T519, load ${load.toFixed(1)} at start, ${(loadavg()[0] ?? 0).toFixed(1)} at end):\n${report.map((line) => `  ${line}`).join('\n')}\n`,
    );
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  }, 600_000);

  it('dispatches 5 000 events against an enabled automation', async (context) => {
    if (pending) context.skip();
    const fields = (await call('GET', `/tables/${bench.tableId}/fields`)).json<{
      items: { id: Id<'fld'>; name: string }[];
    }>().items;
    const field = (name: string) => fields.find((item) => item.name === name)?.id ?? '';
    const created = await call('POST', `/bases/${bench.baseId}/automations`, {
      name: 'Bench: dispatch',
      enabled: true,
      definition: {
        trigger: {
          type: 'record.updated',
          table_id: bench.tableId,
          watch_fields: [field('Xếp hạng')],
        },
        // Never true: every event is tested (record read as run_as), no run starts.
        condition: {
          op: 'and',
          items: [{ field: field('Xếp hạng'), operator: 'gt', value: 1e12 }],
        },
        actions: [
          {
            id: 'act_1',
            type: 'update_record',
            config: { table_id: bench.tableId, fields: { [field('Giảm giá')]: { literal: 0 } } },
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const dispatchId = automationSchema.parse(created.json()).id;
    const started = Date.now();
    await patch(ids.slice(0, 5_000).map((id, index) => ({ id, fields: { 'Xếp hạng': index } })));
    const written = Date.now() - started;
    await idle();
    const total = Date.now() - started;
    report.push(
      `dispatch 5 000 events: writes ${seconds(written)}, all dispatched after ${seconds(total)} (${String(Math.round(5_000 / (total / 1000)))} events/s)`,
    );
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.automation_runs WHERE automation_id = ${dispatchId}
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe(0);
    expect((await call('POST', `/automations/${dispatchId}/disable`)).statusCode).toBe(200);
  }, 1_800_000);

  it('runs 1 000 runs with at most 5 running at once', async (context) => {
    if (pending) context.skip();
    await toggle(BENCH_AUTOMATION_NAMES.status, 'enable');
    const automationId = automations.get(BENCH_AUTOMATION_NAMES.status) ?? '';
    let maxRunning = 0;
    const sampling = { on: true };
    const sampler = (async () => {
      while (sampling.on) {
        const { rows } = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM meta.automation_runs
           WHERE organization_id = ${bench.organizationId} AND status = 'running'
        `.execute(db.kysely);
        maxRunning = Math.max(maxRunning, rows[0]?.n ?? 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    const started = Date.now();
    await patch(
      ids.slice(5_000, 6_000).map((id) => ({ id, fields: { 'Trạng thái': 'Chờ duyệt' } })),
    );
    const finished = await eventually(
      async () => {
        const { rows } = await sql<{ done: number; open: number }>`
        SELECT count(*) FILTER (WHERE status IN ('succeeded', 'failed', 'skipped'))::int AS done,
               count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS open
          FROM meta.automation_runs WHERE automation_id = ${automationId}
      `.execute(db.kysely);
        return rows[0]?.open === 0 && rows[0].done > 0 ? rows[0] : undefined;
      },
      '1 000 runs',
      1_800_000,
      100,
    );
    const elapsed = Date.now() - started;
    sampling.on = false;
    await sampler;
    const { rows: statuses } = await sql<{ status: string; n: number }>`
      SELECT status, count(*)::int AS n FROM meta.automation_runs
       WHERE automation_id = ${automationId} GROUP BY status
    `.execute(db.kysely);
    report.push(
      `1 000 runs (org cap 5): done in ${seconds(elapsed)} (${(finished.done / (elapsed / 1000)).toFixed(1)} runs/s), max running at once ${String(maxRunning)}; ${statuses.map((row) => `${row.status} ${String(row.n)}`).join(', ')}`,
    );
    // Records whose status already was "Chờ duyệt" do not change: fewer than 1 000 runs.
    expect(finished.done).toBeGreaterThan(700);
    expect(statuses.every((row) => row.status === 'succeeded')).toBe(true);
    expect(maxRunning).toBeLessThanOrEqual(5);
    await toggle(BENCH_AUTOMATION_NAMES.status, 'disable');
    await idle();
  }, 1_800_000);

  it('writes 10 000 records in one update_records step', async (context) => {
    if (pending) context.skip();
    await patch(
      ids.slice(6_000, 16_000).map((id) => ({ id, fields: { 'Địa chỉ': BENCH_BULK_MARK } })),
    );
    await idle();
    await toggle(BENCH_AUTOMATION_NAMES.bulk, 'enable');
    const automationId = automations.get(BENCH_AUTOMATION_NAMES.bulk) ?? '';
    const started = Date.now();
    await patch([{ id: ids[0] as Id<'rec'>, fields: { Mã: 'BENCH-TRIGGER' } }]);
    const run = await eventually(
      async () => {
        const { rows } = await sql<{ id: string; status: string; active_ms: number }>`
        SELECT id, status, active_ms::int AS active_ms FROM meta.automation_runs
         WHERE automation_id = ${automationId} AND status NOT IN ('queued', 'running')
      `.execute(db.kysely);
        return rows[0];
      },
      'update_records run',
      1_800_000,
      100,
    );
    const elapsed = Date.now() - started;
    const { rows: steps } = await sql<{ output: Record<string, unknown> | null }>`
      SELECT output FROM meta.automation_run_steps WHERE run_id = ${run.id}
    `.execute(db.kysely);
    report.push(
      `update_records 10 000: run ${run.status} in ${seconds(elapsed)} (active ${seconds(run.active_ms)}); output ${JSON.stringify(steps[0]?.output ?? null)}`,
    );
    expect(run.status).toBe('succeeded');
    expect(steps[0]?.output).toMatchObject({ matched: 10_000, updated: 10_000 });
    await toggle(BENCH_AUTOMATION_NAMES.bulk, 'disable');
    await idle();
  }, 1_800_000);

  it('scans record.date_reached over the 200 000 rows', async (context) => {
    if (pending) context.skip();
    await toggle(BENCH_AUTOMATION_NAMES.due, 'enable');
    const triggers = new AutomationTimeTriggers(db, {
      defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
      schema: t.app.get(SchemaService),
    });
    const base = Date.now();
    const times: number[] = [];
    let runs = 0;
    // One day per scan (≈ 1/1 100 of the rows each): the first one also builds the index.
    for (let day = 1; day <= 6; day += 1) {
      const began = performance.now();
      const tick = await triggers.scanDates(new Date(base + day * DAY_MS));
      times.push(performance.now() - began);
      runs += tick.runs;
    }
    const [first, ...rest] = times;
    rest.sort((a, b) => a - b);
    report.push(
      `date_reached scan over ${String(ROWS)} rows: first (with index) ${(first ?? 0).toFixed(0)} ms, then median of 5 one-day windows ${(rest[2] ?? 0).toFixed(0)} ms; ${String(runs)} runs queued`,
    );
    expect(runs).toBeGreaterThan(0);
    await toggle(BENCH_AUTOMATION_NAMES.due, 'disable');
    await idle();
  }, 1_800_000);
});
