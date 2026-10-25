import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  automationRunDetailSchema,
  HTTP_DELIVERY_MAX_ATTEMPTS,
  newId,
  type Id,
} from '@cellhive/contracts';
import {
  AutomationRunEngine,
  CAUSATION_HOOK_PATH_PREFIX,
  createDb,
  AutomationRunsRepository,
  AutomationRunStepsRepository,
  AutomationsRepository,
  createHttpCallSlots,
  createValkeyHostPacer,
  decodeCausationToken,
  defaultActionRegistry,
  deriveCausationKey,
  HTTP_DNS_BUSY_RETRY_MS,
  HttpDeliverer,
  HttpDeliveriesRepository,
  HttpOutbox,
  NO_AUTOMATION_NOTIFICATIONS,
  orgScope,
  RecordMutationService,
  RecordQueryService,
  valkeyQuotaClient,
  verifyWebhook,
  type AutomationActionHandler,
  type Db,
  type DeferrableJob,
  type HostPacer,
  type HttpDelivererOptions,
  type HttpDeliveryWait,
  type JsonObject,
} from '@cellhive/server-core';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { DB } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { AddressInfo, Socket } from 'node:net';

const SIGNING_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const AUTH_VALUE = 'Bearer canary-auth-secret-value';
const URL_CANARY = 'canary-url-token';
const TELEGRAM_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

function jobOf(orgId: Id<'org'>, runId: Id<'run'>): DeferrableJob {
  return {
    task_identifier: 'automation.run',
    payload: { organization_id: orgId, run_id: runId },
    priority: 0,
    attempts: 1,
    max_attempts: 25,
    key: null,
    flags: null,
    queue_name: null,
  };
}

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

/** A loopback destination: queued responders, requests recorded, calls in flight counted. */
interface FakeTarget {
  readonly port: number;
  readonly received: Received[];
  inFlight: number;
  /** Next responders, in order; then `200 {"ok":true}`. */
  readonly responders: ((req: IncomingMessage, res: ServerResponse) => void)[];
  close(): Promise<void>;
}

async function startTarget(): Promise<FakeTarget> {
  const sockets = new Set<Socket>();
  const target: FakeTarget = {
    port: 0,
    received: [],
    inFlight: 0,
    responders: [],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    target.inFlight += 1;
    res.on('close', () => {
      target.inFlight -= 1;
    });
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      target.received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const responder = target.responders.shift();
      if (responder !== undefined) {
        responder(req, res);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, id: 42 }));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  (target as { port: number }).port = (server.address() as AddressInfo).port;
  return target;
}

const reply =
  (status: number, headers: Record<string, string> = {}, body = '') =>
  (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, headers);
    res.end(body);
  };

const slow = (ms: number) => (_req: IncomingMessage, res: ServerResponse) => {
  setTimeout(() => {
    res.setHeader('content-type', 'text/plain');
    res.end('late');
  }, ms);
};

/**
 * BACKLOG T605 (ADR-35 §4, S5b-review §10 #1, §11 #1–#2): outbound HTTP
 * through the two-phase outbox, end to end with the run engine (an HTTP
 * action handler stands in for T606's `http_request`), the real Valkey
 * pacer, a loopback destination reached through an exact allowlist entry,
 * and the run detail API:
 *
 * - delivered once, signed (Standard Webhooks), `Idempotency-Key`,
 *   causation token, `User-Agent`; the step output and the run;
 * - a worker dying after TX-a: the attempt after the lease carries the same
 *   `webhook-id` and `Idempotency-Key`;
 * - `Retry-After` ≤ 1 h pauses the host (other deliveries wait), > 1 h →
 *   `rate_limited`; six attempts of `500` on the schedule; `404`/`410`/`302`
 *   fail at once;
 * - no database connection is busy while the destination is slow;
 * - pacing: ≤ 20 + 10/s per (org, host), two calls in flight per org (another
 *   org is not blocked), Valkey down → deferred without counting;
 * - cancelling the run cancels the delivery; the request is erased once final;
 * - the run detail shows `delivery` (host, attempts, codes) to the manager
 *   only — never the URL, headers, bodies or secret values (P50).
 */
describe('HTTP outbox: two-phase delivery (T605)', () => {
  let database: TestDatabase;
  let db: Db;
  let appDb: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let records: RecordMutationService;
  let query: RecordQueryService;
  let target: FakeTarget;
  let valkey: Redis;
  let pacer: HostPacer;
  let otherOrg: Id<'org'>;
  let strangerId: Id<'usr'>;
  /** The request the fake HTTP action asks for next. */
  let nextDelivery: HttpDeliveryWait;
  /**
   * Rows of `meta.secrets` the deliveries reference (the FK); their values
   * come from the fake source below — T606 adds the `http_header` /
   * `webhook_signing` kinds read by `databaseSecretSource`.
   */
  let SIGNING_ID: Id<'sec'>;
  let AUTH_ID: Id<'sec'>;
  const createSecret = async (name: string): Promise<Id<'sec'>> => {
    const response = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'telegram_bot',
      name,
      value: TELEGRAM_TOKEN,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: Id<'sec'> }>().id;
  };

  const scope = () => orgScope(fx.orgId);
  const host = 'hooks.test';
  const urlOf = (path = '/hook') =>
    `http://${host}:${String(target.port)}${path}?token=${URL_CANARY}`;

  const httpAction: AutomationActionHandler = {
    execute: () => Promise.resolve({ output: {}, delivery: nextDelivery }),
  };

  function engine(): AutomationRunEngine {
    return new AutomationRunEngine(appDb, {
      defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
      query,
      // `send_telegram` stands in for T606's `http_request` (its zod config is valid).
      actions: defaultActionRegistry({ records, query }, [['send_telegram', httpAction]]),
      publicUrl: TEST_PUBLIC_URL,
      notifier: NO_AUTOMATION_NOTIFICATIONS,
      random: () => 0,
      httpOutbox: new HttpOutbox(appDb, { masterKey: t.config.security.appMasterKey }),
    });
  }

  function deliverer(options: Partial<HttpDelivererOptions> = {}, onDb: Db = appDb): HttpDeliverer {
    return new HttpDeliverer(onDb, {
      masterKey: t.config.security.appMasterKey,
      publicUrl: TEST_PUBLIC_URL,
      pacer,
      allowlist: [{ host, wildcard: false, port: target.port }],
      privateAllowlist: 'org',
      lookup: () => Promise.resolve(['127.0.0.1']),
      random: () => 0.5,
      secrets: {
        // Sent anywhere (the host check of T701 has its own tests).
        hosts: () => Promise.resolve({ allowedHosts: [], legacyHostsUntil: new Date(8.64e15) }),
        values: (_scope, input) =>
          Promise.resolve(
            input.purpose === 'signing'
              ? input.secretId === SIGNING_ID
                ? [SIGNING_SECRET]
                : null
              : input.secretId === AUTH_ID
                ? [AUTH_VALUE]
                : null,
          ),
      },
      ...options,
    });
  }

  const delivery = (path = '/hook', extra: Partial<HttpDeliveryWait> = {}): HttpDeliveryWait => ({
    request: {
      method: 'POST',
      url: urlOf(path),
      headers: [
        ['Content-Type', 'application/json'],
        ['X-Canary-Header', 'canary-header-value'],
      ],
      body: JSON.stringify({ order: 'canary-body-value' }),
      authHeaderName: null,
    },
    ...extra,
  });

  /** An enabled automation with one HTTP step and one `queued` run of a root event. */
  async function queuedRun(): Promise<{ automationId: Id<'aut'>; runId: Id<'run'> }> {
    const trigger = { type: 'schedule', cron: '0 8 * * *', timezone: null };
    const definition = {
      trigger,
      condition: null,
      actions: [
        {
          id: 'act_http',
          type: 'send_telegram',
          config: {
            secret_id: 'sec_HttpOutDummy0001',
            chat_id: { literal: '1' },
            text: { template: 'x' },
          },
        },
      ],
    } as unknown as JsonObject;
    const automationId = newId('aut');
    await new AutomationsRepository(db).insert(scope(), {
      id: automationId,
      baseId: fx.baseId,
      name: 'Gọi webhook',
      description: '',
      enabled: true,
      definition,
      triggerType: 'schedule',
      triggerTableId: null,
      createdBy: fx.users.u_admin.id,
    });
    const runId = newId('run');
    await new AutomationRunsRepository(db).insert(scope(), {
      id: runId,
      automationId,
      automationVersion: 1,
      triggerEventId: null,
      triggerUnit: newId('evt'),
      status: 'queued',
      depth: 0,
      input: {
        automation_version: 1,
        definition,
        trigger: {
          event_id: null,
          event_created_at: null,
          type: 'schedule',
          table_id: null,
          record_id: null,
          bulk: false,
          batch: null,
          fired_at: new Date().toISOString(),
        },
      },
    });
    return { automationId, runId };
  }

  /** Runs the engine up to the HTTP step: the run waits for its delivery. */
  async function runToDelivery(
    wait: HttpDeliveryWait = delivery(),
  ): Promise<{ automationId: Id<'aut'>; runId: Id<'run'>; deliveryId: Id<'hdl'> }> {
    nextDelivery = wait;
    const { automationId, runId } = await queuedRun();
    const result = await engine().execute(scope(), runId, jobOf(fx.orgId, runId));
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'waiting_delivery',
      step: 'act_http',
    });
    if (result.status !== 'waiting_delivery') throw new Error('not waiting');
    return { automationId, runId, deliveryId: result.deliveryId };
  }

  const deliveryRow = async (id: Id<'hdl'>) =>
    (await new HttpDeliveriesRepository(db).get(scope(), id)) ?? null;
  const stepOf = async (runId: Id<'run'>) =>
    (await new AutomationRunStepsRepository(db).listByRun(scope(), runId)).at(-1);
  const runOf = async (runId: Id<'run'>) => new AutomationRunsRepository(db).get(scope(), runId);

  /** A `test` delivery (no run), for pacing scenarios. */
  async function testDelivery(
    orgId: Id<'org'>,
    requestedBy: Id<'usr'>,
    path = '/hook',
  ): Promise<Id<'hdl'>> {
    const { row } = await appDb.withTx((tx) =>
      new HttpOutbox(appDb, { masterKey: t.config.security.appMasterKey }).enqueue(
        tx,
        orgScope(orgId),
        {
          kind: 'test',
          automationId: null,
          actionId: null,
          requestedBy,
          request: { ...delivery(path).request, causation: null },
        },
      ),
    );
    return row.id;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    appDb = t.app.get<Db>(DB);
    fx = await buildRecordFixture(t, db);
    records = t.app.get(RecordMutationService);
    query = t.app.get(RecordQueryService);
    target = await startTarget();
    valkey = new Redis(inject('cacheUrl'), { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    await once(valkey, 'ready');
    strangerId = fx.users.stranger.id;
    const membership = await db.kysely
      .selectFrom('meta.org_members')
      .select('organization_id')
      .where('user_id', '=', strangerId)
      .executeTakeFirstOrThrow();
    otherOrg = membership.organization_id;
    SIGNING_ID = await createSecret('Ký webhook');
    AUTH_ID = await createSecret('Khoá API');
  });

  beforeEach(() => {
    // A fresh key space per test: buckets and pauses never leak between scenarios.
    pacer = createValkeyHostPacer(valkeyQuotaClient(valkey), {
      keyPrefix: `test:${randomBytes(4).toString('hex')}:`,
    });
    target.responders.length = 0;
  });

  afterAll(async () => {
    valkey.disconnect();
    await target.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('delivers once, signed, with idempotency and causation headers; the run then succeeds', async () => {
    const { automationId, runId, deliveryId } = await runToDelivery(
      delivery('/hook', {
        signingSecretId: SIGNING_ID,
        authSecretId: AUTH_ID,
        request: {
          ...delivery().request,
          authHeaderName: 'Authorization',
        },
      }),
    );
    // Phase 1: the step and the run wait; nothing went out.
    expect(target.received).toHaveLength(0);
    expect(await stepOf(runId)).toMatchObject({
      status: 'waiting',
      output: { delivery_id: deliveryId },
    });
    expect((await runOf(runId))?.status).toBe('waiting');
    // A stray `automation.run` job leaves a run waiting for its delivery alone.
    expect(await engine().execute(scope(), runId, jobOf(fx.orgId, runId))).toMatchObject({
      status: 'waiting_delivery',
    });

    const before = target.received.length;
    expect(await deliverer().deliver(scope(), deliveryId)).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      httpStatus: 200,
    });
    expect(target.received.length - before).toBe(1);
    const received = target.received.at(-1) as Received;
    const row = await deliveryRow(deliveryId);
    expect(row).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      request_enc: null,
      last_status: 200,
    });
    expect(received.url).toBe(`/hook?token=${URL_CANARY}`);
    expect(received.headers['webhook-id']).toBe(deliveryId);
    expect(received.headers['idempotency-key']).toBe(row?.idempotency_key);
    expect(received.headers['user-agent']).toMatch(/^Cellhive\//u);
    expect(received.headers['authorization']).toBe(AUTH_VALUE);
    expect(received.headers['x-canary-header']).toBe('canary-header-value');
    expect(verifyWebhook(received.headers, received.body, [SIGNING_SECRET], new Date())).toEqual({
      ok: true,
    });
    const token = received.headers['x-cellhive-causation'];
    expect(typeof token).toBe('string');
    // Bound to this instance (PUBLIC_URL host + /api/v1/hooks), not to the destination.
    const decodeAt = (hosts: string[], path: string) =>
      decodeCausationToken(token as string, {
        key: deriveCausationKey(t.config.security.appMasterKey),
        hosts,
        path,
        pathPrefix: CAUSATION_HOOK_PATH_PREFIX,
        now: new Date(),
      });
    // Review fix: the run's own depth (its trigger: a person's change, 0) with the run's
    // automation in the chain — the hook adds the hop, so a hook costs one level like a
    // record write (it used to carry the writes' depth 1, and the hook made it 2).
    expect(decodeAt([new URL(TEST_PUBLIC_URL).host], '/api/v1/hooks/any')).toMatchObject({
      ok: true,
      causation: { depth: 0, automation_chain: [automationId] },
    });
    expect(decodeAt([`${host}:${String(target.port)}`], '/api/v1/hooks/any')).toEqual({
      ok: false,
      reason: 'target_mismatch',
    });

    // TX-b finished the step and woke the run.
    expect(await stepOf(runId)).toMatchObject({
      status: 'succeeded',
      output: {
        delivery_id: deliveryId,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { ok: true, id: 42 },
        body_truncated: false,
      },
    });
    const { rows: wake } = await sql<{ key: string }>`
      SELECT key FROM graphile_worker.jobs WHERE key = ${`automation.run:wait:${runId}`}
    `.execute(db.kysely);
    expect(wake).toHaveLength(1);
    expect(await engine().execute(scope(), runId, jobOf(fx.orgId, runId))).toEqual({
      status: 'succeeded',
    });
    // A job delivered again does nothing more.
    expect(await deliverer().deliver(scope(), deliveryId)).toEqual({ status: 'final' });
    expect(target.received.length - before).toBe(1);
  });

  it('a worker dying after TX-a: after the lease, the same webhook-id and Idempotency-Key', async () => {
    const { deliveryId } = await runToDelivery();
    let clock = new Date();
    const crash = deliverer({
      now: () => clock,
      afterLease: () => Promise.reject(new Error('worker killed')),
    });
    await expect(crash.deliver(scope(), deliveryId)).rejects.toThrow('worker killed');
    expect(await deliveryRow(deliveryId)).toMatchObject({ status: 'sending', attempts: 1 });
    // Before the lease ends another worker leaves it alone.
    expect(await deliverer({ now: () => clock }).deliver(scope(), deliveryId)).toMatchObject({
      status: 'not_due',
    });
    clock = new Date(clock.getTime() + 31_000);
    target.responders.push(reply(500));
    const before = target.received.length;
    const retried = await deliverer({ now: () => clock }).deliver(scope(), deliveryId);
    expect(retried).toMatchObject({ status: 'retry_scheduled', attempt: 2 });
    if (retried.status === 'retry_scheduled') clock = retried.at;
    expect(await deliverer({ now: () => clock }).deliver(scope(), deliveryId)).toMatchObject({
      status: 'succeeded',
      attempt: 3,
    });
    const [first, second] = target.received.slice(before);
    const row = await deliveryRow(deliveryId);
    expect(first?.headers['webhook-id']).toBe(row?.message_id);
    expect(second?.headers['webhook-id']).toBe(row?.message_id);
    expect(first?.headers['idempotency-key']).toBe(row?.idempotency_key);
    expect(second?.headers['idempotency-key']).toBe(row?.idempotency_key);
    // A fresh causation token per attempt.
    expect(first?.headers['x-cellhive-causation']).not.toBe(
      second?.headers['x-cellhive-causation'],
    );
  });

  it('503 Retry-After: 2 → the next attempt is later and other deliveries to the host wait', async () => {
    const first = await runToDelivery();
    const second = await runToDelivery();
    target.responders.push(reply(503, { 'retry-after': '2' }));
    const started = Date.now();
    const retried = await deliverer().deliver(scope(), first.deliveryId);
    expect(retried).toMatchObject({ status: 'retry_scheduled', code: 'http_status' });
    if (retried.status !== 'retry_scheduled') return;
    expect(retried.at.getTime() - started).toBeGreaterThanOrEqual(2_000);
    const paused = await deliverer().deliver(scope(), second.deliveryId);
    expect(paused).toMatchObject({ status: 'deferred', reason: 'paused' });
    if (paused.status !== 'deferred') return;
    expect(paused.at.getTime() - started).toBeGreaterThanOrEqual(1_500);
    expect(paused.at.getTime() - started).toBeLessThanOrEqual(3_000);
    // The wait is not an attempt.
    expect(await deliveryRow(second.deliveryId)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await deliveryRow(first.deliveryId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_status: 503,
      last_error: { code: 'http_status', params: { status: 503 } },
    });
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, paused.at.getTime() - Date.now()) + 50),
    );
    expect(await deliverer().deliver(scope(), second.deliveryId)).toMatchObject({
      status: 'succeeded',
    });
  });

  it('Retry-After: 7200 → failed rate_limited, and the run fails', async () => {
    const { runId, deliveryId } = await runToDelivery();
    target.responders.push(reply(429, { 'retry-after': '7200' }));
    expect(await deliverer().deliver(scope(), deliveryId)).toMatchObject({
      status: 'failed',
      code: 'rate_limited',
    });
    expect(await deliveryRow(deliveryId)).toMatchObject({
      status: 'failed',
      request_enc: null,
      last_error: { code: 'rate_limited', params: { status: 429, retry_after_s: 7200 } },
    });
    expect(await stepOf(runId)).toMatchObject({
      status: 'failed',
      error: { code: 'rate_limited', params: { retry_after_s: 7200 } },
    });
    expect(await engine().execute(scope(), runId, jobOf(fx.orgId, runId))).toMatchObject({
      status: 'failed',
      code: 'rate_limited',
      step: 'act_http',
    });
    expect(await runOf(runId)).toMatchObject({ status: 'failed', error: { code: 'rate_limited' } });
  });

  it('500 every time → failed after exactly six attempts on the schedule (clock injected)', async () => {
    const { runId, deliveryId } = await runToDelivery();
    let clock = new Date();
    const times: number[] = [];
    let result: Awaited<ReturnType<HttpDeliverer['deliver']>> | undefined;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      target.responders.push(reply(500));
      times.push(clock.getTime());
      result = await deliverer({ now: () => clock }).deliver(scope(), deliveryId);
      if (result.status === 'retry_scheduled') clock = result.at;
    }
    expect(result).toMatchObject({ status: 'failed', attempt: 6, code: 'http_status' });
    const gaps = times.slice(1).map((time, index) => time - (times[index] ?? 0));
    expect(gaps).toEqual([10_000, 60_000, 300_000, 900_000, 1_800_000]);
    expect(await deliveryRow(deliveryId)).toMatchObject({
      status: 'failed',
      attempts: 6,
      request_enc: null,
      last_error: { code: 'http_status', params: { status: 500, attempts: 6 } },
    });
    expect(await engine().execute(scope(), runId, jobOf(fx.orgId, runId))).toMatchObject({
      status: 'failed',
      code: 'http_status',
    });
  });

  it.each([
    [404, {}],
    [410, {}],
    [302, { location: 'http://169.254.169.254/latest/meta-data/' }],
  ] as const)('%i fails at once (no retry, redirects never followed)', async (status, headers) => {
    const { runId, deliveryId } = await runToDelivery();
    target.responders.push(reply(status, headers));
    const before = target.received.length;
    expect(await deliverer().deliver(scope(), deliveryId)).toMatchObject({
      status: 'failed',
      attempt: 1,
      code: 'http_status',
    });
    expect(target.received.length - before).toBe(1);
    expect(await stepOf(runId)).toMatchObject({
      status: 'failed',
      error: { code: 'http_status', params: { status } },
    });
  });

  it('holds no database connection while the destination is slow', async () => {
    const applicationName = `cellhive-http-${randomBytes(3).toString('hex')}`;
    const own = createTestDb(database.url);
    const jobDb = createDb({
      url: database.url,
      poolMax: 2,
      applicationName,
    });
    try {
      const { deliveryId } = await runToDelivery();
      target.responders.push(slow(3_000));
      const call = deliverer({}, jobDb).deliver(scope(), deliveryId);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(target.inFlight).toBe(1);
      const { rows } = await sql<{ state: string | null }>`
        SELECT state FROM pg_stat_activity WHERE application_name = ${applicationName}
      `.execute(own.kysely);
      // Pooled connections may stay open, but none is in a query or a transaction.
      expect(rows.filter((row) => row.state !== 'idle')).toEqual([]);
      expect(await call).toMatchObject({ status: 'succeeded' });
    } finally {
      await jobDb.destroy();
      await own.destroy();
    }
  });

  it('40 deliveries to one host: at most 20 + 10/s go, the rest are deferred (rate)', async () => {
    const ids: Id<'hdl'>[] = [];
    for (let index = 0; index < 40; index += 1) {
      ids.push(await testDelivery(fx.orgId, fx.users.owner.id, '/bulk'));
    }
    const started = performance.now();
    const results = [];
    for (const id of ids) results.push(await deliverer().deliver(scope(), id));
    const seconds = (performance.now() - started) / 1000;
    const sent = results.filter((result) => result.status === 'succeeded').length;
    const deferred = results.filter(
      (result) => result.status === 'deferred' && result.reason === 'rate',
    ).length;
    expect(sent).toBeGreaterThanOrEqual(20);
    expect(sent).toBeLessThanOrEqual(20 + Math.ceil(10 * seconds));
    expect(sent + deferred).toBe(40);
    // A deferred row is pending again, its attempt not counted.
    const deferredId = ids[results.findIndex((result) => result.status === 'deferred')];
    if (deferredId !== undefined) {
      expect(await deliveryRow(deferredId)).toMatchObject({ status: 'pending', attempts: 0 });
    }
  });

  it('two calls in flight for an organization: the third waits, another organization does not', async () => {
    const a1 = await testDelivery(fx.orgId, fx.users.owner.id, '/slow');
    const a2 = await testDelivery(fx.orgId, fx.users.owner.id, '/slow');
    const a3 = await testDelivery(fx.orgId, fx.users.owner.id);
    const b1 = await testDelivery(otherOrg, strangerId);
    target.responders.push(slow(1_500), slow(1_500));
    const running = [deliverer().deliver(scope(), a1), deliverer().deliver(scope(), a2)];
    const deadline = Date.now() + 3_000;
    while (target.inFlight < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(target.inFlight).toBe(2);
    expect(await deliverer().deliver(scope(), a3)).toMatchObject({
      status: 'deferred',
      reason: 'in_flight',
    });
    expect(await deliverer().deliver(orgScope(otherOrg), b1)).toMatchObject({
      status: 'succeeded',
    });
    expect(await Promise.all(running)).toEqual([
      expect.objectContaining({ status: 'succeeded' }),
      expect.objectContaining({ status: 'succeeded' }),
    ]);
  });

  it('call slots of the process (QA S5c): two slow calls fill them, a third organization waits (worker_busy)', async () => {
    const a1 = await testDelivery(fx.orgId, fx.users.owner.id, '/slow');
    const b1 = await testDelivery(otherOrg, strangerId, '/slow');
    const b2 = await testDelivery(otherOrg, strangerId);
    const callSlots = createHttpCallSlots(2);
    target.responders.push(slow(1_500), slow(1_500));
    // Two organizations, one call each: the per-organization semaphore lets both go.
    const running = [
      deliverer({ callSlots }).deliver(scope(), a1),
      deliverer({ callSlots }).deliver(orgScope(otherOrg), b1),
    ];
    const deadline = Date.now() + 3_000;
    while (target.inFlight < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(target.inFlight).toBe(2);
    const before = target.received.length;
    const busy = await deliverer({ callSlots }).deliver(orgScope(otherOrg), b2);
    expect(busy).toMatchObject({ status: 'deferred', reason: 'worker_busy' });
    expect(target.received.length).toBe(before);
    // Given back: pending, the attempt not counted, tried again about a second later.
    const row = await new HttpDeliveriesRepository(db).get(orgScope(otherOrg), b2);
    expect(row).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await Promise.all(running)).toEqual([
      expect.objectContaining({ status: 'succeeded' }),
      expect.objectContaining({ status: 'succeeded' }),
    ]);
    // Slots freed once the calls ended (whatever their outcome).
    expect(await deliverer({ callSlots }).deliver(orgScope(otherOrg), b2)).toMatchObject({
      status: 'succeeded',
    });
  });

  it.each([
    ['text with NUL', 'text/plain', 'a\u0000b', 'a�b'],
    ['JSON with an escaped NUL', 'application/json', '{"x":"a\\u0000b"}', { x: 'a�b' }],
    ['JSON with a lone surrogate', 'application/json', '{"x":"\\ud800"}', { x: '�' }],
    ['JSON key with NUL', 'application/json', '{"a\\u0000":1}', { 'a�': 1 }],
  ])(
    'QA S5c: a response %s is stored (U+FFFD), the step succeeds after one call',
    async (_label, contentType, body, stored) => {
      const { runId, deliveryId } = await runToDelivery();
      const before = target.received.length;
      target.responders.push(reply(200, { 'content-type': contentType }, body));
      expect(await deliverer().deliver(scope(), deliveryId)).toMatchObject({
        status: 'succeeded',
      });
      expect(target.received.length - before).toBe(1);
      expect(await deliveryRow(deliveryId)).toMatchObject({
        status: 'succeeded',
        response: { status: 200, body: stored },
      });
      expect(await stepOf(runId)).toMatchObject({ status: 'succeeded' });
    },
  );

  it('QA S5c: a response the database cannot store fails the delivery after the attempts, never loops', async () => {
    const { runId, deliveryId } = await runToDelivery();
    // A TX-b that always throws (stands in for any write PostgreSQL refuses).
    const broken = deliverer({
      now: () => new Date(),
    });
    const repository = (broken as unknown as { deliveries: HttpDeliveriesRepository }).deliveries;
    const succeed = repository.succeed.bind(repository);
    repository.succeed = () => Promise.reject(new Error('refused by the database'));
    try {
      await expect(broken.deliver(scope(), deliveryId)).rejects.toThrow('refused by the database');
    } finally {
      repository.succeed = succeed;
    }
    // The row is left `sending` with its attempt; past the attempts cap a lease fails it.
    await sql`
      UPDATE meta.http_deliveries
         SET attempts = ${HTTP_DELIVERY_MAX_ATTEMPTS}, lease_until = now() - interval '1 second'
       WHERE id = ${deliveryId}
    `.execute(db.kysely);
    const before = target.received.length;
    expect(await deliverer().deliver(scope(), deliveryId)).toMatchObject({
      status: 'failed',
      code: 'internal_error',
    });
    expect(target.received.length).toBe(before);
    expect(await deliveryRow(deliveryId)).toMatchObject({ status: 'failed' });
    expect(await stepOf(runId)).toMatchObject({
      status: 'failed',
      error: { code: 'internal_error', params: { reason: 'attempts_exhausted' } },
    });
  });

  it('QA S5c: a resolver failing for now (EAI_AGAIN) is retried; a name that does not exist fails', async () => {
    const flaky = await runToDelivery();
    const before = target.received.length;
    const again = await deliverer({
      lookup: () => Promise.reject(Object.assign(new Error('try again'), { code: 'EAI_AGAIN' })),
    }).deliver(scope(), flaky.deliveryId);
    expect(again).toMatchObject({ status: 'retry_scheduled', code: 'ssrf_blocked' });
    expect(await deliveryRow(flaky.deliveryId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: { code: 'ssrf_blocked', params: { reason: 'unresolvable', cause: 'temporary' } },
    });
    const missing = await runToDelivery();
    const gone = await deliverer({
      lookup: () => Promise.reject(Object.assign(new Error('no such host'), { code: 'ENOTFOUND' })),
    }).deliver(scope(), missing.deliveryId);
    expect(gone).toMatchObject({ status: 'failed', code: 'ssrf_blocked' });
    expect(target.received.length).toBe(before);
  });

  it('review fix: no DNS slot of the process in time (ELOOKUPQUEUE) → deferred (dns_busy), the attempt not counted', async () => {
    const { runId, deliveryId } = await runToDelivery();
    const before = target.received.length;
    const result = await deliverer({
      // Other organizations' hung lookups hold every slot of the system resolver.
      lookup: () =>
        Promise.reject(Object.assign(new Error('lookup queue timeout'), { code: 'ELOOKUPQUEUE' })),
    }).deliver(scope(), deliveryId);
    expect(result).toMatchObject({ status: 'deferred', reason: 'dns_busy' });
    expect(target.received.length).toBe(before);
    const row = await deliveryRow(deliveryId);
    expect(row).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
    expect(row?.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 3_000);
    expect(await stepOf(runId)).toMatchObject({ status: 'waiting' });
    // Once a slot is free, the same delivery goes out on its first counted attempt.
    const later = () => new Date(Date.now() + HTTP_DNS_BUSY_RETRY_MS + 1_000);
    expect(await deliverer({ now: later }).deliver(scope(), deliveryId)).toMatchObject({
      status: 'succeeded',
      attempt: 1,
    });
  });

  it('Valkey down → deferred (unavailable), the attempt not counted', async () => {
    const { deliveryId } = await runToDelivery();
    const down = new Redis('redis://127.0.0.1:1', {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    down.on('error', () => undefined);
    try {
      const before = target.received.length;
      const result = await deliverer({
        pacer: createValkeyHostPacer(valkeyQuotaClient(down)),
      }).deliver(scope(), deliveryId);
      expect(result).toMatchObject({ status: 'deferred', reason: 'unavailable' });
      expect(target.received.length).toBe(before);
      expect(await deliveryRow(deliveryId)).toMatchObject({ status: 'pending', attempts: 0 });
    } finally {
      down.disconnect();
    }
  });

  it('cancelling the run cancels its pending delivery: the destination never receives it', async () => {
    const { runId, deliveryId } = await runToDelivery();
    const response = await fx.call(
      'u_admin',
      'POST',
      `/automation-runs/${runId}/cancel`,
      undefined,
      {
        'idempotency-key': newId('req'),
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(await deliveryRow(deliveryId)).toMatchObject({ status: 'cancelled', request_enc: null });
    const before = target.received.length;
    expect(await deliverer().deliver(scope(), deliveryId)).toEqual({ status: 'final' });
    expect(target.received.length).toBe(before);
  });

  it('a deleted signing secret fails the delivery (secret_unavailable), never sends unsigned', async () => {
    const doomed = await createSecret('Sắp xoá');
    const { runId, deliveryId } = await runToDelivery(
      delivery('/hook', { signingSecretId: doomed }),
    );
    const removed = await fx.call('owner', 'DELETE', `/secrets/${doomed}`);
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await deliveryRow(deliveryId))?.signing_secret_id).toBeNull();
    const before = target.received.length;
    expect(await deliverer().deliver(scope(), deliveryId)).toMatchObject({
      status: 'failed',
      code: 'secret_unavailable',
    });
    expect(target.received.length).toBe(before);
    expect(await stepOf(runId)).toMatchObject({
      status: 'failed',
      error: { code: 'secret_unavailable' },
    });
  });

  it('T701: a host the secret may not go to fails before the secret is read and before DNS', async () => {
    const { runId, deliveryId } = await runToDelivery(
      delivery('/hook', {
        signingSecretId: SIGNING_ID,
        authSecretId: AUTH_ID,
        request: { ...delivery().request, authHeaderName: 'Authorization' },
      }),
    );
    const calls: string[] = [];
    const before = target.received.length;
    const result = await deliverer({
      secrets: {
        hosts: (_scope, input) => {
          calls.push(`hosts:${input.purpose}`);
          // The auth secret may go to its host; the signing secret only elsewhere.
          return Promise.resolve({
            allowedHosts:
              input.purpose === 'auth' ? [`${host}:${String(target.port)}`] : ['crm.test'],
            legacyHostsUntil: null,
          });
        },
        values: (_scope, input) => {
          calls.push(`values:${input.purpose}`);
          return Promise.resolve(['never-used']);
        },
      },
      lookup: (name) => {
        calls.push(`lookup:${name}`);
        return Promise.resolve(['127.0.0.1']);
      },
    }).deliver(scope(), deliveryId);
    expect(result).toMatchObject({ status: 'failed', attempt: 1, code: 'secret_host_not_allowed' });
    // Hosts of both secrets checked first; no value unsealed, no lookup, nothing sent.
    expect(calls).toEqual(['hosts:auth', 'hosts:signing']);
    expect(target.received.length).toBe(before);
    expect(await deliveryRow(deliveryId)).toMatchObject({
      status: 'failed',
      attempts: 1,
      request_enc: null,
      last_error: {
        code: 'secret_host_not_allowed',
        params: { purpose: 'signing', secret_id: SIGNING_ID, reason: 'not_listed' },
      },
    });
    expect(await stepOf(runId)).toMatchObject({
      status: 'failed',
      error: { code: 'secret_host_not_allowed' },
    });
  });

  it('a private address outside the allowlist is blocked (ssrf_blocked) without a retry', async () => {
    const { deliveryId } = await runToDelivery();
    expect(await deliverer({ allowlist: [] }).deliver(scope(), deliveryId)).toMatchObject({
      status: 'failed',
      code: 'ssrf_blocked',
    });
    expect(await deliveryRow(deliveryId)).toMatchObject({
      last_error: { code: 'ssrf_blocked', params: { reason: 'port_not_allowed' } },
    });
  });

  it('run detail: delivery (host, attempts, codes) for the manager only, never URL, headers or bodies (P50)', async () => {
    const { runId, deliveryId } = await runToDelivery(
      delivery('/hook', {
        signingSecretId: SIGNING_ID,
        authSecretId: AUTH_ID,
        request: {
          ...delivery().request,
          authHeaderName: 'Authorization',
        },
      }),
    );
    target.responders.push(reply(500));
    await deliverer().deliver(scope(), deliveryId);

    const response = await fx.call('u_admin', 'GET', `/automation-runs/${runId}`);
    expect(response.statusCode, response.body).toBe(200);
    const detail = automationRunDetailSchema.parse(response.json());
    const step = detail.steps.find((item) => item.action_id === 'act_http');
    expect(step).toMatchObject({
      status: 'waiting',
      delivery: {
        id: deliveryId,
        target_host: host,
        attempts: 1,
        status: 'pending',
        last_status: 500,
        last_error: { code: 'http_status', params: { status: 500 } },
      },
    });
    expect(step?.delivery?.next_attempt_at).not.toBeNull();
    for (const canary of [
      URL_CANARY,
      '/hook',
      String(target.port),
      'canary-header-value',
      'canary-body-value',
      'canary-auth-secret-value',
      SIGNING_SECRET,
    ]) {
      expect(response.body).not.toContain(canary);
    }
    // Not a manager of the automation: the run does not exist for them.
    expect((await fx.call('u_editor', 'GET', `/automation-runs/${runId}`)).statusCode).toBe(404);
    expect((await fx.call('stranger', 'GET', `/automation-runs/${runId}`)).statusCode).toBe(404);
    // Nothing secret reached the logs either.
    for (const canary of [URL_CANARY, 'canary-body-value', 'canary-auth-secret-value']) {
      expect(t.logs.raw()).not.toContain(canary);
    }
  });
});
