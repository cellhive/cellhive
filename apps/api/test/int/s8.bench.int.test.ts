/**
 * Opt-in bench of S8 (BACKLOG T917): `S8_BENCH=1 pnpm --filter @cellhive/api
 * test:int test/int/s8.bench`. On the real application (Testcontainers
 * PostgreSQL + Valkey), the 200 000-record table of `seed:bench`
 * (`S8_BENCH_ROWS` overrides the count), a real worker (its AI runner,
 * `AI_CONCURRENCY` of the config, and its main runner) and the fake
 * OpenAI-compatible provider behind a timing proxy, as the bench owner:
 *
 * 1. an AI field on 2 000 records (`S8_BENCH_AI_ROWS`) with the provider
 *    answering in 200 ms: "Generate · empty cells" until the queue is empty —
 *    total time and calls per second; meanwhile one record of another
 *    table every 500 ms: the latency of its `events.dispatch`, and of the
 *    2 000 `record.updated` events the AI writes. One field is one
 *    `ai.generate` job running its batches in order, so a field makes one
 *    call at a time; `AI_CONCURRENCY` runs fields side by side — measured
 *    again with the same 2 000 rows split over two fields;
 * 2. Ask AI on the 200 000 records: four questions (monthly sum, count by
 *    status, a filtered KPI, a sum by region and channel), 10 times each
 *    after a warm-up: route time, provider time (the proxy), and the server
 *    side = route − provider, p50/p95.
 *
 * Numbers are always printed; asserted only when the 1-minute load is below
 * twice the CPU count (as the S7 bench).
 */
import { once } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { availableParallelism, loadavg } from 'node:os';

import { type Id } from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import {
  startFakeOpenAiServer,
  type FakeOpenAiReply,
  type FakeOpenAiServer,
} from '@cellhive/server-core/testing';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { DB } from '../../src/common/tokens.js';
import { BENCH_EMAIL, BENCH_PASSWORD, seedBench } from '../../src/seed/bench-seed.js';
import { BENCH_ROWS } from '../../src/seed/bench-table.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { relaxRateLimits } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse as InjectResponse } from 'fastify';
import type { AddressInfo } from 'node:net';

const ROWS = Number(process.env['S8_BENCH_ROWS'] ?? String(BENCH_ROWS));
const AI_ROWS = Number(process.env['S8_BENCH_AI_ROWS'] ?? '2000');
const PROVIDER_DELAY_MS = 200;
const ASK_RUNS = 10;
const PROBE_EVERY_MS = 500;
const LOCALHOST = () => Promise.resolve(['127.0.0.1']);

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
const spread = (samples: readonly number[]) =>
  `p50 ${ms(percentile(samples, 50))}, p95 ${ms(percentile(samples, 95))}, max ${ms(Math.max(0, ...samples))} (n=${String(samples.length)})`;

/** A proxy in front of the provider that times every call (the provider's share of a request). */
async function timingProxy(target: number): Promise<{
  server: Server;
  port: number;
  durations: number[];
}> {
  const durations: number[] = [];
  const server = createServer((incoming, outgoing) => {
    const started = performance.now();
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: target,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
        answer.on('end', () => durations.push(performance.now() - started));
      },
    );
    upstream.on('error', () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port, durations };
}

describe.skipIf(process.env['S8_BENCH'] !== '1')('S8 bench (T917)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let owner: Browser;
  let fake: FakeOpenAiServer;
  let proxy: Awaited<ReturnType<typeof timingProxy>>;
  let worker: WorkerHandle;
  let organizationId: Id<'org'>;
  let baseId: Id<'bse'>;
  let tableId: Id<'tbl'>;
  const report: string[] = [];

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
    owner.request({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload }) });
  const ok = (response: InjectResponse, status = 200) => {
    expect(response.statusCode, response.body).toBe(status);
    return response;
  };

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp(
      { DATABASE_URL: database.url, LOG_LEVEL: 'warn' },
      { outboundLookup: LOCALHOST },
    );
    relaxRateLimits(t);
    t.app.get(ApiRateLimits).ai = { limit: 100_000, windowSeconds: 60 };
    const seedStarted = Date.now();
    const seeded = await seedBench(t.app, { rows: ROWS });
    report.push(
      `seed:bench ${String(seeded.rows)} rows in ${((Date.now() - seedStarted) / 1000).toFixed(0)} s`,
    );
    organizationId = seeded.organizationId;
    baseId = seeded.baseId;
    tableId = seeded.tableId;
    owner = new Browser(t.app);
    ok(await owner.login(BENCH_EMAIL, BENCH_PASSWORD), 204);

    fake = await startFakeOpenAiServer();
    proxy = await timingProxy(fake.port);
    ok(
      await call('POST', `/orgs/${organizationId}/http-allowlist`, {
        pattern: `localhost:${String(proxy.port)}`,
      }),
      201,
    );
    ok(
      await call('PUT', `/orgs/${organizationId}/ai-settings`, {
        enabled: true,
        provider_base_url: `http://localhost:${String(proxy.port)}/v1`,
        model: 'fake-model',
        allow_record_data: true,
        confirm: true,
        daily_token_limit: null,
      }),
    );
    const { logger } = captureLogger();
    worker = await createWorker(t.config, {
      logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db: t.app.get<Db>(DB),
        logger,
        ai: { lookup: LOCALHOST },
      }),
    });
  }, 1_800_000);

  afterAll(async () => {
    process.stdout.write(
      `\nS8 bench (load ${loadText()}, ${String(availableParallelism())} CPUs, AI_CONCURRENCY ${String(t.config.limits.aiConcurrency)})\n${report.map((line) => `  ${line}`).join('\n')}\n`,
    );
    await worker.close();
    proxy.server.close();
    await fake.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  /** Until no row of `fieldIds` is queued or running. */
  async function drained(fieldIds: readonly string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM meta.ai_generation_queue
         WHERE field_id = ANY(${fieldIds}) AND status IN ('queued', 'running')`.execute(db.kysely);
      if (rows[0]?.n === 0) return;
      if (Date.now() > deadline) throw new Error('the AI queue did not drain');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** `dispatched_at - created_at` of events, once all are dispatched. */
  async function dispatchLatencies(entityIds: readonly string[], since: Date) {
    for (;;) {
      const { rows } = await sql<{ ms: number | null }>`
        SELECT (extract(epoch FROM dispatched_at - created_at) * 1000)::float8 AS ms
          FROM meta.events
         WHERE organization_id = ${organizationId} AND created_at >= ${since}
           AND entity_id = ANY(${[...entityIds]})`.execute(db.kysely);
      if (rows.every((row) => row.ms !== null)) return rows.map((row) => row.ms ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Generates the empty cells of `fields` (record ids per field) while probing dispatch. */
  async function generate(
    label: string,
    aiRecords: readonly string[],
    probeTable: Id<'tbl'>,
    fields: readonly { readonly id: string; readonly recordIds: readonly string[] | null }[],
  ): Promise<{ seconds: number; calls: number }> {
    const since = (await sql<{ now: Date }>`SELECT now() AS now`.execute(db.kysely)).rows[0]
      ?.now as Date;
    const callsBefore = fake.chatRequests().length;
    const probes: string[] = [];
    const probing = { on: true };
    const probe = (async () => {
      while (probing.on) {
        const created = ok(
          await call('POST', `/tables/${probeTable}/records`, {
            records: [{ fields: {} }],
          }),
          201,
        ).json<{ records: { id: string }[] }>();
        probes.push(created.records[0]?.id ?? '');
        await new Promise((resolve) => setTimeout(resolve, PROBE_EVERY_MS));
      }
    })();
    const started = performance.now();
    for (const field of fields) {
      ok(
        await call(
          'POST',
          `/fields/${field.id}/ai/generate`,
          field.recordIds === null
            ? { scope: 'empty' }
            : { scope: 'records', record_ids: field.recordIds },
        ),
        202,
      );
    }
    await drained(
      fields.map((field) => field.id),
      3_600_000,
    );
    const seconds = (performance.now() - started) / 1000;
    probing.on = false;
    await probe;
    const calls = fake.chatRequests().length - callsBefore;
    const probeLatency = await dispatchLatencies(probes, since);
    const writes = await dispatchLatencies(aiRecords, since);
    report.push(
      `${label}: ${String(calls)} calls in ${seconds.toFixed(1)} s = ${(calls / seconds).toFixed(2)} calls/s ` +
        `(provider ${String(PROVIDER_DELAY_MS)} ms per call)`,
      `  events.dispatch of a record of another table every ${String(PROBE_EVERY_MS)} ms: ${spread(probeLatency)}`,
      `  events.dispatch of the AI writes (record.updated): ${spread(writes)}`,
    );
    if (quiet()) expect(percentile(probeLatency, 95)).toBeLessThan(2_500);
    return { seconds, calls };
  }

  it(`AI field: ${String(AI_ROWS)} rows, provider at ${String(PROVIDER_DELAY_MS)} ms per call`, async () => {
    const table = async (name: string) =>
      ok(
        await call('POST', `/bases/${baseId}/tables`, { name, primary_field_name: 'Tiêu đề' }),
        201,
      ).json<{ id: Id<'tbl'>; primary_field_id: string }>();
    const aiTable = await table('AI bench');
    const probeTable = await table('Dispatch probe');
    const description = ok(
      await call('POST', `/tables/${aiTable.id}/fields`, { name: 'Mô tả', type: 'text' }),
      201,
    ).json<{ id: string }>().id;
    const ids: string[] = [];
    for (let start = 0; start < AI_ROWS; start += 1_000) {
      const created = ok(
        await call('POST', `/tables/${aiTable.id}/records?field_key_type=id`, {
          records: Array.from({ length: Math.min(1_000, AI_ROWS - start) }, (_v, index) => ({
            fields: {
              [aiTable.primary_field_id]: `Phiếu ${String(start + index + 1)}`,
              [description]: `Khách báo máy POS số ${String((start + index) % 40)} lỗi in hoá đơn.`,
            },
          })),
        }),
        201,
      ).json<{ records: { id: string }[] }>();
      ids.push(...created.records.map((record) => record.id));
    }
    // Created after the records: a new AI field generates nothing by itself (Quyết định S8 #18).
    const aiField = async (name: string) =>
      ok(
        await call('POST', `/tables/${aiTable.id}/fields`, {
          name,
          type: 'text',
          options: { ai: { task: 'summarize', prompt: 'Tóm tắt: {{ [Mô tả] }}' } },
        }),
        201,
      ).json<{ id: string }>().id;
    fake.capabilities.delayMs = PROVIDER_DELAY_MS;
    try {
      const one = await generate('1 field', ids, probeTable.id, [
        { id: await aiField('Tóm tắt'), recordIds: null },
      ]);
      expect(one.calls).toBe(AI_ROWS);
      // The same rows over two fields: two jobs side by side (AI_CONCURRENCY).
      const half = Math.ceil(ids.length / 2);
      const two = await generate('2 fields side by side', ids, probeTable.id, [
        { id: await aiField('Tóm tắt A'), recordIds: ids.slice(0, half) },
        { id: await aiField('Tóm tắt B'), recordIds: ids.slice(half) },
      ]);
      expect(two.calls).toBe(AI_ROWS);
      report.push(`  speed-up of 2 fields: ×${(one.seconds / two.seconds).toFixed(2)}`);
    } finally {
      fake.capabilities.delayMs = 0;
    }
  }, 3_600_000);

  it(`Ask AI on ${String(ROWS)} rows: p95 on the server side, without the provider`, async () => {
    const fields = ok(await call('GET', `/tables/${tableId}/fields`)).json<{
      items: { name: string; options: { options?: { name: string }[] } }[];
    }>().items;
    const region = fields.find((field) => field.name === 'Khu vực')?.options.options?.[0]?.name;
    const plan = (extra: Record<string, unknown>): FakeOpenAiReply => ({
      content: JSON.stringify({
        answerable: true,
        chart: 'bar',
        title: 'Bench',
        metric: { aggregation: 'count', field: null },
        dimension: null,
        series: null,
        filter: null,
        sort: null,
        limit: null,
        compare: null,
        ...extra,
      }),
    });
    const questions: readonly [string, FakeOpenAiReply][] = [
      [
        'Tổng số tiền theo tháng tạo đơn',
        plan({
          chart: 'line',
          metric: { aggregation: 'sum', field: 'Số tiền' },
          dimension: { field: 'Ngày tạo đơn', date_bucket: 'month' },
        }),
      ],
      ['Số đơn theo trạng thái', plan({ dimension: { field: 'Trạng thái', date_bucket: null } })],
      [
        `Tổng số tiền ở ${String(region)}`,
        plan({
          chart: 'kpi',
          metric: { aggregation: 'sum', field: 'Số tiền' },
          filter: { logic: 'and', conditions: [['Khu vực', '==', region]] },
        }),
      ],
      [
        'Chi phí trung bình theo khu vực và kênh',
        plan({
          metric: { aggregation: 'avg', field: 'Chi phí' },
          dimension: { field: 'Khu vực', date_bucket: null },
          series: { field: 'Kênh', date_bucket: null },
        }),
      ],
    ];
    const all: number[] = [];
    for (const [question, answer] of questions) {
      const route: number[] = [];
      const server: number[] = [];
      const provider: number[] = [];
      for (let run = 0; run <= ASK_RUNS; run += 1) {
        fake.script(answer);
        const before = proxy.durations.length;
        const started = performance.now();
        const response = ok(
          await call('POST', `/tables/${tableId}/ai/ask`, {
            question,
            timezone: 'Asia/Ho_Chi_Minh',
          }),
        );
        const elapsed = performance.now() - started;
        expect(response.json<{ status: string }>().status).toBe('ok');
        const spent = proxy.durations.slice(before).reduce((total, value) => total + value, 0);
        // Run 0 warms the plan and the database caches.
        if (run === 0) continue;
        route.push(elapsed);
        provider.push(spent);
        server.push(elapsed - spent);
      }
      all.push(...server);
      report.push(
        `Ask "${question}": route ${spread(route)}; provider ${spread(provider)}; server ${spread(server)}`,
      );
    }
    report.push(`Ask, all questions, server side: ${spread(all)}`);
  }, 1_800_000);
});
