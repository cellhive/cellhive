import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import {
  automationSchema,
  newId,
  roleListSchema,
  secretSchema,
  secretWithValueSchema,
  type AutomationDto,
  type Id,
  type SecretWithValueDto,
} from '@cellhive/contracts';
import { secretHostBlockedCounts, type Db } from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { AddressInfo, Socket } from 'node:net';

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A loopback destination counting every TCP connection and request it gets. */
interface FakeServer {
  readonly port: number;
  connections: number;
  readonly received: { url: string; headers: IncomingMessage['headers'] }[];
  close(): Promise<void>;
}

async function startServer(): Promise<FakeServer> {
  const sockets = new Set<Socket>();
  const fake: FakeServer = {
    port: 0,
    connections: 0,
    received: [],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      fake.received.push({ url: req.url ?? '', headers: req.headers });
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  server.on('connection', (socket) => {
    fake.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  (fake as { port: number }).port = (server.address() as AddressInfo).port;
  return fake;
}

const AUTH_CANARY = 'Bearer canary-t701-secret-header-value';
const SIGNING_CANARY = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const LEGACY_CANARY = 'Bearer canary-t701-legacy-header-value';
const DAY_MS = 24 * 3600_000;
const P = 'definition.actions[0].config';

type CallResponse = Awaited<ReturnType<RecordFixture['call']>>;

/**
 * BACKLOG T701, P64 (ADR-36 §4; CONTRACTS §21, §24, §25.5) through the real
 * API and a real worker: HTTP secrets carry the hosts they may be sent to —
 * required when created, checked when an automation (or a test send) is
 * saved with a literal URL (`SECRET_HOST_NOT_ALLOWED`) and when the request
 * is sent, before the secret is unsealed and before any connection
 * (`secret_host_not_allowed`): the fake "attacker" server never gets a
 * connection and the secret values never reach logs, audit or delivery
 * rows. Secrets stored before the list existed keep working until
 * `legacy_hosts_until` (clock injected into the worker), then fail
 * `legacy_expired`.
 */
describe('secret allowed hosts (T701, P64)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let crm: FakeServer;
  let attacker: FakeServer;
  /** Added to the worker's clock (the transition period of legacy secrets). */
  let clockOffsetMs = 0;
  const workerLogs = captureLogger();

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const crmHost = () => `api.crm.test:${String(crm.port)}`;
  const crmUrl = (path = '/orders') => `http://${crmHost()}${path}`;
  const attackerUrl = (path = '/steal') => `http://attacker.test:${String(attacker.port)}${path}`;

  async function secret(body: Record<string, unknown>): Promise<SecretWithValueDto> {
    const response = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      name: `Secret ${newId('sec').slice(4, 12)}`,
      ...body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return secretWithValueSchema.parse(response.json());
  }

  const save = (definition: object, enabled = true, user: 'u_admin' | 'u_sales1' = 'u_admin') =>
    fx.call(user, 'POST', `/bases/${fx.baseId}/automations`, {
      name: `Hosts ${newId('aut').slice(4, 12)}`,
      enabled,
      definition,
    });

  async function automation(definition: object, enabled = true): Promise<AutomationDto> {
    const response = await save(definition, enabled);
    expect(response.statusCode, response.body).toBe(201);
    return automationSchema.parse(response.json());
  }

  async function disable(id: Id<'aut'>): Promise<void> {
    const response = await fx.call('u_admin', 'POST', `/automations/${id}/disable`);
    expect(response.statusCode, response.body).toBe(200);
  }

  async function createOrder(title: string): Promise<Id<'rec'>> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ fields: { [F('title')]: title } }] },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  interface RunRow {
    readonly status: string;
    readonly error: Record<string, unknown> | null;
  }

  async function finishedRun(id: Id<'aut'>): Promise<RunRow> {
    return eventually(async () => {
      const { rows } = await sql<RunRow>`
        SELECT status, error FROM meta.automation_runs
         WHERE automation_id = ${id} AND status IN ('succeeded', 'failed', 'skipped')
      `.execute(db.kysely);
      return rows[0];
    }, `run of ${id}`);
  }

  const onOrderCreated = () => ({ type: 'record.created', table_id: fx.orders.id });
  const httpStep = (config: Record<string, unknown>) => ({
    id: 'act_http',
    type: 'http_request',
    config: { method: 'POST', url: { literal: crmUrl() }, ...config },
  });
  /** The URL comes from the record (its title): only checked when sent. */
  const fromField = { field: '' };

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    fromField.field = F('title');
    // The `manage` variant of P64: Sales manages Orders, so u_sales1 builds automations.
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
    crm = await startServer();
    attacker = await startServer();
    // Both destinations pass the SSRF guard (allowlisted with their ports): only the
    // allowed hosts of the secret keep the attacker out.
    for (const pattern of [crmHost(), `attacker.test:${String(attacker.port)}`]) {
      const response = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
        pattern,
      });
      expect(response.statusCode, response.body).toBe(201);
    }
    worker = await createWorker(t.config, {
      logger: workerLogs.logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db: t.app.get<Db>(DB),
        logger: workerLogs.logger,
        httpDelivery: {
          lookup: () => Promise.resolve(['127.0.0.1']),
          now: () => new Date(Date.now() + clockOffsetMs),
        },
      }),
    });
  });

  afterAll(async () => {
    await worker.close();
    await crm.close();
    await attacker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  // --- Secrets API ---------------------------------------------------------------------------

  it('requires allowed_hosts on HTTP secrets, canonicalises them, audits the list without the value', async () => {
    const create = (body: Record<string, unknown>) =>
      fx.call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, { name: 'Nope', ...body });
    const codes = (response: CallResponse) =>
      response
        .json<{ errors: { path: string; code: string }[] }>()
        .errors.map(({ path, code }) => ({
          path,
          code,
        }));
    const missing = await create({ kind: 'http_header', value: AUTH_CANARY });
    expectProblem(missing, 422, 'VALIDATION_FAILED');
    expect(codes(missing)).toEqual([{ path: 'allowed_hosts', code: 'SECRET_HOSTS_REQUIRED' }]);
    const empty = await create({ kind: 'webhook_signing', generate: true, allowed_hosts: [] });
    expect(codes(empty)).toEqual([{ path: 'allowed_hosts', code: 'SECRET_HOSTS_REQUIRED' }]);
    const tooMany = await create({
      kind: 'http_header',
      value: AUTH_CANARY,
      allowed_hosts: Array.from({ length: 21 }, (_, i) => `h${String(i)}.test`),
    });
    expect(codes(tooMany)).toEqual([{ path: 'allowed_hosts', code: 'TOO_MANY_ALLOWED_HOSTS' }]);
    const ip = await create({
      kind: 'http_header',
      value: AUTH_CANARY,
      allowed_hosts: ['api.crm.test', '127.0.0.1', '10.0.0.0/8', '*.test'],
    });
    expect(codes(ip)).toEqual([
      { path: 'allowed_hosts[1]', code: 'INVALID_ALLOWLIST_PATTERN' },
      { path: 'allowed_hosts[2]', code: 'INVALID_ALLOWLIST_PATTERN' },
      { path: 'allowed_hosts[3]', code: 'INVALID_ALLOWLIST_PATTERN' },
    ]);
    const bot = await create({
      kind: 'telegram_bot',
      value: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0',
      allowed_hosts: ['api.telegram.org'],
    });
    expect(codes(bot)).toEqual([{ path: 'allowed_hosts', code: 'UNRECOGNIZED_KEY' }]);
    for (const response of [missing, empty, tooMany, ip, bot]) {
      expect(response.body).not.toContain(AUTH_CANARY);
    }

    const header = await secret({
      kind: 'http_header',
      value: AUTH_CANARY,
      allowed_hosts: ['API.CRM.test.', '*.Bücher.example:8443', 'api.crm.test'],
    });
    expect(header).toMatchObject({
      allowed_hosts: ['api.crm.test', '*.xn--bcher-kva.example:8443'],
      legacy_hosts_until: null,
    });
    const telegram = await secret({
      kind: 'telegram_bot',
      value: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0',
    });
    expect(telegram).toMatchObject({ allowed_hosts: [], legacy_hosts_until: null });
    expectProblem(
      await fx.call('owner', 'PATCH', `/secrets/${telegram.id}`, { allowed_hosts: ['a.test'] }),
      422,
      'VALIDATION_FAILED',
    );

    const patched = await fx.call('owner', 'PATCH', `/secrets/${header.id}`, {
      allowed_hosts: ['api.crm.test', 'hooks.crm.test:8443'],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(secretSchema.parse(patched.json()).allowed_hosts).toEqual([
      'api.crm.test',
      'hooks.crm.test:8443',
    ]);
    const listed = await fx.call('owner', 'GET', `/orgs/${fx.orgId}/secrets`);
    expect(listed.body).toContain('hooks.crm.test:8443');
    expect(listed.body).not.toContain(AUTH_CANARY);

    const { rows } = await sql<{ action: string; before: unknown; after: unknown }>`
      SELECT action, before, after FROM meta.audit_logs
       WHERE entity_id = ${header.id} ORDER BY created_at, id
    `.execute(db.kysely);
    expect(rows.map((row) => row.action)).toEqual(['secret.created', 'secret.updated']);
    expect(rows[0]?.after).toMatchObject({
      allowed_hosts: ['api.crm.test', '*.xn--bcher-kva.example:8443'],
    });
    expect(rows[1]).toMatchObject({
      before: { allowed_hosts: ['api.crm.test', '*.xn--bcher-kva.example:8443'] },
      after: { allowed_hosts: ['api.crm.test', 'hooks.crm.test:8443'] },
    });
    expect(JSON.stringify(rows)).not.toContain(AUTH_CANARY);

    // Tenant: an owner of another organization neither sees nor changes it.
    expectProblem(
      await fx.call('stranger', 'PATCH', `/secrets/${header.id}`, { allowed_hosts: ['evil.test'] }),
      404,
      'NOT_FOUND',
    );
    // Not an owner/admin of the organization: 403 like every secret route.
    expectProblem(
      await fx.call('u_admin', 'PATCH', `/secrets/${header.id}`, { allowed_hosts: ['evil.test'] }),
      403,
      'PERMISSION_DENIED',
    );
    const after = await fx.call('owner', 'GET', `/orgs/${fx.orgId}/secrets`);
    expect(after.body).not.toContain('evil.test');
  });

  // --- Save-time check ---------------------------------------------------------------------

  it('refuses to save a literal URL of another host: http_request auth and signing, run_n8n_workflow, test send', async () => {
    const auth = await secret({
      kind: 'http_header',
      value: AUTH_CANARY,
      allowed_hosts: ['api.crm.test'],
    });
    const signing = await secret({
      kind: 'webhook_signing',
      value: SIGNING_CANARY,
      allowed_hosts: ['*.crm.test'],
    });
    const codes = (response: CallResponse) =>
      response
        .json<{ errors: { path: string; code: string; params?: unknown }[] }>()
        .errors.map(({ path, code, params }) => ({ path, code, params }));

    const stolen = await save({
      trigger: onOrderCreated(),
      actions: [
        httpStep({
          url: { literal: 'https://attacker.test/' },
          auth: { header_name: 'Authorization', secret_id: auth.id },
          signing_secret_id: signing.id,
        }),
      ],
    });
    expectProblem(stolen, 422, 'AUTOMATION_INVALID');
    expect(codes(stolen)).toEqual([
      {
        path: `${P}.auth.secret_id`,
        code: 'SECRET_HOST_NOT_ALLOWED',
        params: { kind: 'http_header', reason: 'not_listed' },
      },
      {
        path: `${P}.signing_secret_id`,
        code: 'SECRET_HOST_NOT_ALLOWED',
        params: { kind: 'webhook_signing', reason: 'not_listed' },
      },
    ]);
    // P64, `manage` variant: u_sales1 gets the same answer.
    const bySales = await save(
      {
        trigger: onOrderCreated(),
        actions: [
          httpStep({
            url: { literal: 'https://attacker.test/' },
            auth: { header_name: 'Authorization', secret_id: auth.id },
          }),
        ],
      },
      true,
      'u_sales1',
    );
    expectProblem(bySales, 422, 'AUTOMATION_INVALID');
    expect(codes(bySales)).toEqual([
      {
        path: `${P}.auth.secret_id`,
        code: 'SECRET_HOST_NOT_ALLOWED',
        params: { kind: 'http_header', reason: 'not_listed' },
      },
    ]);
    // Look-alikes of the allowed hosts are other hosts.
    for (const url of [
      'https://api.crm.test.attacker.test/',
      'https://evilcrm.test/',
      'https://api.crm.test:8443/',
    ]) {
      const response = await save({
        trigger: onOrderCreated(),
        actions: [
          httpStep({
            url: { literal: url },
            auth: { header_name: 'Authorization', secret_id: auth.id },
          }),
        ],
      });
      expect(response.statusCode, url).toBe(422);
      expect(response.body, url).toContain('SECRET_HOST_NOT_ALLOWED');
    }
    // `*.crm.test` matches a subdomain, never `crm.test` itself.
    const root = await save({
      trigger: onOrderCreated(),
      actions: [httpStep({ url: { literal: 'https://crm.test/' }, signing_secret_id: signing.id })],
    });
    expect(codes(root)).toEqual([
      {
        path: `${P}.signing_secret_id`,
        code: 'SECRET_HOST_NOT_ALLOWED',
        params: { kind: 'webhook_signing', reason: 'not_listed' },
      },
    ]);
    // `run_n8n_workflow` signs with the same rule.
    const n8n = await save({
      trigger: onOrderCreated(),
      actions: [
        {
          id: 'act_n8n',
          type: 'run_n8n_workflow',
          config: { url: { literal: 'https://attacker.test/hook' }, signing_secret_id: signing.id },
        },
      ],
    });
    expect(codes(n8n)).toEqual([
      {
        path: `${P}.signing_secret_id`,
        code: 'SECRET_HOST_NOT_ALLOWED',
        params: { kind: 'webhook_signing', reason: 'not_listed' },
      },
    ]);
    // Allowed: the exact host (case and trailing dot normalised), a subdomain for `*.`.
    const ok = await automation(
      {
        trigger: onOrderCreated(),
        actions: [
          httpStep({
            url: { literal: 'https://API.crm.test./orders' },
            auth: { header_name: 'Authorization', secret_id: auth.id },
            signing_secret_id: signing.id,
          }),
        ],
      },
      false,
    );
    // A test send with a draft pointing elsewhere is refused before anything is queued.
    const before = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.http_deliveries
    `.execute(db.kysely);
    const test = await fx.call(
      'u_admin',
      'POST',
      `/automations/${ok.id}/actions/act_http/http-test`,
      {
        record_id: null,
        draft: {
          method: 'POST',
          url: { literal: attackerUrl() },
          auth: { header_name: 'Authorization', secret_id: auth.id },
        },
      },
    );
    expectProblem(test, 422, 'AUTOMATION_INVALID');
    expect(test.body).toContain('SECRET_HOST_NOT_ALLOWED');
    const after = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.http_deliveries
    `.execute(db.kysely);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    // A URL from a field cannot be checked when saved: it is checked when sent (below).
    await automation(
      {
        trigger: onOrderCreated(),
        actions: [
          httpStep({ url: fromField, auth: { header_name: 'Authorization', secret_id: auth.id } }),
        ],
      },
      false,
    );
    expect(attacker.connections).toBe(0);
  });

  // --- Send-time check (real worker) ---------------------------------------------------------

  it('fails secret_host_not_allowed when a field value points elsewhere: 0 connections to the attacker, no canary anywhere', async () => {
    const auth = await secret({
      kind: 'http_header',
      value: AUTH_CANARY,
      allowed_hosts: [crmHost()],
    });
    const signing = await secret({
      kind: 'webhook_signing',
      value: SIGNING_CANARY,
      allowed_hosts: [crmHost()],
    });
    const blockedBefore = secretHostBlockedCounts().get('not_listed') ?? 0;

    // Allowed host from the field: delivered with the header and a signature.
    const good = await automation({
      trigger: onOrderCreated(),
      actions: [
        httpStep({
          url: fromField,
          auth: { header_name: 'Authorization', secret_id: auth.id },
          signing_secret_id: signing.id,
        }),
      ],
    });
    const received = crm.received.length;
    await createOrder(crmUrl('/orders/1'));
    expect(await finishedRun(good.id)).toMatchObject({ status: 'succeeded' });
    expect(crm.received.length).toBe(received + 1);
    const delivered = crm.received.find((item) => item.url === '/orders/1');
    expect(delivered?.headers['authorization']).toBe(AUTH_CANARY);
    expect(delivered?.headers['webhook-signature']).toMatch(/^v1,/u);
    await disable(good.id);

    // The same steps, the field pointing at the attacker: auth, then signing alone.
    const cases: [string, Record<string, unknown>, Id<'sec'>][] = [
      ['auth', { auth: { header_name: 'Authorization', secret_id: auth.id } }, auth.id],
      ['signing', { signing_secret_id: signing.id }, signing.id],
    ];
    for (const [purpose, config, secretId] of cases) {
      const flow = await automation({
        trigger: onOrderCreated(),
        actions: [httpStep({ url: fromField, ...config })],
      });
      await createOrder(attackerUrl(`/steal-${purpose}`));
      expect(await finishedRun(flow.id), purpose).toMatchObject({
        status: 'failed',
        error: {
          code: 'secret_host_not_allowed',
          params: { purpose, secret_id: secretId, reason: 'not_listed' },
        },
      });
      await disable(flow.id);
    }
    // Permanent: one attempt each, never retried; the request is gone.
    const { rows: deliveries } = await sql<{ status: string; attempts: number; enc: boolean }>`
      SELECT status, attempts, request_enc IS NOT NULL AS enc FROM meta.http_deliveries
       WHERE last_error ->> 'code' = 'secret_host_not_allowed'
    `.execute(db.kysely);
    expect(deliveries).toEqual([
      { status: 'failed', attempts: 1, enc: false },
      { status: 'failed', attempts: 1, enc: false },
    ]);
    expect(attacker.connections).toBe(0);
    expect(attacker.received).toEqual([]);
    expect(secretHostBlockedCounts().get('not_listed')).toBe(blockedBefore + 2);

    // Canary: the secret values never reach logs, audit, events, runs, deliveries or jobs.
    for (const value of [AUTH_CANARY, SIGNING_CANARY]) {
      expect(t.logs.raw()).not.toContain(value);
      expect(workerLogs.logs.raw()).not.toContain(value);
    }
    const { rows } = await sql<{ everything: string }>`
      SELECT (SELECT coalesce(string_agg(row_to_json(a)::text, ''), '') FROM meta.audit_logs a) ||
             (SELECT coalesce(string_agg(row_to_json(e)::text, ''), '') FROM meta.events e) ||
             (SELECT coalesce(string_agg(row_to_json(r)::text, ''), '') FROM meta.automation_runs r) ||
             (SELECT coalesce(string_agg(row_to_json(s)::text, ''), '') FROM meta.automation_run_steps s) ||
             (SELECT coalesce(string_agg(row_to_json(d)::text, ''), '') FROM meta.http_deliveries d) ||
             (SELECT coalesce(string_agg(j.payload::text, ''), '') FROM graphile_worker._private_jobs j)
               AS everything
    `.execute(db.kysely);
    const everything = rows[0]?.everything ?? '';
    expect(everything).toContain('secret_host_not_allowed');
    for (const value of [AUTH_CANARY, SIGNING_CANARY, 'canary-t701']) {
      expect(everything).not.toContain(value);
    }
  });

  // --- Secrets stored before the list existed ------------------------------------------------

  it('a legacy secret (no list) is sent until legacy_hosts_until, then fails legacy_expired; setting a list ends it', async () => {
    const legacy = await secret({
      kind: 'http_header',
      value: LEGACY_CANARY,
      allowed_hosts: ['placeholder.test'],
    });
    // As migration 0051 leaves an existing secret: no list, 30 days to set one.
    await sql`
      UPDATE meta.secrets
         SET allowed_hosts = '{}', legacy_hosts_until = now() + interval '30 days'
       WHERE id = ${legacy.id}
    `.execute(db.kysely);
    const listed = secretSchema.parse(
      (await fx.call('owner', 'GET', `/orgs/${fx.orgId}/secrets`))
        .json<{ items: unknown[] }>()
        .items.find((item) => (item as { id: string }).id === legacy.id),
    );
    expect(listed.allowed_hosts).toEqual([]);
    const until = Date.parse(listed.legacy_hosts_until ?? '');
    expect(Math.abs(until - (Date.now() + 30 * DAY_MS))).toBeLessThan(60_000);

    const step = httpStep({
      url: fromField,
      auth: { header_name: 'Authorization', secret_id: legacy.id },
    });
    // Before the deadline: sent (to any host — here the CRM server).
    const before = await automation({ trigger: onOrderCreated(), actions: [step] });
    await createOrder(crmUrl('/legacy'));
    expect(await finishedRun(before.id)).toMatchObject({ status: 'succeeded' });
    expect(crm.received.find((item) => item.url === '/legacy')?.headers['authorization']).toBe(
      LEGACY_CANARY,
    );
    await disable(before.id);

    // 31 days later on the worker's clock: refused, before any connection.
    clockOffsetMs = 31 * DAY_MS;
    try {
      const expired = await automation({ trigger: onOrderCreated(), actions: [step] });
      const connections = crm.connections;
      await createOrder(crmUrl('/legacy-expired'));
      expect(await finishedRun(expired.id)).toMatchObject({
        status: 'failed',
        error: {
          code: 'secret_host_not_allowed',
          params: { purpose: 'auth', secret_id: legacy.id, reason: 'legacy_expired' },
        },
      });
      expect(crm.connections).toBe(connections);
      await disable(expired.id);
    } finally {
      clockOffsetMs = 0;
    }

    // Setting a list clears the deadline.
    const patched = await fx.call('owner', 'PATCH', `/secrets/${legacy.id}`, {
      allowed_hosts: ['api.crm.test'],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(secretSchema.parse(patched.json())).toMatchObject({
      allowed_hosts: ['api.crm.test'],
      legacy_hosts_until: null,
    });
    expect(attacker.connections).toBe(0);
    expect(workerLogs.logs.raw()).not.toContain(LEGACY_CANARY);
  });
});
