import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  automationRunDetailSchema,
  automationSchema,
  DEFAULT_AUTOMATION_MAX_DEPTH,
  httpDeliveryResultSchema,
  incomingWebhookWithSecretsSchema,
  newId,
  roleListSchema,
  secretWithValueSchema,
  type AutomationDto,
  type Id,
  type IncomingWebhookWithSecretsDto,
  type SecretWithValueDto,
} from '@cellhive/contracts';
import { verifyWebhook, type Db } from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IncomingWebhookRateLimits } from '../../src/common/rate-limit/incoming-webhook-rate-limits.js';
import { DB } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { AddressInfo, Socket } from 'node:net';

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

/** A loopback destination: requests recorded, connections counted, queued responders. */
interface FakeTarget {
  readonly port: number;
  readonly received: Received[];
  connections: number;
  readonly responders: ((req: IncomingMessage, res: ServerResponse) => void)[];
  close(): Promise<void>;
}

async function startTarget(): Promise<FakeTarget> {
  const sockets = new Set<Socket>();
  const target: FakeTarget = {
    port: 0,
    received: [],
    connections: 0,
    responders: [],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
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
      res.end(JSON.stringify({ ok: true, id: 42, echo: 'canary-response-body' }));
    });
  });
  server.on('connection', (socket) => {
    target.connections += 1;
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

const AUTH_VALUE = 'Bearer canary-http-header-secret-value';
/** The secret of the Standard Webhooks spec example, entered as a value. */
const SPEC_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

/**
 * BACKLOG T606 (ADR-35 §4, §5, §8; CONTRACTS §21, §24, §25.5) through the
 * real API and worker: `http_request` saved with its checks
 * (`HEADER_NOT_ALLOWED`, `INVALID_URL`, `SECRET_NOT_USABLE`, P47), the
 * `http_header`/`webhook_signing` secrets (generated once, replaced with a
 * 24-hour overlap), a run rendered as `run_as` and delivered through the
 * outbox — auth header, Standard Webhooks signature checked with
 * `verifyWebhook` (two signatures while rotating), output used by a later
 * step —, `fail_on_http_error`, SSRF through the action (P48), "Send a
 * test" through the outbox (`429`, who reads the result — P50), the run
 * detail (P50, the response body only for viewers who read the values
 * used), secret canaries, and the S5c milestone: A → `http_request` to B's
 * hook → B's write that would trigger A stops at the depth limit.
 */
describe('http_request action and HTTP secrets (T606)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let target: FakeTarget;
  let trap: FakeTarget;
  let apiPort: number;
  const workerLogs = captureLogger();

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const hooksUrl = (path = '/hook') => `http://hooks.test:${String(target.port)}${path}`;

  /** Names the worker resolves: everything to loopback but the SSRF probes. */
  const lookup = (host: string): Promise<readonly string[]> => {
    if (host === 'rebind.test') return Promise.resolve(['10.0.0.7']);
    if (host === 'metadata.test') return Promise.resolve(['169.254.169.254']);
    return Promise.resolve(['127.0.0.1']);
  };

  async function secret(
    body: Record<string, unknown>,
    user: 'owner' | 'u_admin' = 'owner',
  ): Promise<SecretWithValueDto> {
    const response = await fx.call(user, 'POST', `/orgs/${fx.orgId}/secrets`, {
      name: `Secret ${newId('sec').slice(4, 12)}`,
      // T701: HTTP secrets name the hosts they may go to (the fake destination, the API).
      ...(body['kind'] === 'telegram_bot'
        ? {}
        : { allowed_hosts: [`hooks.test:${String(target.port)}`, `api.test:${String(apiPort)}`] }),
      ...body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return secretWithValueSchema.parse(response.json());
  }

  async function allow(pattern: string): Promise<void> {
    const response = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern,
    });
    expect(response.statusCode, response.body).toBe(201);
  }

  const saveAutomation = (user: 'u_admin' | 'u_sales1', definition: object, enabled = true) =>
    fx.call(user, 'POST', `/bases/${fx.baseId}/automations`, {
      name: `HTTP ${newId('aut').slice(4, 12)}`,
      enabled,
      definition,
    });

  async function automation(definition: object, enabled = true): Promise<AutomationDto> {
    const response = await saveAutomation('u_admin', definition, enabled);
    expect(response.statusCode, response.body).toBe(201);
    return automationSchema.parse(response.json());
  }

  async function disable(id: Id<'aut'>): Promise<void> {
    const response = await fx.call('u_admin', 'POST', `/automations/${id}/disable`);
    expect(response.statusCode, response.body).toBe(200);
  }

  async function createOrder(fields: Record<string, unknown>): Promise<Id<'rec'>> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ fields }] },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  interface RunRow {
    readonly id: Id<'run'>;
    readonly status: string;
    readonly error: Record<string, unknown> | null;
  }

  async function runsOf(id: Id<'aut'>): Promise<RunRow[]> {
    const { rows } = await sql<RunRow>`
      SELECT id, status, error FROM meta.automation_runs
       WHERE automation_id = ${id} ORDER BY created_at, id
    `.execute(db.kysely);
    return rows;
  }

  async function finishedRun(id: Id<'aut'>, count = 1): Promise<RunRow> {
    const runs = await eventually(
      async () => {
        const rows = await runsOf(id);
        const done = rows.filter((row) => ['succeeded', 'failed', 'skipped'].includes(row.status));
        return done.length >= count ? done : undefined;
      },
      `run of ${id}`,
      45_000,
    ).catch(async (error: unknown) => {
      const { rows } = await sql<Record<string, unknown>>`
        SELECT r.status AS run, s.status AS step, s.error, s.output, d.status AS delivery,
               d.attempts, d.last_error
          FROM meta.automation_runs r
          LEFT JOIN meta.automation_run_steps s ON s.run_id = r.id
          LEFT JOIN meta.http_deliveries d ON d.run_id = r.id
         WHERE r.automation_id = ${id}
      `.execute(db.kysely);
      const problems = workerLogs.logs.lines.filter((line) => Number(line['level']) >= 40);
      throw new Error(
        `${String(error)}\n${JSON.stringify(rows)}\n${JSON.stringify(problems.slice(-10))}`,
      );
    });
    return runs[count - 1] as RunRow;
  }

  async function settled(): Promise<void> {
    await eventually(async () => {
      const { rows } = await sql<{ events: number; runs: number; deliveries: number }>`
        SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL) AS events,
               (SELECT count(*)::int FROM meta.automation_runs
                 WHERE status IN ('queued', 'running', 'waiting')) AS runs,
               (SELECT count(*)::int FROM meta.http_deliveries
                 WHERE status IN ('pending', 'sending')) AS deliveries
      `.execute(db.kysely);
      return rows[0]?.events === 0 && rows[0].runs === 0 && rows[0].deliveries === 0;
    }, 'events dispatched, runs and deliveries finished');
  }

  const httpStep = (config: Record<string, unknown>, id = 'act_http') => ({
    id,
    type: 'http_request',
    config: { method: 'POST', url: { literal: hooksUrl() }, ...config },
  });
  const onOrderCreated = { type: 'record.created', table_id: '' };

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, WEBHOOK_MAX_RATE_PER_SEC: '1000' });
    fx = await buildRecordFixture(t, db);
    onOrderCreated.table_id = fx.orders.id;
    const limits = t.app.get(IncomingWebhookRateLimits);
    limits.ip = { limit: 100_000, windowSeconds: 1 };
    limits.base = { ratePerSec: 100_000, burst: 100_000 };
    // The fixture variant of P29/P32 (P47, P50): Sales `manage`s Orders.
    const roles = roleListSchema.parse(
      (await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    ).items;
    const sales = roles.find((role) => role.name === 'Sales');
    if (sales === undefined) throw new Error('no Sales role');
    const tables = sales.config.tables as Record<string, Record<string, unknown>>;
    const patched = await fx.call('u_admin', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
      config: {
        ...sales.config,
        tables: { ...tables, [fx.orders.id]: { ...tables[fx.orders.id], perm: 'manage' } },
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    target = await startTarget();
    trap = await startTarget();
    // The milestone calls the API's own hook route over the network.
    await t.app.listen(0, '127.0.0.1');
    apiPort = (t.app.getHttpServer().address() as AddressInfo).port;
    await allow(`hooks.test:${String(target.port)}`);
    await allow(`api.test:${String(apiPort)}`);
    await allow('metadata.test');
    worker = await createWorker(t.config, {
      logger: workerLogs.logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db: t.app.get<Db>(DB),
        logger: workerLogs.logger,
        httpDelivery: { lookup },
      }),
    });
  });

  afterAll(async () => {
    await settled().catch(() => undefined);
    await worker.close();
    await target.close();
    await trap.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  // --- Saving ---------------------------------------------------------------------------

  it('saves only valid steps: HEADER_NOT_ALLOWED, INVALID_URL, SECRET_NOT_USABLE, P47', async () => {
    const header = await secret({ kind: 'http_header', value: AUTH_VALUE });
    const bot = await secret({
      kind: 'telegram_bot',
      value: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0',
    });
    const elsewhere = await secret({
      kind: 'webhook_signing',
      generate: true,
      base_scope: 'selected',
      base_ids: [],
    });
    const save = (config: Record<string, unknown>, user: 'u_admin' | 'u_sales1' = 'u_admin') =>
      saveAutomation(user, { trigger: onOrderCreated, actions: [httpStep(config)] }, false);
    const P = 'definition.actions[0].config';
    const codes = (response: Awaited<ReturnType<typeof save>>) =>
      response
        .json<{ errors: { path: string; code: string }[] }>()
        .errors.map(({ path, code }) => ({ path, code }));

    const host = await save({ headers: [{ name: 'Host', value: { literal: 'evil.test' } }] });
    expectProblem(host, 422, 'AUTOMATION_INVALID');
    expect(codes(host)).toEqual([{ path: `${P}.headers[0].name`, code: 'HEADER_NOT_ALLOWED' }]);

    const url = await save({ url: { literal: 'ftp://hooks.test/' } });
    expectProblem(url, 422, 'AUTOMATION_INVALID');
    expect(codes(url)).toEqual([{ path: `${P}.url`, code: 'INVALID_URL' }]);

    // A bot is not an auth header; a secret out of the base's scope is not usable.
    const secrets = await save({
      auth: { header_name: 'Authorization', secret_id: bot.id },
      signing_secret_id: elsewhere.id,
    });
    expectProblem(secrets, 422, 'AUTOMATION_INVALID');
    expect(codes(secrets)).toEqual([
      { path: `${P}.auth.secret_id`, code: 'SECRET_NOT_USABLE' },
      { path: `${P}.signing_secret_id`, code: 'SECRET_NOT_USABLE' },
    ]);

    // P47: u_sales1 manages Orders but does not read `cost`.
    const p47 = await save(
      { body: { type: 'json', value: { template: `{"cost": {{ [${F('cost')}] }}}` } } },
      'u_sales1',
    );
    expectProblem(p47, 422, 'AUTOMATION_INVALID');
    expect(codes(p47)).toEqual([{ path: `${P}.body.value.template`, code: 'UNKNOWN_FIELD' }]);

    const valid = await save({ auth: { header_name: 'Authorization', secret_id: header.id } });
    expect(valid.statusCode, valid.body).toBe(201);
    const id = automationSchema.parse(valid.json()).id;
    // The secret is now in use.
    const usages = await fx.call('owner', 'GET', `/secrets/${header.id}/usages`);
    expect(usages.json()).toMatchObject({ total: 1, items: [{ automation_id: id }] });
    expectProblem(await fx.call('owner', 'DELETE', `/secrets/${header.id}`), 409, 'SECRET_IN_USE');
    expect((await fx.call('u_admin', 'DELETE', `/automations/${id}`)).statusCode).toBe(204);
  });

  // --- Secrets ----------------------------------------------------------------------------

  it('secrets: values checked per kind, a generated signing secret shown once, replaced with a 24 h overlap', async () => {
    const bad = (body: Record<string, unknown>) =>
      fx.call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
        name: 'Bad',
        allowed_hosts: ['hooks.test'],
        ...body,
      });
    expectProblem(
      await bad({ kind: 'http_header', value: 'line\r\nX-Evil: 1' }),
      422,
      'VALIDATION_FAILED',
    );
    expectProblem(
      await bad({ kind: 'webhook_signing', value: 'whsec_short' }),
      422,
      'VALIDATION_FAILED',
    );
    expect((await bad({ kind: 'webhook_signing', value: 'whsec_short' })).body).toContain(
      'INVALID_SECRET_VALUE',
    );
    expectProblem(await bad({ kind: 'http_header', generate: true }), 422, 'VALIDATION_FAILED');

    const generated = await secret({ kind: 'webhook_signing', generate: true });
    expect(generated.value).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/u);
    expect(generated.previous_value_expires_at).toBeNull();
    const list = await fx.call('owner', 'GET', `/orgs/${fx.orgId}/secrets`);
    expect(list.body).not.toContain(generated.value);
    expect(list.body).not.toContain('"value"');

    const before = Date.now();
    const rotated = await fx.call('owner', 'PATCH', `/secrets/${generated.id}`, { generate: true });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const dto = secretWithValueSchema.parse(rotated.json());
    expect(dto.value).toMatch(/^whsec_/u);
    expect(dto.value).not.toBe(generated.value);
    const until = Date.parse(dto.previous_value_expires_at ?? '');
    expect(until - before).toBeGreaterThan(23.9 * 3600_000);
    expect(until - before).toBeLessThanOrEqual(24 * 3600_000 + 5_000);

    const header = await secret({ kind: 'http_header', value: AUTH_VALUE });
    expectProblem(
      await fx.call('owner', 'PATCH', `/secrets/${header.id}`, { generate: true }),
      422,
      'VALIDATION_FAILED',
    );
    // A new header value does not keep the old one.
    const replaced = await fx.call('owner', 'PATCH', `/secrets/${header.id}`, {
      value: 'Bearer other-canary',
    });
    expect(secretWithValueSchema.parse(replaced.json()).previous_value_expires_at).toBeNull();
    // Members other than owners/admins cannot manage HTTP secrets either.
    expectProblem(
      await fx.call('u_admin', 'POST', `/orgs/${fx.orgId}/secrets`, {
        kind: 'http_header',
        name: 'Nope',
        value: 'x',
        allowed_hosts: ['hooks.test'],
      }),
      403,
      'PERMISSION_DENIED',
    );
    // Base automation managers list them by name and kind.
    const forBase = await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/secrets?kind=http_header`);
    expect(forBase.statusCode).toBe(200);
    expect(
      forBase.json<{ items: { kind: string }[] }>().items.every((i) => i.kind === 'http_header'),
    ).toBe(true);
    // Audit: never a value.
    const { rows } = await sql<{ text: string }>`
      SELECT coalesce(before::text, '') || coalesce(after::text, '') AS text
        FROM meta.audit_logs WHERE entity_id IN (${generated.id}, ${header.id})
    `.execute(db.kysely);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.text).not.toContain(generated.value);
      expect(row.text).not.toContain(dto.value);
      expect(row.text).not.toContain('canary');
    }
  });

  // --- Running ----------------------------------------------------------------------------

  it('renders as run_as, sends through the outbox with the auth header and a signature; a later step uses the output', async () => {
    const header = await secret({ kind: 'http_header', value: AUTH_VALUE });
    const signing = await secret({ kind: 'webhook_signing', value: SPEC_SECRET });
    const flow = await automation({
      trigger: onOrderCreated,
      actions: [
        httpStep({
          url: { template: `${hooksUrl('/orders')}/{{ [${F('title')}] }}` },
          query: [{ name: 'source', value: { literal: 'cellhive' } }],
          headers: [{ name: 'X-Order', value: { template: `{{ [${F('title')}] }}` } }],
          auth: { header_name: 'Authorization', secret_id: header.id },
          body: {
            type: 'json',
            value: {
              template: `{"title": "{{ [${F('title')}] }}", "amount": {{ [${F('amount')}] }}}`,
            },
          },
          signing_secret_id: signing.id,
        }),
        {
          id: 'act_after',
          type: 'update_record',
          config: {
            table_id: fx.orders.id,
            record_id: null,
            fields: { [F('amount')]: { step: 'act_http', path: 'body.id' } },
          },
        },
      ],
    });
    const before = target.received.length;
    const record = await createOrder({ [F('title')]: 'Đơn "1"/x', [F('amount')]: 7 });
    const run = await finishedRun(flow.id);
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
    expect(target.received.length - before).toBe(1);
    const received = target.received.at(-1) as Received;
    expect(received.method).toBe('POST');
    // The title is one path segment: its slash and quote are encoded.
    expect(received.url).toBe('/orders/%C4%90%C6%A1n%20%221%22%2Fx?source=cellhive');
    expect(received.headers['authorization']).toBe(AUTH_VALUE);
    // Header values are ASCII: other characters are percent-encoded.
    expect(received.headers['x-order']).toBe('%C4%90%C6%A1n "1"/x');
    expect(received.headers['content-type']).toBe('application/json');
    expect(JSON.parse(received.body)).toEqual({ title: 'Đơn "1"/x', amount: 7 });
    expect(received.headers['webhook-id']).toMatch(/^hdl_/u);
    expect(received.headers['idempotency-key']).toBe(
      `${flow.id}:${(await eventIdOf(record)) ?? run.id}:act_http`,
    );
    expect(typeof received.headers['x-cellhive-causation']).toBe('string');
    // Signed with the Standard Webhooks spec secret.
    expect(verifyWebhook(received.headers, received.body, [SPEC_SECRET], new Date())).toEqual({
      ok: true,
    });
    // The later step wrote `body.id` of the response.
    const read = await fx.call(
      'u_admin',
      'GET',
      `/tables/${fx.orders.id}/records/${record}?field_key_type=id`,
    );
    expect(read.json<{ fields: Record<string, unknown> }>().fields[F('amount')]).toBe(42);
    await disable(flow.id);
  });

  async function eventIdOf(record: Id<'rec'>): Promise<string | undefined> {
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM meta.events
       WHERE entity_id = ${record} AND type = 'record.created' LIMIT 1
    `.execute(db.kysely);
    return rows[0]?.id;
  }

  it('a replaced signing secret signs twice for 24 hours: either value verifies', async () => {
    const signing = await secret({ kind: 'webhook_signing', generate: true });
    const old = signing.value as string;
    const rotated = secretWithValueSchema.parse(
      (await fx.call('owner', 'PATCH', `/secrets/${signing.id}`, { generate: true })).json(),
    );
    const next = rotated.value as string;
    const flow = await automation({
      trigger: onOrderCreated,
      actions: [
        httpStep({
          signing_secret_id: signing.id,
          body: { type: 'text', value: { literal: 'hi' } },
        }),
      ],
    });
    const before = target.received.length;
    await createOrder({ [F('title')]: 'rotation' });
    expect((await finishedRun(flow.id)).status).toBe('succeeded');
    expect(target.received.length - before).toBe(1);
    const received = target.received.at(-1) as Received;
    expect(String(received.headers['webhook-signature']).split(' ')).toHaveLength(2);
    const now = new Date();
    expect(verifyWebhook(received.headers, received.body, [old], now)).toEqual({ ok: true });
    expect(verifyWebhook(received.headers, received.body, [next], now)).toEqual({ ok: true });
    expect(
      verifyWebhook(
        received.headers,
        received.body,
        ['whsec_' + Buffer.alloc(32, 1).toString('base64')],
        now,
      ),
    ).toMatchObject({ ok: false });
    // Once the overlap is over, only the new value signs.
    await sql`UPDATE meta.secrets SET previous_expires_at = now() - interval '1 second'
               WHERE id = ${signing.id}`.execute(db.kysely);
    await createOrder({ [F('title')]: 'after overlap' });
    expect((await finishedRun(flow.id, 2)).status).toBe('succeeded');
    const later = target.received.at(-1) as Received;
    expect(String(later.headers['webhook-signature']).split(' ')).toHaveLength(1);
    expect(verifyWebhook(later.headers, later.body, [next], new Date())).toEqual({ ok: true });
    expect(verifyWebhook(later.headers, later.body, [old], new Date())).toMatchObject({
      ok: false,
    });
    await disable(flow.id);
  });

  it('fail_on_http_error: false ends a 404 succeeded with its status; true fails http_status', async () => {
    const lenient = await automation({
      trigger: onOrderCreated,
      actions: [httpStep({ fail_on_http_error: false }, 'act_lenient')],
    });
    target.responders.push(reply(404, { 'content-type': 'text/plain' }, 'nope'));
    await createOrder({ [F('title')]: 'lenient' });
    const run = await finishedRun(lenient.id);
    expect(run.status).toBe('succeeded');
    const detail = automationRunDetailSchema.parse(
      (await fx.call('u_admin', 'GET', `/automation-runs/${run.id}`)).json(),
    );
    expect(detail.steps[0]).toMatchObject({
      status: 'succeeded',
      output: { status: 404, body: 'nope', headers: { 'content-type': 'text/plain' } },
      delivery: { status: 'succeeded', last_status: 404, attempts: 1 },
    });
    await disable(lenient.id);

    const strict = await automation({ trigger: onOrderCreated, actions: [httpStep({})] });
    target.responders.push(reply(404));
    await createOrder({ [F('title')]: 'strict' });
    const failed = await finishedRun(strict.id);
    expect(failed).toMatchObject({
      status: 'failed',
      error: { code: 'http_status', params: { status: 404 } },
    });
    await disable(strict.id);
  });

  // --- SSRF through the action (P48) -------------------------------------------------------

  it('P48: private, metadata, rebinding and redirect targets fail ssrf_blocked / http_status; nothing reaches loopback', async () => {
    const cases: [string, string, Record<string, unknown>][] = [
      ['http://169.254.169.254/latest/meta-data/', 'ssrf_blocked', { reason: 'blocked_address' }],
      [`http://127.0.0.1:${String(trap.port)}/`, 'ssrf_blocked', {}],
      ['http://10.0.0.5/', 'ssrf_blocked', { reason: 'private_address' }],
      ['http://rebind.test/', 'ssrf_blocked', { reason: 'private_address' }],
      // Allowlisted by name, still never the metadata address.
      ['http://metadata.test/', 'ssrf_blocked', { reason: 'blocked_address' }],
    ];
    for (const [url, code, params] of cases) {
      const flow = await automation({
        trigger: onOrderCreated,
        actions: [httpStep({ url: { literal: url } })],
      });
      await createOrder({ [F('title')]: `ssrf ${url}` });
      const run = await finishedRun(flow.id);
      expect(run, url).toMatchObject({ status: 'failed', error: { code, params } });
      await disable(flow.id);
    }
    // A redirect to loopback is not followed.
    const redirect = await automation({ trigger: onOrderCreated, actions: [httpStep({})] });
    target.responders.push(reply(302, { location: `http://127.0.0.1:${String(trap.port)}/` }));
    await createOrder({ [F('title')]: 'redirect' });
    expect(await finishedRun(redirect.id)).toMatchObject({
      status: 'failed',
      error: { code: 'http_status', params: { status: 302 } },
    });
    await disable(redirect.id);
    expect(trap.connections).toBe(0);
  });

  // --- Send a test (P50) ----------------------------------------------------------------------

  it('sends a test through the outbox: rendered as the caller, read by the sender only (P50), 429 past 10 per minute', async () => {
    const header = await secret({ kind: 'http_header', value: AUTH_VALUE });
    const flow = await automation(
      {
        trigger: onOrderCreated,
        actions: [
          httpStep({
            url: { literal: hooksUrl('/test') },
            auth: { header_name: 'X-Api-Key', secret_id: header.id },
            body: { type: 'json', value: { template: `{"title": "{{ [${F('title')}] }}"}` } },
          }),
        ],
      },
      false,
    );
    const record = await createOrder({
      [F('title')]: 'Đơn thử',
      [F('owner')]: [{ id: fx.users.u_sales1.id }],
    });
    const before = target.received.length;
    const accepted = await fx.call(
      'u_admin',
      'POST',
      `/automations/${flow.id}/actions/act_http/http-test`,
      { record_id: record },
    );
    expect(accepted.statusCode, accepted.body).toBe(202);
    const deliveryId = accepted.json<{ delivery_id: Id<'hdl'> }>().delivery_id;
    expect(deliveryId).toMatch(/^hdl_/u);
    const result = await eventually(async () => {
      const response = await fx.call('u_admin', 'GET', `/http-deliveries/${deliveryId}`);
      const body = httpDeliveryResultSchema.parse(response.json());
      return ['succeeded', 'failed'].includes(body.status) ? body : undefined;
    }, 'test delivery');
    expect(result).toMatchObject({
      kind: 'test',
      target_host: 'hooks.test',
      attempts: 1,
      response: { status: 200, body: { ok: true, id: 42 } },
      error: null,
    });
    expect(target.received.length - before).toBe(1);
    const received = target.received.at(-1) as Received;
    expect(received.headers['x-api-key']).toBe(AUTH_VALUE);
    expect(JSON.parse(received.body)).toEqual({ title: 'Đơn thử' });
    // A test carries no causation token.
    expect(received.headers['x-cellhive-causation']).toBeUndefined();
    // Only the sender reads it: another manager of the automation (u_sales1 manages
    // Orders, the owner is an org owner) gets 404 like anyone else.
    for (const user of ['u_sales1', 'owner', 'u_editor', 'u_reader', 'stranger'] as const) {
      expect((await fx.call(user, 'GET', `/http-deliveries/${deliveryId}`)).statusCode, user).toBe(
        404,
      );
    }
    // A test of u_sales1 on a record they read: rendered with their permissions.
    const own = await fx.call(
      'u_sales1',
      'POST',
      `/automations/${flow.id}/actions/act_http/http-test`,
      {
        record_id: record,
      },
    );
    expect(own.statusCode, own.body).toBe(202);
    // A record the caller does not read → 404; a step that is not http_request → 404.
    const hidden = await createOrder({ [F('title')]: 'not for sales' });
    expect(
      (
        await fx.call('u_sales1', 'POST', `/automations/${flow.id}/actions/act_http/http-test`, {
          record_id: hidden,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await fx.call('u_admin', 'POST', `/automations/${flow.id}/actions/act_none/http-test`, {}))
        .statusCode,
    ).toBe(404);
    // Not a manager: 403 (sees the automation) / 404.
    expectProblem(
      await fx.call('u_editor', 'POST', `/automations/${flow.id}/actions/act_http/http-test`, {}),
      403,
      'PERMISSION_DENIED',
    );
    // An invalid draft is refused before anything is queued.
    const draft = await fx.call(
      'u_admin',
      'POST',
      `/automations/${flow.id}/actions/act_http/http-test`,
      {
        draft: {
          method: 'POST',
          url: { literal: hooksUrl() },
          headers: [{ name: 'Host', value: { literal: 'x' } }],
        },
      },
    );
    expectProblem(draft, 422, 'AUTOMATION_INVALID');
    // Audited without values.
    const { rows } = await sql<{ after: Record<string, unknown> }>`
      SELECT after FROM meta.audit_logs
       WHERE organization_id = ${fx.orgId} AND action = 'automation.test_http_sent'
       ORDER BY created_at
    `.execute(db.kysely);
    expect(rows[0]?.after).toEqual({
      action_id: 'act_http',
      delivery_id: deliveryId,
      target_host: 'hooks.test',
    });
    // At most 10 tests per minute per person: the owner's 11th is refused.
    for (let index = 0; index < 10; index += 1) {
      const response = await fx.call(
        'owner',
        'POST',
        `/automations/${flow.id}/actions/act_http/http-test`,
        {},
      );
      expect(response.statusCode, response.body).toBe(202);
    }
    expectProblem(
      await fx.call('owner', 'POST', `/automations/${flow.id}/actions/act_http/http-test`, {}),
      429,
      'RATE_LIMITED',
    );
    await settled();
  });

  it('T616: "Send a test" with a webhook.received trigger uses the hook sample; no sample → empty values + no_sample', async () => {
    const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
      name: 'Sample for tests',
      auth: 'none',
    });
    expect(created.statusCode, created.body).toBe(201);
    const hook = incomingWebhookWithSecretsSchema.parse(created.json());
    const token = hook.url.split('/api/v1/hooks/')[1] as string;
    const flow = await automation(
      {
        trigger: { type: 'webhook.received', incoming_webhook_id: hook.id },
        actions: [
          httpStep({
            url: { literal: hooksUrl('/from-sample') },
            headers: [
              { name: 'X-Order', value: { trigger: 'body', path: 'order.id' } },
              { name: 'X-Source', value: { trigger: 'query', path: 'source' } },
            ],
            body: {
              type: 'json',
              value: { template: '{"sku": "{{ [@body.order.items[0\\].sku] }}"}' },
            },
          }),
        ],
      },
      false,
    );
    const send = () =>
      fx.call('u_admin', 'POST', `/automations/${flow.id}/actions/act_http/http-test`, {});
    const receivedOf = async (deliveryId: Id<'hdl'>): Promise<Received> => {
      await eventually(async () => {
        const response = await fx.call('u_admin', 'GET', `/http-deliveries/${deliveryId}`);
        const body = httpDeliveryResultSchema.parse(response.json());
        return ['succeeded', 'failed'].includes(body.status) ? body : undefined;
      }, 'test delivery');
      return target.received.at(-1) as Received;
    };

    // No sample yet: sent with empty values, and the caller is told.
    const empty = await send();
    expect(empty.statusCode, empty.body).toBe(202);
    expect(empty.json()).toMatchObject({ warnings: [{ code: 'no_sample' }] });
    const first = await receivedOf(empty.json<{ delivery_id: Id<'hdl'> }>().delivery_id);
    expect(JSON.parse(first.body)).toEqual({ sku: '' });
    expect(first.headers['x-order']).toBe('');

    // Listen, capture a request, then the test reads it.
    expect(
      (await fx.call('u_admin', 'POST', `/incoming-webhooks/${hook.id}/listen`)).statusCode,
    ).toBe(200);
    const hit = await t.app.inject({
      method: 'POST',
      url: `/api/v1/hooks/${token}?source=shop`,
      headers: { 'content-type': 'application/json', authorization: 'Bearer canary-not-kept' },
      payload: JSON.stringify({ order: { id: 'ORD-77', items: [{ sku: 'SKU-1' }] } }),
    });
    expect(hit.statusCode, hit.body).toBe(202);
    const withSample = await send();
    expect(withSample.statusCode, withSample.body).toBe(202);
    expect(withSample.json()).toMatchObject({ warnings: [] });
    const second = await receivedOf(withSample.json<{ delivery_id: Id<'hdl'> }>().delivery_id);
    expect(JSON.parse(second.body)).toEqual({ sku: 'SKU-1' });
    expect(second.headers['x-order']).toBe('ORD-77');
    expect(second.headers['x-source']).toBe('shop');
    expect(second.body).not.toContain('canary-not-kept');
    // Only a base admin manages a webhook.received automation (T604), so only they read the
    // sample through a test: u_sales1 (manages Orders) is refused before anything is rendered.
    expectProblem(
      await fx.call('u_sales1', 'POST', `/automations/${flow.id}/actions/act_http/http-test`, {}),
      403,
      'PERMISSION_DENIED',
    );
    await settled();
  });

  // --- Run detail (P50) and canaries --------------------------------------------------------

  it('P50 and canaries: managers see the delivery but never the URL, headers or secrets; the body only with every value readable', async () => {
    const header = await secret({ kind: 'http_header', value: AUTH_VALUE });
    const signing = await secret({ kind: 'webhook_signing', generate: true });
    const step = (field: string, id: string) =>
      httpStep(
        {
          url: { literal: `${hooksUrl('/canary')}?token=canary-url-token` },
          headers: [{ name: 'X-Canary', value: { literal: 'canary-header-value' } }],
          auth: { header_name: 'Authorization', secret_id: header.id },
          signing_secret_id: signing.id,
          body: { type: 'json', value: { template: `{"v": "{{ [${F(field)}] }}"}` } },
        },
        id,
      );
    const titleFlow = await automation({
      trigger: onOrderCreated,
      actions: [step('title', 'act_title')],
    });
    const costFlow = await automation({
      trigger: onOrderCreated,
      actions: [step('cost', 'act_cost')],
    });
    await createOrder({
      [F('title')]: 'canary-record-title',
      [F('cost')]: 13,
      [F('owner')]: [{ id: fx.users.u_sales1.id }],
    });
    const titleRun = await finishedRun(titleFlow.id);
    const costRun = await finishedRun(costFlow.id);
    expect([titleRun.status, costRun.status]).toEqual(['succeeded', 'succeeded']);
    await disable(titleFlow.id);
    await disable(costFlow.id);

    const detailOf = async (user: 'u_admin' | 'u_sales1', runId: Id<'run'>) => {
      const response = await fx.call(user, 'GET', `/automation-runs/${runId}`);
      expect(response.statusCode, response.body).toBe(200);
      // Secret values: nowhere in the answer.
      for (const canary of [AUTH_VALUE, signing.value as string]) {
        expect(response.body, `${user} ${canary}`).not.toContain(canary);
      }
      // The definition is the manager's own configuration; the steps never show the
      // URL or the request headers that went out.
      const detail = automationRunDetailSchema.parse(response.json());
      const steps = JSON.stringify(detail.steps);
      for (const canary of ['canary-url-token', '/canary', 'canary-header-value']) {
        expect(steps, `${user} ${canary}`).not.toContain(canary);
      }
      return detail.steps[0];
    };
    // The admin reads every field: the body is shown.
    expect(await detailOf('u_admin', costRun.id)).toMatchObject({
      redacted: false,
      output: { status: 200, body: { ok: true, id: 42, echo: 'canary-response-body' } },
      delivery: { target_host: 'hooks.test', status: 'succeeded', attempts: 1 },
    });
    // u_sales1 manages Orders and reads the record: the title flow's body, not the cost flow's.
    expect(await detailOf('u_sales1', titleRun.id)).toMatchObject({
      redacted: false,
      output: { status: 200, body: { ok: true, id: 42 } },
    });
    expect(await detailOf('u_sales1', costRun.id)).toMatchObject({
      redacted: true,
      output: { status: 200, body: null, headers: { 'content-type': 'application/json' } },
    });
    // Not a manager: 404.
    for (const user of ['u_editor', 'u_reader', 'stranger'] as const) {
      expect((await fx.call(user, 'GET', `/automation-runs/${costRun.id}`)).statusCode, user).toBe(
        404,
      );
    }

    // Secret values: never in logs, audit, events, job payloads or delivery rows.
    const secrets = [AUTH_VALUE, signing.value as string];
    for (const value of secrets) {
      expect(t.logs.raw()).not.toContain(value);
      expect(workerLogs.logs.raw()).not.toContain(value);
    }
    expect(workerLogs.logs.raw()).not.toContain('canary-url-token');
    expect(workerLogs.logs.raw()).not.toContain('canary-record-title');
    const { rows } = await sql<{ everything: string; rendered: string }>`
      SELECT (SELECT coalesce(string_agg(row_to_json(a)::text, ''), '') FROM meta.audit_logs a) ||
             (SELECT coalesce(string_agg(row_to_json(e)::text, ''), '') FROM meta.events e) AS everything,
             (SELECT coalesce(string_agg(row_to_json(d)::text, ''), '') FROM meta.http_deliveries d) ||
             (SELECT coalesce(string_agg(row_to_json(s)::text, ''), '') FROM meta.automation_run_steps s) ||
             (SELECT coalesce(string_agg(j.payload::text, ''), '') FROM graphile_worker._private_jobs j)
               AS rendered
    `.execute(db.kysely);
    const everything = rows[0]?.everything ?? '';
    const rendered = rows[0]?.rendered ?? '';
    expect(rendered.length).toBeGreaterThan(0);
    // Audit and events carry the definition (the manager's configuration), never a secret.
    for (const value of secrets) expect(everything).not.toContain(value);
    // What went out (URL, headers, record values) stays in the sealed request only.
    for (const value of [
      ...secrets,
      'canary-url-token',
      'canary-header-value',
      'canary-record-title',
    ]) {
      expect(rendered).not.toContain(value);
    }
    // Final deliveries keep no request at all.
    const { rows: open } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.http_deliveries
       WHERE status IN ('succeeded', 'failed', 'cancelled') AND request_enc IS NOT NULL
    `.execute(db.kysely);
    expect(open[0]?.n).toBe(0);
  });

  // --- S5c milestone ----------------------------------------------------------------------

  /** `settings.automation_max_depth` of the organization (SPEC §11.6). */
  async function setMaxDepth(depth: number): Promise<void> {
    const res = await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
      settings: { automation_max_depth: depth },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  it('milestone: A → http_request to the hook of B → B creates the record that would trigger A again: stopped by the depth limit', async () => {
    // Review fix: a hook is one hop, like a record write — with automation_max_depth = 2,
    // B (one hop from the person's change) still runs and A (two hops) is stopped.
    await setMaxDepth(2);
    const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
      name: 'Milestone hook',
      auth: 'none',
      rate_limit_per_sec: 100,
    });
    expect(created.statusCode, created.body).toBe(201);
    const hook: IncomingWebhookWithSecretsDto = incomingWebhookWithSecretsSchema.parse(
      created.json(),
    );
    const token = hook.url.split('/api/v1/hooks/')[1] as string;
    // Called through an internal name (like a Docker service), not PUBLIC_URL.
    const a = await automation({
      trigger: onOrderCreated,
      actions: [
        httpStep({
          url: { literal: `http://api.test:${String(apiPort)}/api/v1/hooks/${token}` },
          body: { type: 'json', value: { template: `{"title": "{{ [${F('title')}] }}"}` } },
        }),
      ],
    });
    const b = await automation({
      trigger: { type: 'webhook.received', incoming_webhook_id: hook.id },
      actions: [
        {
          id: 'act_create',
          type: 'create_record',
          config: {
            table_id: fx.orders.id,
            fields: { [F('title')]: { template: 'loop {{ [@body.title] }}' } },
          },
        },
      ],
    });
    await createOrder({ [F('title')]: 'milestone' });
    await eventually(
      async () => (await runsOf(b.id)).some((run) => run.status === 'succeeded'),
      'B ran',
    );
    await settled();
    // A ran once (for the person's record), B once; B's record did not run A again.
    expect((await runsOf(a.id)).map((run) => run.status)).toEqual(['succeeded']);
    expect((await runsOf(b.id)).map((run) => run.status)).toEqual(['succeeded']);
    const { rows: requests } = await sql<{ causation_accepted: boolean }>`
      SELECT causation_accepted FROM meta.incoming_webhook_requests
       WHERE incoming_webhook_id = ${hook.id}
    `.execute(db.kysely);
    expect(requests).toEqual([{ causation_accepted: true }]);
    // B's record carries the chain through the HTTP call (causation token accepted).
    const { rows: loop } = await sql<{ depth: number; chain: string[] }>`
      SELECT (causation->>'depth')::int AS depth,
             ARRAY(SELECT jsonb_array_elements_text(causation->'automation_chain')) AS chain
        FROM meta.events
       WHERE type = 'record.created' AND actor_type = 'automation' AND actor_id = ${b.id}
    `.execute(db.kysely);
    expect(loop).toHaveLength(1);
    // Person (0) → A → hook (1) → B → record (2): one level per hop.
    expect(loop[0]?.depth).toBe(2);
    expect(loop[0]?.chain).toEqual([a.id, b.id]);
    // The dispatcher stopped A on B's record with the loop guard.
    const stopped = workerLogs.logs.lines.some(
      (line) =>
        line['msg'] === 'event dispatched' &&
        Array.isArray(line['automations']) &&
        (line['automations'] as { automation_id: string; outcome: string }[]).some(
          (item) => item.automation_id === a.id && item.outcome.startsWith('loop_'),
        ),
    );
    expect(stopped).toBe(true);
    const outcome = workerLogs.logs.lines
      .flatMap((line) =>
        Array.isArray(line['automations'])
          ? (line['automations'] as { automation_id: string; outcome: string }[])
          : [],
      )
      .find((item) => item.automation_id === a.id && item.outcome.startsWith('loop_'));
    expect(outcome?.outcome).toBe('loop_max_depth');
    await disable(a.id);
    await disable(b.id);
    await setMaxDepth(DEFAULT_AUTOMATION_MAX_DEPTH);
  });

  it('T616: A → http_request to a fake n8n that forwards X-Cellhive-Causation to the hook of B → B writes the record that would trigger A: stopped at loop_max_depth', async () => {
    await setMaxDepth(2);
    const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
      name: 'Forwarded hook',
      auth: 'none',
      rate_limit_per_sec: 100,
    });
    expect(created.statusCode, created.body).toBe(201);
    const hook = incomingWebhookWithSecretsSchema.parse(created.json());
    const token = hook.url.split('/api/v1/hooks/')[1] as string;
    // The fake n8n: calls hook B back on another Host (loopback, not PUBLIC_URL), forwarding
    // only the causation header, then answers A's call. One forward: a second call by A —
    // the loop guard failing — would get the default reply and show as a second run of A.
    const forwarded: { header: unknown; status: number }[] = [];
    target.responders.push((req, res) => {
      const header = req.headers['x-cellhive-causation'];
      void fetch(`http://127.0.0.1:${String(apiPort)}/api/v1/hooks/${token}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(typeof header === 'string' ? { 'x-cellhive-causation': header } : {}),
        },
        body: JSON.stringify({ title: 'via n8n' }),
      }).then(
        (response) => {
          forwarded.push({ header, status: response.status });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        },
        () => {
          res.writeHead(502);
          res.end();
        },
      );
    });
    const a = await automation({
      trigger: onOrderCreated,
      actions: [
        httpStep({
          url: { literal: hooksUrl('/webhook/forward') },
          body: { type: 'json', value: { template: `{"title": "{{ [${F('title')}] }}"}` } },
        }),
      ],
    });
    const b = await automation({
      trigger: { type: 'webhook.received', incoming_webhook_id: hook.id },
      actions: [
        {
          id: 'act_create',
          type: 'create_record',
          config: {
            table_id: fx.orders.id,
            fields: { [F('title')]: { template: 'forwarded {{ [@body.title] }}' } },
          },
        },
      ],
    });
    await createOrder({ [F('title')]: 'forward' });
    await eventually(
      async () => (await runsOf(b.id)).some((run) => run.status === 'succeeded'),
      'B ran',
    );
    await settled();
    // The fake n8n received a token and forwarded it; the hook took it.
    expect(forwarded).toHaveLength(1);
    expect(typeof forwarded[0]?.header).toBe('string');
    expect(forwarded[0]?.status).toBe(202);
    const { rows: requests } = await sql<{ causation_accepted: boolean }>`
      SELECT causation_accepted FROM meta.incoming_webhook_requests
       WHERE incoming_webhook_id = ${hook.id}
    `.execute(db.kysely);
    expect(requests).toEqual([{ causation_accepted: true }]);
    // A ran once (for the person's record), B once; B's record did not run A again.
    expect((await runsOf(a.id)).map((run) => run.status)).toEqual(['succeeded']);
    expect((await runsOf(b.id)).map((run) => run.status)).toEqual(['succeeded']);
    const { rows: loop } = await sql<{ depth: number; chain: string[] }>`
      SELECT (causation->>'depth')::int AS depth,
             ARRAY(SELECT jsonb_array_elements_text(causation->'automation_chain')) AS chain
        FROM meta.events
       WHERE type = 'record.created' AND actor_type = 'automation' AND actor_id = ${b.id}
    `.execute(db.kysely);
    expect(loop).toHaveLength(1);
    // Person (0) → A → hook (1) → B → record (2): one level per hop.
    expect(loop[0]?.depth).toBe(2);
    expect(loop[0]?.chain).toEqual([a.id, b.id]);
    const outcome = workerLogs.logs.lines
      .flatMap((line) =>
        Array.isArray(line['automations'])
          ? (line['automations'] as { automation_id: string; outcome: string }[])
          : [],
      )
      .find((item) => item.automation_id === a.id && item.outcome.startsWith('loop_'));
    expect(outcome?.outcome).toBe('loop_max_depth');
    await disable(a.id);
    await disable(b.id);
    await setMaxDepth(DEFAULT_AUTOMATION_MAX_DEPTH);
  });
});
