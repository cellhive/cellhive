/**
 * Opt-in S5c bench (BACKLOG T615): `WEBHOOK_BENCH=1 pnpm --filter
 * @cellhive/api test:int test/int/webhooks.bench` — its own Testcontainers
 * database, the API and a real worker (its own pool `cellhive-worker`, the
 * production Valkey host pacer: 10/s with a burst of 20 per (org, host), 2
 * calls in flight per organization), and reports:
 *
 * 1. **in**: one hook (`auth = bearer`) at 50 req/s for 60 s through the
 *    HTTP API, an enabled automation creating one Orders record per request:
 *    answers by status, lost requests (stored rows/events vs sent), p50/p95/
 *    p99 of the route, PostgreSQL commits and row writes per second over the
 *    window, the automation backlog drained after the last request, bytes
 *    per stored request;
 * 2. **hook lookup** (`AutomationsRepository.listEnabledForWebhook`, BACKLOG
 *    T604 carry-over): 1 000 enabled automations in the organization, 100 of
 *    them on 10 hooks — p50/p95 of the query and its plan, to decide on the
 *    partial expression index;
 * 3. **out**: 1 000 calls to 5 hosts (200 each) through the outbox: drain
 *    time from the enqueue to the last answer, most calls a host got in any
 *    second (bucket: 20 + 10/s), p50/p95 of enqueue → received;
 * 4. **slow**: 20 calls to a destination answering after 9 s (10
 *    organizations, 2 each): most worker connections active or idle in a
 *    transaction while they wait (expected 0 beyond the job polling), and
 *    how long an unrelated event waits for its dispatch meanwhile.
 *
 * Load convention of the S5b benches: the 1/5/15-minute load average is
 * printed with every number; it never fails on the numbers, only on wrong
 * results (lost requests, calls over the pacing).
 */
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { cpus, loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';

import { incomingWebhookWithSecretsSchema, newId, type Id } from '@cellhive/contracts';
import {
  AutomationsRepository,
  createDb,
  createValkeyHostPacer,
  HttpOutbox,
  JOB_STATEMENT_TIMEOUT_MS,
  measureHttpDeliveryBacklog,
  orgScope,
  valkeyQuotaClient,
  type Db,
} from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { IncomingWebhookRateLimits } from '../../src/common/rate-limit/incoming-webhook-rate-limits.js';
import { DB } from '../../src/common/tokens.js';

import { Browser, seedOrg, seedUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { AddressInfo, Socket } from 'node:net';

const IN_RATE = 50;
const IN_SECONDS = 60;
const OUT_CALLS = 1_000;
const OUT_HOSTS = 5;
const SLOW_CALLS = 20;
const SLOW_ORGS = 10;
const SLOW_MS = 9_000;
const LOOKUP_AUTOMATIONS = 1_000;
const LOOKUP_WEBHOOK_AUTOMATIONS = 100;
const LOOKUP_HOOKS = 10;
/** Requests near the 1 MiB body cap for the request-table size (T617, QA S5c M3). */
const CAP_REQUESTS = 60;

const load = () =>
  loadavg()
    .map((value) => value.toFixed(1))
    .join(' / ');
const ms = (value: number) => `${value.toFixed(1)} ms`;
const pct = (sorted: readonly number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

function report(line: string): void {
  process.stdout.write(`[T615 bench] ${line} (load ${load()}, ${String(cpus().length)} CPUs)\n`);
}

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 600_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Most of `times` (ms) within any window of one second. */
function maxWithinOneSecond(times: readonly number[]): number {
  const sorted = [...times].sort((x, y) => x - y);
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while ((sorted[end] ?? 0) - (sorted[start] ?? 0) >= 1_000) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/**
 * Samples the outbound backlog every 250 ms with the query of the gauge
 * `http_delivery_oldest_pending_seconds` (T617): the most rows `pending` or
 * `sending` and the oldest of them seen until `stop()`.
 */
function sampleBacklog(db: Db): {
  stop(): Promise<{ mostPending: number; oldestSeconds: number }>;
} {
  const state = { running: true };
  let mostPending = 0;
  let oldestSeconds = 0;
  const loop = (async () => {
    while (state.running) {
      const backlog = await measureHttpDeliveryBacklog(db, { now: new Date() });
      mostPending = Math.max(mostPending, backlog.pending);
      oldestSeconds = Math.max(oldestSeconds, backlog.oldestPendingSeconds);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  return {
    stop: async () => {
      state.running = false;
      await loop;
      return { mostPending, oldestSeconds };
    },
  };
}

/** A loopback destination: arrival time per host header and path, `/slow` answers after 9 s. */
interface BenchTarget {
  readonly port: number;
  readonly arrivals: { host: string; path: string; at: number; id: string }[];
  close(): Promise<void>;
}

async function startTarget(): Promise<BenchTarget> {
  const sockets = new Set<Socket>();
  const target: BenchTarget = {
    port: 0,
    arrivals: [],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = req.url ?? '';
      target.arrivals.push({
        host: (req.headers.host ?? '').split(':')[0] ?? '',
        path,
        at: performance.now(),
        id: String(req.headers['webhook-id'] ?? ''),
      });
      const answer = () => {
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      };
      if (path.startsWith('/slow')) setTimeout(answer, SLOW_MS);
      else answer();
    });
  });
  server.keepAliveTimeout = 1_000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  (target as { port: number }).port = (server.address() as AddressInfo).port;
  return target;
}

describe.skipIf(process.env['WEBHOOK_BENCH'] !== '1')('S5c webhooks bench (T615)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let target: BenchTarget;
  let workerDb: Db;
  let valkey: Redis;
  let worker: WorkerHandle;
  const { logger, logs } = captureLogger();

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;

  async function allowAs(browser: Browser, orgId: Id<'org'>, pattern: string): Promise<void> {
    const response = await browser.request({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/http-allowlist`,
      payload: { pattern },
    });
    expect(response.statusCode, response.body).toBe(201);
  }

  async function writeStats(): Promise<{ commits: number; writes: number }> {
    await sql`SELECT pg_stat_clear_snapshot()`.execute(db.kysely);
    const { rows } = await sql<{ commits: string; writes: string }>`
      SELECT xact_commit AS commits, tup_inserted + tup_updated + tup_deleted AS writes
        FROM pg_stat_database WHERE datname = current_database()
    `.execute(db.kysely);
    return { commits: Number(rows[0]?.commits), writes: Number(rows[0]?.writes) };
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, LOG_LEVEL: 'warn' });
    fx = await buildRecordFixture(t, db);
    t.app.get(IncomingWebhookRateLimits).ip = { limit: 100_000, windowSeconds: 1 };
    target = await startTarget();
    // The worker of production: its own pool, the Valkey pacers; DNS of the bench names to loopback.
    workerDb = createDb({
      url: t.config.database.url,
      poolMax: t.config.database.poolMax,
      applicationName: 'cellhive-worker',
      statementTimeoutMs: JOB_STATEMENT_TIMEOUT_MS,
    });
    valkey = new Redis(inject('cacheUrl'), { enableOfflineQueue: true, maxRetriesPerRequest: 1 });
    worker = await createWorker(t.config, {
      logger,
      taskList: buildTaskList({
        config: t.config,
        db: workerDb,
        logger,
        hostPacer: createValkeyHostPacer(valkeyQuotaClient(valkey), {
          keyPrefix: `bench-${newId('req').slice(4, 12)}:`,
        }),
        httpDelivery: { lookup: () => Promise.resolve(['127.0.0.1']) },
      }),
    });
  }, 300_000);

  afterAll(async () => {
    await worker.close();
    await workerDb.destroy();
    valkey.disconnect();
    await target.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it(
    'in: 50 req/s for 60 s with an automation per request — nothing lost',
    async () => {
      const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
        name: 'Bench in',
        auth: 'bearer',
        rate_limit_per_sec: IN_RATE,
      });
      const hook = incomingWebhookWithSecretsSchema.parse(created.json());
      const token = hook.url.split('/api/v1/hooks/')[1] ?? '';
      const flow = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Bench: order from the hook',
        enabled: true,
        definition: {
          trigger: { type: 'webhook.received', incoming_webhook_id: hook.id },
          actions: [
            {
              id: 'act_create',
              type: 'create_record',
              config: {
                table_id: fx.orders.id,
                fields: {
                  [F('title')]: { trigger: 'body', path: 'title' },
                  [F('amount')]: { trigger: 'body', path: 'amount' },
                },
              },
            },
          ],
        },
      });
      expect(flow.statusCode, flow.body).toBe(201);
      const automationId = flow.json<{ id: Id<'aut'> }>().id;

      const total = IN_RATE * IN_SECONDS;
      const durations: number[] = [];
      const statuses = new Map<number, number>();
      const pending: Promise<void>[] = [];
      const statsBefore = await writeStats();
      const loadBefore = load();
      const started = performance.now();
      for (let index = 0; index < total; index += 1) {
        const wait = started + (index * 1000) / IN_RATE - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        const sentAt = performance.now();
        pending.push(
          t.app
            .inject({
              method: 'POST',
              url: `/api/v1/hooks/${token}`,
              payload: JSON.stringify({
                title: `Bench order ${String(index)}`,
                amount: index,
                items: [{ sku: 'POS-X1', qty: 2, price: 6_500_000 }],
                customer: { name: 'Công ty TNHH Bench', email: 'bench@example.test' },
              }),
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${hook.bearer_token ?? ''}`,
              },
              remoteAddress: '198.51.100.99',
            })
            .then((response) => {
              durations.push(performance.now() - sentAt);
              statuses.set(response.statusCode, (statuses.get(response.statusCode) ?? 0) + 1);
            }),
        );
      }
      await Promise.all(pending);
      const window = (performance.now() - started) / 1000;
      const statsAfter = await writeStats();
      const lastAnswer = performance.now();
      await eventually(async () => {
        // One statement, one snapshot (T617): read apart, the last event could be
        // dispatched — and its run created — between the two counts, so the probe
        // passed with that run still running (2 999/3 000 succeeded, seen twice).
        const { rows } = await sql<{ open: number; undispatched: number }>`
          SELECT (SELECT count(*)::int FROM meta.automation_runs
                   WHERE automation_id = ${automationId}
                     AND status IN ('queued', 'running')) AS open,
                 (SELECT count(*)::int FROM meta.events
                   WHERE dispatched_at IS NULL) AS undispatched
        `.execute(db.kysely);
        return rows[0]?.open === 0 && rows[0].undispatched === 0;
      }, 'the automation backlog');
      const drained = (performance.now() - lastAnswer) / 1000;
      durations.sort((a, b) => a - b);
      const { rows } = await sql<{
        requests: number;
        events: number;
        runs: number;
        succeeded: number;
        bytes: string;
      }>`
        SELECT (SELECT count(*)::int FROM meta.incoming_webhook_requests
                 WHERE incoming_webhook_id = ${hook.id}) AS requests,
               (SELECT count(*)::int FROM meta.events
                 WHERE entity_id = ${hook.id} AND type = 'webhook.received') AS events,
               (SELECT count(*)::int FROM meta.automation_runs
                 WHERE automation_id = ${automationId}) AS runs,
               (SELECT count(*)::int FROM meta.automation_runs
                 WHERE automation_id = ${automationId} AND status = 'succeeded') AS succeeded,
               pg_total_relation_size('meta.incoming_webhook_requests')::text AS bytes
      `.execute(db.kysely);
      const row = rows[0];
      // T617: what became of runs that did not succeed (status, error code, step).
      const { rows: others } = await sql<{
        status: string;
        code: string | null;
        step_error: string | null;
        n: number;
      }>`
        SELECT r.status, r.error ->> 'code' AS code,
               (SELECT string_agg(DISTINCT s.status || ':' || coalesce(s.error ->> 'code', '-'), ',')
                  FROM meta.automation_run_steps s
                 WHERE s.organization_id = r.organization_id AND s.run_id = r.id) AS step_error,
               count(*)::int AS n
          FROM meta.automation_runs r
         WHERE r.automation_id = ${automationId} AND r.status <> 'succeeded'
         GROUP BY 1, 2, 3
      `.execute(db.kysely);
      if (others.length > 0) {
        report(`in: runs not succeeded ${JSON.stringify(others)}`);
        const warnings = logs.lines.filter((line) => Number(line['level']) >= 40).slice(0, 10);
        report(`in: worker warnings ${JSON.stringify(warnings)}`);
      }
      report(
        `in: ${String(total)} requests at ${String(IN_RATE)}/s over ${window.toFixed(1)} s: ` +
          `statuses ${JSON.stringify(Object.fromEntries(statuses))}, lost ${String(total - (row?.requests ?? 0))}, ` +
          `p50 ${ms(pct(durations, 0.5))}, p95 ${ms(pct(durations, 0.95))}, p99 ${ms(pct(durations, 0.99))}; ` +
          `PostgreSQL ${((statsAfter.commits - statsBefore.commits) / window).toFixed(0)} commits/s, ` +
          `${((statsAfter.writes - statsBefore.writes) / window).toFixed(0)} row writes/s; ` +
          `runs ${String(row?.succeeded ?? 0)}/${String(row?.runs ?? 0)} succeeded, backlog drained ${drained.toFixed(1)} s after the last answer; ` +
          `${(Number(row?.bytes) / Math.max(1, row?.requests ?? 1)).toFixed(0)} bytes per stored request, ` +
          `request table ${(Number(row?.bytes) / 1024 / 1024).toFixed(1)} MiB (load before ${loadBefore})`,
      );
      expect(statuses.get(202)).toBe(total);
      expect(row?.requests).toBe(total);
      expect(row?.events).toBe(total);
      expect(row?.runs).toBe(total);
      expect(row?.succeeded).toBe(total);
    },
    (IN_SECONDS + 600) * 1000,
  );

  it('request table at the body cap: 60 requests of almost 1 MiB that do not compress (QA S5c M3)', async () => {
    const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
      name: 'Bench cap',
      auth: 'bearer',
      rate_limit_per_sec: IN_RATE,
    });
    const hook = incomingWebhookWithSecretsSchema.parse(created.json());
    const token = hook.url.split('/api/v1/hooks/')[1] ?? '';
    const sizeOf = async () => {
      const { rows } = await sql<{ bytes: string; toast: string }>`
        SELECT pg_total_relation_size('meta.incoming_webhook_requests')::text AS bytes,
               coalesce(pg_total_relation_size(reltoastrelid), 0)::text AS toast
          FROM pg_class WHERE oid = 'meta.incoming_webhook_requests'::regclass
      `.execute(db.kysely);
      return { bytes: Number(rows[0]?.bytes), toast: Number(rows[0]?.toast) };
    };
    const before = await sizeOf();
    // Random bytes as base64: pglz finds no repeats, so this is the worst case on disk.
    const blobChars = 1_048_576 - 64;
    let sentBytes = 0;
    let accepted = 0;
    const started = performance.now();
    for (let index = 0; index < CAP_REQUESTS; index += 1) {
      const payload = JSON.stringify({
        blob: randomBytes(Math.ceil((blobChars * 3) / 4))
          .toString('base64')
          .slice(0, blobChars - 32),
        n: index,
      });
      sentBytes += Buffer.byteLength(payload);
      const response = await t.app.inject({
        method: 'POST',
        url: `/api/v1/hooks/${token}`,
        payload,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${hook.bearer_token ?? ''}`,
        },
        remoteAddress: '198.51.100.98',
      });
      if (response.statusCode === 202) accepted += 1;
    }
    const seconds = (performance.now() - started) / 1000;
    const after = await sizeOf();
    const grown = after.bytes - before.bytes;
    const perRequest = grown / Math.max(1, accepted);
    report(
      `cap: ${String(accepted)}/${String(CAP_REQUESTS)} requests of ${(sentBytes / CAP_REQUESTS / 1024).toFixed(0)} KiB accepted in ${seconds.toFixed(1)} s; ` +
        `request table +${(grown / 1024 / 1024).toFixed(1)} MiB (TOAST +${((after.toast - before.toast) / 1024 / 1024).toFixed(1)} MiB), ` +
        `${(perRequest / 1024).toFixed(0)} KiB on disk per request = ${(perRequest / (sentBytes / CAP_REQUESTS)).toFixed(2)}× the body; ` +
        `at the base cap of 50 req/s that is ${((perRequest * 50 * 86_400) / 1024 ** 4).toFixed(2)} TiB/day`,
    );
    expect(accepted).toBe(CAP_REQUESTS);
  }, 600_000);

  it('hook lookup: 1 000 enabled automations, 100 on 10 hooks — listEnabledForWebhook p50/p95 and plan', async () => {
    const hooks: Id<'hok'>[] = [];
    for (let index = 0; index < LOOKUP_HOOKS; index += 1) {
      const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
        name: `Lookup ${String(index)}`,
        auth: 'none',
      });
      expect(created.statusCode, created.body).toBe(201);
      hooks.push(created.json<{ id: Id<'hok'> }>().id);
    }
    // Automations are written as stored rows (the API caps automations per base):
    // the bench measures the query, not their creation.
    const { rows: template } = await sql<{ definition: unknown }>`
        SELECT definition FROM meta.automations WHERE name = 'Bench: order from the hook'
      `.execute(db.kysely);
    const webhookDefinition = template[0]?.definition as {
      trigger: Record<string, unknown>;
      actions: unknown[];
    };
    const rows = Array.from({ length: LOOKUP_AUTOMATIONS }, (_unused, index) => {
      const onHook = index < LOOKUP_WEBHOOK_AUTOMATIONS;
      const hookId = hooks[index % LOOKUP_HOOKS] ?? '';
      return {
        id: newId('aut'),
        onHook,
        definition: onHook
          ? {
              ...webhookDefinition,
              trigger: { type: 'webhook.received', incoming_webhook_id: hookId },
            }
          : {
              trigger: { type: 'record.created', table_id: fx.orders.id },
              actions: webhookDefinition.actions,
            },
      };
    });
    for (const row of rows) {
      await sql`
          INSERT INTO meta.automations
            (id, organization_id, base_id, name, description, enabled, trigger_type,
             trigger_table_id, definition, run_as_user_id, created_by, updated_by)
          SELECT ${row.id}, organization_id, base_id, ${`Lookup ${row.id}`}, '', true,
                 ${row.onHook ? 'webhook.received' : 'record.created'},
                 ${row.onHook ? null : fx.orders.id}, ${JSON.stringify(row.definition)}::jsonb,
                 run_as_user_id, created_by, updated_by
            FROM meta.automations WHERE name = 'Bench: order from the hook'
        `.execute(db.kysely);
    }
    await sql`ANALYZE meta.automations`.execute(db.kysely);
    const repository = new AutomationsRepository(t.app.get<Db>(DB));
    const scope = orgScope(fx.orgId);
    const times: number[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const hookId = hooks[index % LOOKUP_HOOKS] ?? ('' as Id<'hok'>);
      const startedAt = performance.now();
      const found = await repository.listEnabledForWebhook(scope, hookId);
      times.push(performance.now() - startedAt);
      if (index < LOOKUP_HOOKS) {
        expect(found).toHaveLength(LOOKUP_WEBHOOK_AUTOMATIONS / LOOKUP_HOOKS);
      }
    }
    times.sort((a, b) => a - b);
    const { rows: plan } = await sql<{ 'QUERY PLAN': string }>`
        EXPLAIN (ANALYZE, BUFFERS)
        SELECT * FROM meta.automations
         WHERE organization_id = ${fx.orgId} AND trigger_type = 'webhook.received'
           AND definition -> 'trigger' ->> 'incoming_webhook_id' = ${hooks[0] ?? ''}
           AND enabled = true AND deleted_at IS NULL
         ORDER BY created_at, id
      `.execute(db.kysely);
    const lines = plan.map((line) => line['QUERY PLAN']);
    report(
      `hook lookup: ${String(LOOKUP_AUTOMATIONS + 1)} enabled automations, ${String(LOOKUP_WEBHOOK_AUTOMATIONS)} on ` +
        `${String(LOOKUP_HOOKS)} hooks: p50 ${ms(pct(times, 0.5))}, p95 ${ms(pct(times, 0.95))} (round trip); ` +
        `plan: ${lines.filter((line) => /Scan|Execution Time/u.test(line)).join(' | ')}`,
    );
    // T617: turn the 1 000 rows off again. 900 of them create an Orders record on every
    // Orders `record.created`: left on, the "unrelated event" of the slow phase sets off an
    // automation storm that the slow deliveries then wait behind (a bench artefact).
    await sql`
        UPDATE meta.automations SET enabled = false
         WHERE organization_id = ${fx.orgId} AND name LIKE 'Lookup aut\\_%'
      `.execute(db.kysely);
  }, 600_000);

  it('out: 1 000 calls to 5 hosts — drain time within the host pacing', async () => {
    const browser = new Browser(t.app);
    expect((await browser.login(fx.users.owner.email)).statusCode).toBe(204);
    const hosts = Array.from({ length: OUT_HOSTS }, (_unused, i) => `h${String(i)}.bench.test`);
    for (const host of hosts) await allowAs(browser, fx.orgId, `${host}:${String(target.port)}`);
    const outbox = new HttpOutbox(t.app.get<Db>(DB), {
      masterKey: t.config.security.appMasterKey,
    });
    const before = target.arrivals.length;
    const enqueuedAt = new Map<string, number>();
    const backlog = sampleBacklog(db);
    const started = performance.now();
    for (let index = 0; index < OUT_CALLS; index += 50) {
      await t.app.get<Db>(DB).withTx(async (tx) => {
        for (let i = index; i < Math.min(OUT_CALLS, index + 50); i += 1) {
          const host = hosts[i % OUT_HOSTS] ?? '';
          const { row } = await outbox.enqueue(tx, orgScope(fx.orgId), {
            kind: 'test',
            automationId: null,
            actionId: null,
            requestedBy: fx.users.owner.id,
            request: {
              method: 'POST',
              url: `http://${host}:${String(target.port)}/out/${String(i)}`,
              headers: [['content-type', 'application/json']],
              body: JSON.stringify({ index: i }),
              authHeaderName: null,
              causation: null,
            },
          });
          enqueuedAt.set(row.message_id, performance.now());
        }
      });
    }
    const enqueued = (performance.now() - started) / 1000;
    await eventually(
      () => Promise.resolve(target.arrivals.length - before >= OUT_CALLS),
      'every call',
    );
    const drain = (performance.now() - started) / 1000;
    await eventually(async () => {
      const { rows: open } = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM meta.http_deliveries
           WHERE target_host LIKE '%.bench.test' AND status IN ('pending', 'sending')
        `.execute(db.kysely);
      return open[0]?.n === 0;
    }, 'the out deliveries to settle');
    const outBacklog = await backlog.stop();
    const arrivals = target.arrivals.slice(before);
    const perHost = hosts.map((host) =>
      maxWithinOneSecond(arrivals.filter((a) => a.host === host).map((a) => a.at)),
    );
    const latency = arrivals
      .map((a) => a.at - (enqueuedAt.get(a.id) ?? a.at))
      .sort((a, b) => a - b);
    const { rows } = await sql<{ status: string; n: number }>`
        SELECT status, count(*)::int AS n FROM meta.http_deliveries
         WHERE kind = 'test' AND target_host LIKE '%.bench.test' AND method = 'POST'
           AND requested_by = ${fx.users.owner.id}
         GROUP BY status
      `.execute(db.kysely);
    // Theory: 200 calls per host at 20 + 10/s → ≥ 18 s, hosts in parallel.
    report(
      `out: ${String(OUT_CALLS)} calls to ${String(OUT_HOSTS)} hosts: enqueued in ${enqueued.toFixed(1)} s, ` +
        `drained ${drain.toFixed(1)} s after the first enqueue (floor 18 s by the pacing); ` +
        `most per host in any second ${perHost.join('/')} (bucket 20 + 10/s); ` +
        `enqueue → received p50 ${(pct(latency, 0.5) / 1000).toFixed(1)} s, p95 ${(pct(latency, 0.95) / 1000).toFixed(1)} s; ` +
        `deliveries ${JSON.stringify(rows)}; duplicates ${String(arrivals.length - new Set(arrivals.map((a) => a.id)).size)}; ` +
        `backlog gauge: most rows pending ${String(outBacklog.mostPending)}, oldest pending ${outBacklog.oldestSeconds.toFixed(1)} s`,
    );
    expect(new Set(arrivals.map((a) => a.id)).size).toBe(OUT_CALLS);
    for (const most of perHost) expect(most).toBeLessThanOrEqual(30);
  }, 900_000);

  it('slow: 20 calls of 9 s over 10 organizations — no worker connection held while waiting', async () => {
    const outbox = new HttpOutbox(t.app.get<Db>(DB), {
      masterKey: t.config.security.appMasterKey,
    });
    const orgs: { id: Id<'org'>; user: Id<'usr'> }[] = [];
    for (let index = 0; index < SLOW_ORGS; index += 1) {
      const id = await seedOrg(db, `Slow ${String(index)}`);
      const owner = await seedUser(db, { memberships: [{ orgId: id, role: 'owner' }] });
      const browser = new Browser(t.app);
      expect((await browser.login(owner.email)).statusCode).toBe(204);
      await allowAs(browser, id, `slow.bench.test:${String(target.port)}`);
      orgs.push({ id, user: owner.id });
    }
    const before = target.arrivals.length;
    const slowBacklog = sampleBacklog(db);
    const started = performance.now();
    for (let index = 0; index < SLOW_CALLS; index += 1) {
      const org = orgs[index % SLOW_ORGS];
      if (org === undefined) continue;
      await t.app.get<Db>(DB).withTx((tx) =>
        outbox.enqueue(tx, orgScope(org.id), {
          kind: 'test',
          automationId: null,
          actionId: null,
          requestedBy: org.user,
          request: {
            method: 'POST',
            url: `http://slow.bench.test:${String(target.port)}/slow/${String(index)}`,
            headers: [],
            body: null,
            authHeaderName: null,
            causation: null,
          },
        }),
      );
    }
    // While the calls wait: worker connections busy (active or in a transaction).
    let mostBusy = 0;
    let samples = 0;
    let busySamples = 0;
    const sampling = (async () => {
      while (performance.now() - started < SLOW_MS + 1_000) {
        const { rows } = await sql<{ busy: number }>`
            SELECT count(*)::int AS busy FROM pg_stat_activity
             WHERE datname = current_database() AND application_name = 'cellhive-worker'
               AND state IN ('active', 'idle in transaction')
               AND query NOT ILIKE '%graphile_worker%'
          `.execute(db.kysely);
        mostBusy = Math.max(mostBusy, rows[0]?.busy ?? 0);
        if ((rows[0]?.busy ?? 0) > 0) busySamples += 1;
        samples += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    // An unrelated event meanwhile: how long until it is dispatched?
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const created = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ fields: { [F('title')]: 'during the slow calls' } }] },
    );
    expect(created.statusCode, created.body).toBe(201);
    const recordId = created.json<{ records: { id: string }[] }>().records[0]?.id ?? '';
    const dispatchLag = await eventually(async () => {
      const { rows } = await sql<{ lag: number | null }>`
          SELECT extract(epoch FROM dispatched_at - created_at)::float8 * 1000 AS lag
            FROM meta.events WHERE entity_id = ${recordId} AND type = 'record.created'
        `.execute(db.kysely);
      return rows[0]?.lag ?? undefined;
    }, 'the unrelated event');
    await sampling;
    await eventually(
      () => Promise.resolve(target.arrivals.length - before >= SLOW_CALLS),
      'every slow call to arrive',
    );
    await eventually(async () => {
      const { rows } = await sql<{ open: number }>`
          SELECT count(*)::int AS open FROM meta.http_deliveries
           WHERE target_host = 'slow.bench.test' AND status IN ('pending', 'sending')
        `.execute(db.kysely);
      return rows[0]?.open === 0;
    }, 'the slow deliveries to finish');
    const total = (performance.now() - started) / 1000;
    const slowGauge = await slowBacklog.stop();
    const { rows } = await sql<{ status: string; n: number }>`
        SELECT status, count(*)::int AS n FROM meta.http_deliveries
         WHERE target_host = 'slow.bench.test' GROUP BY status
      `.execute(db.kysely);
    report(
      `slow: ${String(SLOW_CALLS)} calls of ${String(SLOW_MS / 1000)} s over ${String(SLOW_ORGS)} organizations ` +
        `(WORKER_CONCURRENCY ${String(t.config.limits.workerConcurrency)}, pool ${String(t.config.database.poolMax)}): ` +
        `all done in ${total.toFixed(1)} s; most worker connections busy outside the job queue ${String(mostBusy)} ` +
        `(in ${String(busySamples)} of ${String(samples)} samples); an unrelated event dispatched ${ms(dispatchLag)} after it was written; ` +
        `deliveries ${JSON.stringify(rows)}; backlog gauge: most rows pending ${String(slowGauge.mostPending)}, ` +
        `oldest pending ${slowGauge.oldestSeconds.toFixed(1)} s`,
    );
    expect(rows).toEqual([{ status: 'succeeded', n: SLOW_CALLS }]);
    // QA S5c (T616): HTTP calls never take the last job slot of the worker (34 s before).
    expect(dispatchLag).toBeLessThan(5_000);
  }, 600_000);
});
