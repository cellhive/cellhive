/**
 * Opt-in bench of S7 (BACKLOG T818): `S7_BENCH=1 pnpm --filter @cellhive/api
 * test:int test/int/s7.bench`. On the real application (Testcontainers
 * PostgreSQL + Valkey) and the 200 000-record table of `seed:bench` (the
 * `test:e2e:perf` set; `S7_BENCH_ROWS` overrides the count), as the bench
 * owner over a session:
 *
 * 1. a dashboard of 5 widgets (KPI sum, stacked bar, weekly line, pie, top
 *    10 table) without cache: one record write before each round makes every
 *    entry stale (`data_version`), then the 5 data requests in parallel like
 *    the page — p50/p95 per widget and of the whole round;
 * 2. the same with a warm cache (no write between rounds);
 * 3. 20 viewers opening it at once after a write: wall time, computations
 *    actually run (`RecordQueryService.widgetData` calls; coalescing → one
 *    per aggregate widget, while the records table — never cached, §28.5 —
 *    runs once per viewer);
 * 4. a large `count_distinct` (Email: one value per record) without cache;
 * 5. 100 record writes per second for 10 s while 50 WebSocket connections
 *    watch `dashboard:<id>`: `dashboard.data_changed` messages per
 *    connection (5 s gathering → 2–3 expected) and write latency;
 * 6. (T904) `count_distinct` of list fields on 1 000 000 records × 3 values
 *    (`S7_BENCH_LIST_ROWS` overrides; written directly, the services would
 *    take hours): KPI of a multi-select, KPI of a link, bar select ×
 *    multi-select + "Other", each run by `RecordQueryService.widgetData` on a
 *    fresh backend — time, its peak private memory (`RssAnon`, with parallel
 *    workers) and the `temp_bytes` it wrote.
 *
 * Numbers are always printed; asserted only when the 1-minute load is below
 * twice the CPU count (BACKLOG S7 "Test"). The < 2 s budget of the milestone
 * is measured in the browser by `apps/web/e2e/t818-dashboard-perf.spec.ts`
 * (nightly `perf` job, T801).
 */
import { availableParallelism, loadavg } from 'node:os';

import { newId, widgetDataSchema, type Id } from '@cellhive/contracts';
import {
  AppError,
  createDb,
  orgScope,
  RecordQueryService,
  type Db,
  type WidgetAggregateResult,
  type WidgetQuery,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RealtimeLimits } from '../../src/modules/realtime/realtime-limits.js';
import { BENCH_EMAIL, BENCH_PASSWORD, seedBench } from '../../src/seed/bench-seed.js';
import { BENCH_CUSTOMERS_TABLE_NAME, BENCH_ROWS } from '../../src/seed/bench-table.js';
import { ownerAccessContext } from '../../src/seed/record-seeding.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { relaxRateLimits } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse as InjectResponse } from 'fastify';

const ROWS = Number(process.env['S7_BENCH_ROWS'] ?? String(BENCH_ROWS));
const LIST_ROWS = Number(process.env['S7_BENCH_LIST_ROWS'] ?? '1000000');
const LIST_RUNS = 3;
/** `application_name` of the backend case 6 measures. */
const BENCH_BACKEND = 'cellhive-t904-bench';
const ROUNDS = 10;
const VIEWERS = 20;
const SOCKETS = 50;
const WRITES_PER_SECOND = 100;
const WRITE_SECONDS = 10;

const quiet = () => (loadavg()[0] ?? 0) < 2 * availableParallelism();
const loadText = () =>
  loadavg()
    .map((value) => value.toFixed(1))
    .join(' / ');

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

const ms = (value: number) => `${value.toFixed(0)} ms`;
const p50p95 = (samples: readonly number[]) =>
  `p50 ${ms(percentile(samples, 50))}, p95 ${ms(percentile(samples, 95))}`;

describe.skipIf(process.env['S7_BENCH'] !== '1')('S7 bench (T818)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let wsUrl: string;
  let owner: Browser;
  let tableId: Id<'tbl'>;
  let baseId: Id<'bse'>;
  let organizationId: Id<'org'>;
  let dashboardId: string;
  let recordIds: string[] = [];
  let amountField = '';
  const widgets: { id: string; title: string }[] = [];
  let distinct: { id: string; title: string };
  const report: string[] = [];
  const sockets: TestSocket[] = [];
  let writes = 0;

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    owner.request({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload }) });
  const ok = (response: InjectResponse, status = 200) => {
    expect(response.statusCode, response.body).toBe(status);
    return response;
  };

  /** One widget's data; returns the elapsed time and the cache result. */
  async function load(widgetId: string): Promise<{ ms: number; cache: string }> {
    const started = performance.now();
    const response = ok(await call('POST', `/widgets/${widgetId}/data`, { filters: [] }));
    const elapsed = performance.now() - started;
    const body = widgetDataSchema.parse(response.json());
    expect(body.status).toBe('ok');
    return { ms: elapsed, cache: body.cache };
  }

  /** Changes one record: every widget of the table gets a new data version. */
  async function write(): Promise<void> {
    writes += 1;
    const id = recordIds[writes % recordIds.length] ?? '';
    ok(
      await call('PATCH', `/tables/${tableId}/records?field_key_type=id`, {
        records: [{ id, fields: { [amountField]: 1_000 + writes } }],
      }),
    );
  }

  /**
   * `work` while the private resident memory (`RssAnon` of
   * `/proc/<pid>/status`, read by the container's superuser) of the
   * `BENCH_BACKEND` backend and its parallel workers is sampled every 20 ms:
   * the peak of their sum.
   */
  async function peakMemory<T>(work: () => Promise<T>): Promise<{ result: T; peakKb: number }> {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    let peakKb = 0;
    const stop = new AbortController();
    const sampling = (async () => {
      while (!stop.signal.aborted) {
        const { rows } = await client.query<{ status: string | null }>(
          `SELECT pg_read_file('/proc/' || pid || '/status', true) AS status
             FROM pg_stat_activity
            WHERE application_name = $1
               OR leader_pid IN (SELECT pid FROM pg_stat_activity WHERE application_name = $1)`,
          [BENCH_BACKEND],
        );
        const kb = rows.reduce(
          (sum, row) => sum + Number(/RssAnon:\s+(\d+)/u.exec(row.status ?? '')?.[1] ?? 0),
          0,
        );
        peakKb = Math.max(peakKb, kb);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    let result: T;
    try {
      result = await work();
    } finally {
      stop.abort();
      await sampling;
      await client.end();
    }
    return { result, peakKb };
  }

  async function tempBytes(): Promise<number> {
    const { rows } = await sql<{ bytes: string }>`
      SELECT temp_bytes AS bytes FROM pg_stat_database WHERE datname = current_database()
    `.execute(db.kysely);
    return Number(rows[0]?.bytes ?? 0);
  }

  /** The 5 widgets in parallel, like the page: per-widget and round times. */
  async function round(): Promise<{ total: number; each: number[]; caches: string[] }> {
    const started = performance.now();
    const results = await Promise.all(widgets.map((widget) => load(widget.id)));
    return {
      total: performance.now() - started,
      each: results.map((result) => result.ms),
      caches: results.map((result) => result.cache),
    };
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, LOG_LEVEL: 'warn' });
    relaxRateLimits(t);
    wsUrl = await listen(t.app);
    const seedStarted = Date.now();
    const seeded = await seedBench(t.app, { rows: ROWS });
    report.push(
      `seed:bench ${String(seeded.rows)} rows in ${((Date.now() - seedStarted) / 1000).toFixed(0)} s`,
    );
    tableId = seeded.tableId;
    owner = new Browser(t.app);
    ok(await owner.login(BENCH_EMAIL, BENCH_PASSWORD), 204);

    const fields = ok(await call('GET', `/tables/${tableId}/fields`)).json<{
      items: { id: string; name: string }[];
    }>().items;
    const field = (name: string): string => {
      const found = fields.find((item) => item.name === name);
      if (found === undefined) throw new Error(`The bench table has no field ${name}`);
      return found.id;
    };
    amountField = field('Số tiền');
    const page = ok(
      await call('POST', `/tables/${tableId}/records/query`, {
        fields: [],
        limit: 200,
        include_total: false,
      }),
    ).json<{ records: { id: string }[] }>();
    recordIds = page.records.map((record) => record.id);

    baseId = seeded.baseId;
    organizationId = seeded.organizationId;
    const dashboard = ok(
      await call('POST', `/bases/${seeded.baseId}/dashboards`, { name: 'S7 bench' }),
      201,
    ).json<{ id: string }>();
    dashboardId = dashboard.id;
    const add = async (title: string, type: string, config: Record<string, unknown>) => {
      const created = ok(
        await call('POST', `/dashboards/${dashboardId}/widgets`, {
          type,
          title,
          config: { table_id: tableId, ...config },
        }),
        201,
      ).json<{ id: string }>();
      return { id: created.id, title };
    };
    const amount = [{ id: 'm1', aggregation: 'sum', field: amountField }];
    const count = [{ id: 'm1', aggregation: 'count' }];
    widgets.push(
      await add('kpi sum', 'kpi', { metrics: amount }),
      await add('bar stacked', 'bar', {
        dimension: { field: field('Trạng thái') },
        series_dimension: { field: field('Khu vực') },
        metrics: count,
        display: { stack: 'stacked' },
      }),
      await add('line week', 'line', {
        dimension: { field: field('Ngày tạo đơn'), date_bucket: 'week' },
        metrics: count,
        sort: 'dimension_asc',
        limit: 30,
      }),
      await add('pie sum', 'pie', { dimension: { field: field('Kênh') }, metrics: amount }),
      await add('table top 10', 'table', {
        table: {
          mode: 'records',
          fields: [field('Mã'), field('Trạng thái'), amountField],
          sort: { field: amountField, direction: 'desc' },
          limit: 10,
        },
      }),
    );
    distinct = await add('count_distinct Email', 'kpi', {
      metrics: [{ id: 'm1', aggregation: 'count_distinct', field: field('Email') }],
    });
  }, 3_600_000);

  afterAll(async () => {
    process.stdout.write(
      `\nT818 S7 bench (${String(ROWS)} rows, load ${loadText()})\n${report.join('\n')}\n`,
    );
    await closeSockets(sockets);
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('1. five widgets without cache: p50/p95 per widget and per round', async () => {
    const rounds: Awaited<ReturnType<typeof round>>[] = [];
    for (let index = 0; index < ROUNDS; index += 1) {
      await write();
      rounds.push(await round());
    }
    expect(rounds.every((each) => each.caches.every((cache) => cache === 'miss'))).toBe(true);
    widgets.forEach((widget, index) => {
      report.push(
        `1. cold  ${widget.title.padEnd(22)} ${p50p95(rounds.map((each) => each.each[index] ?? 0))}`,
      );
    });
    const totals = rounds.map((each) => each.total);
    report.push(`1. cold  5 widgets (parallel)     ${p50p95(totals)}`);
    if (quiet()) expect(percentile(totals, 50)).toBeLessThan(2_000);
  }, 600_000);

  it('2. five widgets from the cache', async () => {
    await round();
    const rounds: Awaited<ReturnType<typeof round>>[] = [];
    for (let index = 0; index < ROUNDS; index += 1) rounds.push(await round());
    // Records tables are never cached (CONTRACTS §28.5): the last widget computes each time.
    expect(rounds.every((each) => each.caches.join() === 'hit,hit,hit,hit,miss')).toBe(true);
    widgets.forEach((widget, index) => {
      report.push(
        `2. warm  ${widget.title.padEnd(22)} ${p50p95(rounds.map((each) => each.each[index] ?? 0))}`,
      );
    });
    const totals = rounds.map((each) => each.total);
    report.push(`2. warm  5 widgets (parallel)     ${p50p95(totals)}`);
    if (quiet()) expect(percentile(totals, 95)).toBeLessThan(500);
  }, 600_000);

  it('3. twenty viewers at once after a write: one computation per widget', async () => {
    await write();
    const spy = vi.spyOn(t.app.get(RecordQueryService), 'widgetData');
    const started = performance.now();
    const viewers = await Promise.all(Array.from({ length: VIEWERS }, () => round()));
    const wall = performance.now() - started;
    const computed = spy.mock.calls.length;
    spy.mockRestore();
    const hits = viewers.flatMap((each) => each.caches).filter((cache) => cache === 'hit').length;
    report.push(
      `3. ${String(VIEWERS)} viewers × 5 widgets: wall ${ms(wall)}, ${String(computed)} computations, ${String(hits)} hits of ${String(VIEWERS * widgets.length)}; per round ${p50p95(viewers.map((each) => each.total))}`,
    );
    // One computation per aggregate widget; the records table once per viewer.
    expect(computed).toBe(widgets.length - 1 + VIEWERS);
  }, 600_000);

  it('4. a large count_distinct without cache', async () => {
    const samples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      await write();
      const answer = await load(distinct.id);
      expect(answer.cache).toBe('miss');
      samples.push(answer.ms);
    }
    const body = widgetDataSchema.parse(
      ok(await call('POST', `/widgets/${distinct.id}/data`, { filters: [] })).json(),
    );
    const value = body.rows[0]?.[0];
    report.push(`4. count_distinct Email (= ${String(value)}) ${p50p95(samples)}`);
  }, 600_000);

  it('5. 100 writes/s for 10 s with 50 connections on the dashboard', async () => {
    // 50 tabs of one person: above the 10 connections a user may hold (§7).
    t.app.get(RealtimeLimits).maxConnectionsPerUser = SOCKETS;
    for (let index = 0; index < SOCKETS; index += 1) {
      const socket = await TestSocket.connect(wsUrl, {
        origin: TEST_PUBLIC_URL,
        cookie: owner.cookieHeader(),
      });
      sockets.push(socket);
      expect(await socket.subscribe(`dashboard:${dashboardId}`)).toMatchObject({
        type: 'subscribed',
      });
    }
    const latencies: number[] = [];
    const pending: Promise<void>[] = [];
    const started = performance.now();
    const total = WRITES_PER_SECOND * WRITE_SECONDS;
    for (let index = 0; index < total; index += 1) {
      const due = started + (index * 1_000) / WRITES_PER_SECOND;
      const wait = due - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const sent = performance.now();
      pending.push(
        write().then(() => {
          latencies.push(performance.now() - sent);
        }),
      );
    }
    await Promise.all(pending);
    const writeMs = performance.now() - started;
    // The last gathering window (5 s) ends after the writes.
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    const counts = sockets.map(
      (socket) =>
        socket.received.filter((message) => message.type === 'dashboard.data_changed').length,
    );
    report.push(
      `5. ${String(total)} writes in ${ms(writeMs)} (${(total / (writeMs / 1000)).toFixed(0)}/s), write ${p50p95(latencies)}; data_changed per connection min ${String(Math.min(...counts))}, max ${String(Math.max(...counts))}, total ${String(counts.reduce((sum, n) => sum + n, 0))} for ${String(SOCKETS)} connections`,
    );
    expect(Math.min(...counts)).toBeGreaterThan(0);
    // One hint per 5 s window at most: 10 s of writes → ≤ 4 with the edges.
    expect(Math.max(...counts)).toBeLessThanOrEqual(4);
  }, 600_000);

  it('6. count_distinct of list fields on 1 000 000 records × 3 values (T904)', async () => {
    const groups = Array.from({ length: 10 }, (_, i) => ({
      id: newId('opt'),
      name: `G${String(i)}`,
    }));
    const tags = Array.from({ length: 1_000 }, (_, i) => ({
      id: newId('opt'),
      name: `T${String(i)}`,
    }));
    const list = ok(
      await call('POST', `/bases/${baseId}/tables`, {
        name: 'T904 lists',
        primary_field_name: 'Tên',
      }),
      201,
    ).json<{ id: Id<'tbl'> }>().id;
    const { rows: targets } = await sql<{ id: string; name: string }>`
      SELECT id, db_table_name AS name FROM meta.tables
       WHERE base_id = ${baseId} AND name = ${BENCH_CUSTOMERS_TABLE_NAME}
    `.execute(db.kysely);
    const customers = targets[0] as { id: string; name: string };
    const addField = async (body: Record<string, unknown>) =>
      ok(await call('POST', `/tables/${list}/fields`, body), 201).json<{ id: string }>().id;
    const groupField = await addField({
      name: 'Nhóm',
      type: 'select',
      options: { options: groups },
    });
    const tagsField = await addField({
      name: 'Nhãn',
      type: 'select',
      options: { multiple: true, options: tags },
    });
    const linkField = await addField({
      name: 'Khách hàng',
      type: 'link',
      options: { link_table: customers.id },
    });
    const { rows: meta } = await sql<{
      id: string;
      column_name: string;
      junction: string;
      side: string;
      is_primary: boolean;
      table_name: string;
    }>`
      SELECT f.id, f.db_column_name AS column_name, f.link_junction AS junction,
             f.link_side AS side, f.is_primary, t.db_table_name AS table_name
        FROM meta.fields AS f JOIN meta.tables AS t ON t.id = f.table_id
       WHERE f.table_id = ${list} AND f.deleted_at IS NULL
    `.execute(db.kysely);
    const column = (id: string) => sql.id(meta.find((row) => row.id === id)?.column_name ?? '');
    const primary = meta.find((row) => row.is_primary);
    const link = meta.find((row) => row.id === linkField);
    expect(link?.side).toBe('a');
    const dataTable = sql.id(primary?.table_name ?? '');
    // TEST FIXTURE: written directly (the services would take hours); 3 tags, 3 links per record.
    const insertStarted = performance.now();
    const writer = createDb({ url: database.url, poolMax: 1, statementTimeoutMs: 0 });
    try {
      const id = sql`'rec_' || substr(md5('t904-' || g), 1, 16)`;
      for (let start = 0; start < LIST_ROWS; start += 200_000) {
        const end = Math.min(LIST_ROWS, start + 200_000) - 1;
        await sql`
          INSERT INTO data.${dataTable} (__id, ${column(primary?.id ?? '')}, ${column(groupField)}, ${column(tagsField)})
          SELECT ${id}, 'r' || g, ARRAY[o.gs[1 + g % 10]],
                 ARRAY[o.ts[1 + g % 1000], o.ts[1 + (g + 333) % 1000], o.ts[1 + (g + 666) % 1000]]
            FROM generate_series(${start}::int, ${end}::int) AS g,
                 (SELECT ${sql.val(groups.map((o) => o.id))}::text[] AS gs,
                         ${sql.val(tags.map((o) => o.id))}::text[] AS ts) AS o
        `.execute(writer.kysely);
        await sql`
          INSERT INTO data.${sql.id(link?.junction ?? '')} (a_id, b_id, position)
          SELECT ${id}, c.ids[1 + (3 * g + k) % cardinality(c.ids)], k
            FROM generate_series(${start}::int, ${end}::int) AS g, generate_series(0, 2) AS k,
                 (SELECT array_agg(__id) AS ids FROM data.${sql.id(customers.name)}) AS c
        `.execute(writer.kysely);
      }
      await sql`VACUUM (ANALYZE) data.${dataTable}`.execute(writer.kysely);
      await sql`VACUUM (ANALYZE) data.${sql.id(link?.junction ?? '')}`.execute(writer.kysely);
    } finally {
      await writer.destroy();
    }
    report.push(
      `6. ${String(LIST_ROWS)} records × 3 tags × 3 links written in ${ms(performance.now() - insertStarted)}`,
    );

    const { rows: owners } = await sql<{ id: Id<'usr'> }>`
      SELECT id FROM meta.users WHERE email = ${BENCH_EMAIL}
    `.execute(db.kysely);
    const scope = orgScope(organizationId);
    const access = await ownerAccessContext(db, scope, baseId, owners[0]?.id as Id<'usr'>, {
      timeZone: 'UTC',
      locale: 'vi',
    });
    const metric = (field: string) => ({
      id: 'm1',
      aggregation: 'count_distinct' as const,
      field: field as Id<'fld'>,
    });
    const cases: { title: string; query: WidgetQuery }[] = [
      {
        title: 'kpi cd multi-select',
        query: {
          kind: 'kpi',
          tableId: list,
          filter: null,
          metric: metric(tagsField),
          compare: null,
        },
      },
      {
        title: 'kpi cd link',
        query: {
          kind: 'kpi',
          tableId: list,
          filter: null,
          metric: metric(linkField),
          compare: null,
        },
      },
      {
        title: 'bar select × cd multi-select + Other',
        query: {
          kind: 'grouped',
          tableId: list,
          filter: null,
          dimension: { field: groupField as Id<'fld'>, dateBucket: null, bucketWidth: null },
          series: null,
          metrics: [metric(tagsField), { id: 'm2', aggregation: 'count', field: null }],
          sort: 'metric_desc',
          limit: 5,
          groupOthers: true,
        },
      },
    ];
    const outcomes: string[] = [];
    const peaks: number[] = [];
    for (const { title, query } of cases) {
      const samples: { ms: number; peakKb: number; temp: number }[] = [];
      let answer: WidgetAggregateResult | string = '';
      for (let run = 0; run < LIST_RUNS; run += 1) {
        // A fresh backend per run (no widget cache on this path): its memory
        // and temp files are this statement's alone.
        const fresh = createDb({ url: database.url, poolMax: 1, applicationName: BENCH_BACKEND });
        try {
          const before = await tempBytes();
          const started = performance.now();
          const measured = await peakMemory(() =>
            new RecordQueryService(fresh, { defaultTimeZone: 'UTC' })
              .widgetData(scope, access, query, { timeZone: 'UTC' })
              // Reported, not thrown: a `QUERY_TIMEOUT` (10 s) is a number of the bench too.
              .catch((error: unknown) => (error instanceof AppError ? error.code : String(error))),
          );
          const elapsed = performance.now() - started;
          // Flushed when the backend goes idle after this call (temp files of the run).
          await sql`SELECT pg_stat_force_next_flush()`.execute(fresh.kysely);
          samples.push({
            ms: elapsed,
            peakKb: measured.peakKb,
            temp: (await tempBytes()) - before,
          });
          answer = measured.result;
          outcomes.push(typeof answer === 'string' ? answer : answer.status);
        } finally {
          await fresh.destroy();
        }
      }
      const value =
        typeof answer === 'string' ? answer : (answer.total ?? answer.rows[0]?.[0] ?? null);
      const peak = Math.max(...samples.map((sample) => sample.peakKb));
      const temp = Math.max(...samples.map((sample) => sample.temp));
      peaks.push(peak);
      report.push(
        `6. ${title.padEnd(38)} (= ${JSON.stringify(value)}) ${p50p95(samples.map((sample) => sample.ms))}, peak RssAnon ${(peak / 1024).toFixed(0)} MB, temp ${(temp / 1024 / 1024).toFixed(0)} MB`,
      );
    }
    // A run may hit the 10 s timeout (reading 3 000 000 links); never another error.
    expect(outcomes.filter((outcome) => outcome !== 'ok' && outcome !== 'QUERY_TIMEOUT')).toEqual(
      [],
    );
    // T904: bounded by `work_mem`, not by the lists (the `jsonb_agg` statement: 150–630 MB).
    expect(Math.max(...peaks)).toBeLessThan(128 * 1024);
  }, 3_600_000);
});
