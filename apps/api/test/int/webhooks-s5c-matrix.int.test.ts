import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  automationRunDetailSchema,
  automationSchema,
  incomingWebhookListSchema,
  incomingWebhookRequestListSchema,
  incomingWebhookSampleResponseSchema,
  incomingWebhookWithSecretsSchema,
  n8nWorkflowPayloadSchema,
  newId,
  notificationListSchema,
  roleListSchema,
  secretSchema,
  secretWithValueSchema,
  telegramLinkSchema,
  type AutomationDto,
  type Id,
  type IncomingWebhookWithSecretsDto,
  type NotificationDto,
  type RealtimeServerMessage,
  type RoleDto,
  type SecretWithValueDto,
} from '@cellhive/contracts';
import { signWebhook, verifyWebhook, type Db } from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IncomingWebhookRateLimits } from '../../src/common/rate-limit/incoming-webhook-rate-limits.js';
import { DB } from '../../src/common/tokens.js';

import { startSmtpCapture, type SmtpCapture } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import {
  captureLogger,
  problemOf,
  startTestApp,
  TEST_PUBLIC_URL,
  type TestApp,
} from './support.js';
import { startFakeTelegramBot, type FakeTelegramBot } from './telegram-bot-support.js';

import type { LightMyRequestResponse } from 'fastify';
import type { AddressInfo, Socket } from 'node:net';

const BOT_TOKEN = '615615001:AAHdqTcvCH1vGWJxfSeofSAs0K5PALmatrix';
const BOT_USERNAME = 'acme_s5c_matrix_bot';
const SALES1_CHAT = 615_000_001;
/** P52: requests over this many milliseconds (200 in 50 s, BACKLOG T608/T615). */
const P52_REQUESTS = 200;
const P52_SPAN_MS = 50_000;
/** P52: records of u_sales1 among them (the rest are u_sales2's: never readable by u_sales1). */
const P52_READABLE = 150;

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

/** The decoded `text/plain` part of a raw `multipart/alternative` message. */
function plainText(raw: string): string {
  const boundary = /boundary="?([^";\r\n]+)"?/u.exec(raw)?.[1] ?? '';
  for (const part of raw.split(`--${boundary}`)) {
    const split = part.search(/\r?\n\r?\n/u);
    if (split < 0 || !/content-type:\s*text\/plain/iu.test(part.slice(0, split))) continue;
    const head = part.slice(0, split);
    const body = part.slice(split).trim();
    if (/content-transfer-encoding:\s*base64/iu.test(head)) {
      return Buffer.from(body.replace(/\s+/gu, ''), 'base64').toString('utf8');
    }
    if (/content-transfer-encoding:\s*quoted-printable/iu.test(head)) {
      const bytes: number[] = [];
      const value = body.replace(/=\r?\n/gu, '');
      for (let i = 0; i < value.length; i += 1) {
        const hex = value.slice(i + 1, i + 3);
        if (value[i] === '=' && /^[0-9A-F]{2}$/iu.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
        } else {
          bytes.push(value.charCodeAt(i));
        }
      }
      return Buffer.from(bytes).toString('utf8');
    }
    return body;
  }
  return '';
}

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

/** An HTTP destination on loopback: requests recorded, connections counted, queued responders. */
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
      res.end(JSON.stringify({ ok: true, echo: 'canary-response-body' }));
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

function tokenOf(hook: Pick<IncomingWebhookWithSecretsDto, 'url'>): string {
  const token = hook.url.split('/api/v1/hooks/')[1];
  if (token === undefined) throw new Error(`unexpected url ${hook.url}`);
  return token;
}

/**
 * The S5c rows of the CONTRACTS §5 permission matrix (P44–P52, BACKLOG
 * T615, "Phụ lục ma trận quyền S5c") over HTTP with the real worker
 * (graphile-worker: `events.dispatch`, `automation.run`, `http.deliver`,
 * `notifications.*`), fake HTTP destinations and a fake Telegram Bot API.
 *
 * Fixture of CONTRACTS §5 plus the S5c additions: the hook `hk_orders` on
 * base B (made by u_admin, `auth = both`, `rate_limit_per_sec = 5`) and the
 * automation `aut_hook` (`webhook.received` of `hk_orders` → `update_record`
 * Orders, `run_as` = u_admin); on Orders `reviewers` (`user`,
 * `notify_on_assign`) for P52 and the `customer` link for P47. The Sales
 * variant `Orders.perm = manage` (with `customer` readable) is switched on
 * for P44/P47 only, like P29/P32. Destinations: a "public" one — a name the
 * worker's injected resolver sends to a loopback server, allowlisted by
 * host and port as an organization would its n8n — and a trap on loopback
 * that must never receive a connection.
 *
 * Where each row also runs in its own task: P44 `incoming-webhooks`,
 * `automation-webhook-trigger`; P45/P46 `hook-receive`; P47
 * `automation-http-request`, `automation-run-n8n-workflow`; P48
 * `automation-http-request` (and `resolve-target` for `10.0.0.5` through an
 * allowlisted name); P49 `http-allowlist`; P50 `http-outbox`,
 * `automation-http-request`; P51 `telegram-webhook`; P52
 * `webhook-notifications` (26 requests) and the service-level
 * `webhook-grouping` (202 writes).
 */
describe('S5c permission matrix over HTTP: P44–P52 (T615)', () => {
  let database: TestDatabase;
  let db: Db;
  let smtp: SmtpCapture;
  let telegram: FakeTelegramBot;
  let t: TestApp;
  let wsUrl: string;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let target: FakeTarget;
  let trap: FakeTarget;
  let hkOrders: IncomingWebhookWithSecretsDto;
  let autHook: AutomationDto;
  let reviewers: Id<'fld'>;
  let customerField: Id<'fld'>;
  let customer: Id<'rec'>;
  let sales: RoleDto;
  let signing: SecretWithValueDto;
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;
  const sockets: TestSocket[] = [];
  const workerLogs = captureLogger();

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const U = (user: FixtureUser) => fx.users[user].id;
  const org = (path = '') => `/orgs/${fx.orgId}${path}`;
  const publicUrl = (path = '/hook') => `http://public.test:${String(target.port)}${path}`;

  /** Names the worker resolves: SSRF probes to their addresses, everything else to loopback. */
  const lookup = (host: string): Promise<readonly string[]> => {
    if (host === 'rebind.test') return Promise.resolve(['10.0.0.7']);
    if (host === 'metadata.test') return Promise.resolve(['169.254.169.254']);
    return Promise.resolve(['127.0.0.1']);
  };

  // --- Helpers --------------------------------------------------------------------------

  interface PostOptions {
    readonly body?: unknown;
    readonly bearer?: string | null;
    /** Signing secrets (`[]`: no signature headers); default the hook's own. */
    readonly secrets?: readonly string[];
    readonly id?: string;
    readonly at?: Date;
    readonly headers?: Record<string, string>;
  }

  /** `POST /api/v1/hooks/:token` as an anonymous sender, signed and with the Bearer of `hkOrders`. */
  function post(token: string, options: PostOptions = {}): Promise<LightMyRequestResponse> {
    const raw = JSON.stringify(options.body ?? {});
    const secrets = options.secrets ?? [hkOrders.signing_secret ?? ''];
    const id = options.id ?? newId('evt');
    const timestamp = Math.floor((options.at ?? new Date()).getTime() / 1000);
    const bearer = options.bearer === undefined ? hkOrders.bearer_token : options.bearer;
    return t.app.inject({
      method: 'POST',
      url: `/api/v1/hooks/${token}`,
      payload: raw,
      headers: {
        'content-type': 'application/json',
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...(secrets.length === 0
          ? {}
          : {
              'webhook-id': id,
              'webhook-timestamp': String(timestamp),
              'webhook-signature': signWebhook({ id, timestamp, body: raw }, secrets),
            }),
        ...options.headers,
      },
      remoteAddress: '198.51.100.44',
    });
  }

  async function createHook(
    body: Record<string, unknown>,
    as: FixtureUser = 'u_admin',
    baseId: Id<'bse'> = fx.baseId,
  ): Promise<IncomingWebhookWithSecretsDto> {
    const response = await fx.call(as, 'POST', `/bases/${baseId}/incoming-webhooks`, {
      name: `Hook ${newId('hok').slice(4, 12)}`,
      ...body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return incomingWebhookWithSecretsSchema.parse(response.json());
  }

  async function automation(
    definition: object,
    user: 'u_admin' | 'u_sales1' = 'u_admin',
    enabled = true,
  ): Promise<AutomationDto> {
    const response = await fx.call(user, 'POST', `/bases/${fx.baseId}/automations`, {
      name: `S5c ${newId('aut').slice(4, 12)}`,
      enabled,
      definition,
    });
    expect(response.statusCode, response.body).toBe(201);
    return automationSchema.parse(response.json());
  }

  async function disable(id: Id<'aut'>): Promise<void> {
    const response = await fx.call('u_admin', 'POST', `/automations/${id}/disable`);
    expect(response.statusCode, response.body).toBe(200);
  }

  async function allow(pattern: string): Promise<Id<'hal'>> {
    const response = await fx.call('owner', 'POST', org('/http-allowlist'), { pattern });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: Id<'hal'> }>().id;
  }

  async function createOrders(
    rows: readonly Record<string, unknown>[],
    user: FixtureUser = 'u_admin',
  ): Promise<Id<'rec'>[]> {
    const response = await fx.call(
      user,
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: rows.map((fields) => ({ fields })) },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records.map((record) => record.id);
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

  async function finishedRun(id: Id<'aut'>): Promise<RunRow> {
    return eventually(async () => {
      const done = (await runsOf(id)).filter((row) =>
        ['succeeded', 'failed', 'skipped'].includes(row.status),
      );
      return done[0];
    }, `run of ${id}`);
  }

  /** Every event dispatched; every run, delivery, fan-out and due flush finished. */
  async function settled(timeoutMs = 120_000): Promise<void> {
    await eventually(
      async () => {
        const { rows } = await sql<{ n: number }>`
          SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL)
               + (SELECT count(*)::int FROM meta.automation_runs
                   WHERE status IN ('queued', 'running', 'waiting'))
               + (SELECT count(*)::int FROM meta.http_deliveries
                   WHERE status IN ('pending', 'sending'))
               + (SELECT count(*)::int FROM meta.notification_deliveries WHERE status = 'pending')
               + (SELECT count(*)::int FROM graphile_worker._private_jobs p
                    JOIN graphile_worker._private_tasks k ON k.id = p.task_id
                   WHERE k.identifier IN ('events.dispatch', 'automation.run',
                                          'notifications.fanout', 'notifications.deliver')
                      OR (k.identifier = 'notifications.flush'
                          AND p.run_at <= now() + interval '5 seconds')) AS n
        `.execute(db.kysely);
        return rows[0]?.n === 0;
      },
      'events, runs, deliveries and notifications to settle',
      timeoutMs,
    );
  }

  /** The Sales role of CONTRACTS §5 as stored, or its P29/P32 variant (`Orders.perm = manage`). */
  async function salesOrders(perm: 'edit' | 'manage'): Promise<void> {
    const tables = sales.config.tables as Record<string, Record<string, unknown>>;
    const orders = tables[fx.orders.id] as Record<string, unknown>;
    const fieldRule = orders['field_rule'] as Record<string, unknown>;
    const response = await fx.call('u_admin', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
      config: {
        ...sales.config,
        tables: {
          ...tables,
          [fx.orders.id]: {
            ...orders,
            perm,
            field_rule: {
              ...fieldRule,
              fields: {
                ...(fieldRule['fields'] as Record<string, string>),
                // The link is readable: P47 checks its title comes as `null` (P20).
                [customerField]: 'read',
              },
            },
          },
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function inAppOf(user: FixtureUser): Promise<NotificationDto[]> {
    const response = await fx.call(user, 'GET', org('/me/notifications?limit=200'));
    expect(response.statusCode, response.body).toBe(200);
    return notificationListSchema.parse(response.json()).items;
  }

  const emailsOf = (user: FixtureUser): string[] =>
    smtp.messages
      .filter((message) => message.to.includes(fx.users[user].email))
      .map((message) => plainText(message.raw));

  const telegramOf = (chat: number): string[] =>
    telegram
      .sent()
      .filter((message) => message.chatId === String(chat))
      .map((message) => message.text);

  /** What Telegram posts to the registered webhook of the notification bot. */
  function telegramUpdate(
    text: string,
    options: { secret?: string | null; path?: string } = {},
  ): Promise<LightMyRequestResponse> {
    const registered = telegram.webhookUrl();
    const path = options.path ?? registered.slice(registered.lastIndexOf('/') + 1);
    const secret = options.secret === undefined ? telegram.webhookSecret() : options.secret;
    return t.app.inject({
      method: 'POST',
      url: `/api/v1/telegram/webhook/${path}`,
      headers: {
        'content-type': 'application/json',
        ...(secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret }),
      },
      payload: JSON.stringify({
        update_id: Math.floor(Math.random() * 1e9),
        message: {
          message_id: 1,
          date: 0,
          chat: { id: SALES1_CHAT, type: 'private' },
          from: { id: SALES1_CHAT, is_bot: false, first_name: 'Sales', language_code: 'vi' },
          text,
        },
      }),
    });
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    smtp = await startSmtpCapture();
    telegram = await startFakeTelegramBot();
    telegram.setUsername(BOT_TOKEN, BOT_USERNAME);
    t = await startTestApp(
      {
        DATABASE_URL: database.url,
        SMTP_URL: smtp.url,
        SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
        SMTP_ALLOW_INSECURE: 'true',
      },
      { telegramClient: { baseUrl: telegram.baseUrl } },
    );
    wsUrl = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    // Only the per-IP window is raised (one test address); the hook and base buckets stay.
    t.app.get(IncomingWebhookRateLimits).ip = { limit: 100_000, windowSeconds: 1 };

    const field = async (body: Record<string, unknown>) => {
      const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, body);
      expect(response.statusCode, response.body).toBe(201);
      return response.json<{ id: Id<'fld'> }>().id;
    };
    reviewers = await field({
      name: 'reviewers',
      type: 'user',
      options: { multiple: true, notify_on_assign: true },
    });
    customerField = await field({
      name: 'customer',
      type: 'link',
      options: { link_table: fx.customers.id },
    });
    const found = roleListSchema
      .parse((await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json())
      .items.find((role) => role.name === 'Sales');
    if (found === undefined) throw new Error('no Sales role');
    sales = found;
    await salesOrders('edit');

    const customers = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.customers.id}/records?field_key_type=id`,
      { records: [{ fields: { [F('customerName')]: 'canary-customer-name' } }] },
    );
    expect(customers.statusCode, customers.body).toBe(201);
    customer = customers.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
    [r1, r2] = (await createOrders([
      { [F('title')]: 'r1', [F('owner')]: [{ id: U('u_sales1') }], [F('cost')]: 101 },
      { [F('title')]: 'r2', [F('owner')]: [{ id: U('u_sales2') }], [F('cost')]: 202 },
    ])) as [Id<'rec'>, Id<'rec'>];

    // CONTRACTS §5 S5c fixture: hk_orders and aut_hook.
    hkOrders = await createHook({ auth: 'both', rate_limit_per_sec: 5 });
    autHook = await automation({
      trigger: { type: 'webhook.received', incoming_webhook_id: hkOrders.id },
      actions: [
        {
          id: 'act_update',
          type: 'update_record',
          config: {
            table_id: fx.orders.id,
            record_id: { trigger: 'body', path: 'record_id' },
            fields: { [F('amount')]: { trigger: 'body', path: 'amount' } },
          },
        },
      ],
    });

    target = await startTarget();
    trap = await startTarget();
    await allow(`public.test:${String(target.port)}`);
    signing = secretWithValueSchema.parse(
      (
        await fx.call('owner', 'POST', org('/secrets'), {
          kind: 'webhook_signing',
          name: 'n8n signing',
          generate: true,
          allowed_hosts: [`public.test:${String(target.port)}`],
        })
      ).json(),
    );

    // The organization's notification bot (P51/P52).
    const bot = await fx.call('owner', 'POST', org('/secrets'), {
      kind: 'telegram_bot',
      name: 'Notifications',
      value: BOT_TOKEN,
    });
    expect(bot.statusCode, bot.body).toBe(201);
    const chosen = await fx.call('owner', 'PATCH', org('/notification-channels'), {
      telegram_secret_id: secretSchema.parse(bot.json()).id,
    });
    expect(chosen.statusCode, chosen.body).toBe(200);

    worker = await createWorker(t.config, {
      logger: workerLogs.logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db: t.app.get<Db>(DB),
        logger: workerLogs.logger,
        telegramClient: { baseUrl: telegram.baseUrl },
        httpDelivery: { lookup },
        notificationEmailBatchMs: 500,
        notificationTelegramBatchMs: 300,
      }),
    });
    await settled();
  }, 180_000);

  afterAll(async () => {
    await closeSockets(sockets);
    await worker.close();
    await target.close();
    await trap.close();
    await t.close();
    await telegram.close();
    await smtp.close();
    await db.destroy();
    await database.drop();
  });

  // --- P44 ------------------------------------------------------------------------------

  it('P44: only base admins list/create hooks or make webhook.received automations', async () => {
    await salesOrders('manage');
    try {
      const list = `/bases/${fx.baseId}/incoming-webhooks`;
      for (const user of ['u_editor', 'u_reader', 'u_sales1'] as const) {
        expectProblem(await fx.call(user, 'GET', list), 403, 'PERMISSION_DENIED');
        expectProblem(
          await fx.call(user, 'POST', list, { name: `By ${user}`, auth: 'bearer' }),
          403,
          'PERMISSION_DENIED',
        );
      }
      for (const user of ['u_out', 'stranger'] as const) {
        expectProblem(await fx.call(user, 'GET', list), 404, 'NOT_FOUND');
        expectProblem(
          await fx.call(user, 'POST', list, { name: `By ${user}`, auth: 'bearer' }),
          404,
          'NOT_FOUND',
        );
      }
      // u_sales1 manages Orders, yet a webhook trigger is for base admins only (403 before
      // the definition is checked: the hook id cannot be probed).
      const byManager = await fx.call('u_sales1', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Sales hook automation',
        definition: {
          trigger: { type: 'webhook.received', incoming_webhook_id: hkOrders.id },
          actions: [
            {
              id: 'act_create',
              type: 'create_record',
              config: { table_id: fx.orders.id, fields: {} },
            },
          ],
        },
      });
      expectProblem(byManager, 403, 'PERMISSION_DENIED');
      // The admin sees exactly the fixture hook, with aut_hook as its usage.
      const listed = incomingWebhookListSchema.parse(
        (await fx.call('u_admin', 'GET', list)).json(),
      ).items;
      expect(listed.map((hook) => hook.id)).toEqual([hkOrders.id]);
      expect(listed[0]?.usages).toEqual([
        expect.objectContaining({ automation_id: autHook.id, name: autHook.name }),
      ]);
    } finally {
      await salesOrders('edit');
    }
  });

  // --- P45 ------------------------------------------------------------------------------

  it('P45: unknown, disabled and trashed-base hooks look alike (404); Bearer/signature 401; a replay is one event', async () => {
    const disabled = await createHook({ auth: 'none' });
    expect(
      (await fx.call('u_admin', 'PATCH', `/incoming-webhooks/${disabled.id}`, { enabled: false }))
        .statusCode,
    ).toBe(200);
    // A hook of a second base that goes to the trash (base B itself keeps the fixture).
    const workspace = await sql<{ workspace_id: string }>`
      SELECT workspace_id FROM meta.bases WHERE id = ${fx.baseId}
    `.execute(db.kysely);
    const other = await fx.call(
      'owner',
      'POST',
      `/workspaces/${workspace.rows[0]?.workspace_id ?? ''}/bases`,
      { name: 'Trash me' },
    );
    expect(other.statusCode, other.body).toBe(201);
    const otherBase = other.json<{ id: Id<'bse'> }>().id;
    const trashed = await createHook({ auth: 'none' }, 'owner', otherBase);
    expect((await fx.call('owner', 'DELETE', `/bases/${otherBase}`)).statusCode).toBe(204);

    const answers = [
      await post('A'.repeat(43)),
      await post(tokenOf(disabled), { bearer: null, secrets: [] }),
      await post(tokenOf(trashed), { bearer: null, secrets: [] }),
    ];
    const shapes = answers.map((response) => ({
      status: response.statusCode,
      problem: { ...problemOf(response.body), request_id: undefined },
    }));
    expect(shapes[0]).toMatchObject({ status: 404, problem: { code: 'NOT_FOUND' } });
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);

    const token = tokenOf(hkOrders);
    const body = { record_id: r1, amount: 45 };
    // Missing or wrong Bearer, missing/wrong/stale (± 330 s: well past the 300 s window even after the floor to seconds and a slow request) signature: 401, no reason given.
    const refused = [
      await post(token, { body, bearer: null }),
      await post(token, { body, bearer: 'not-the-token' }),
      await post(token, { body, secrets: [] }),
      await post(token, { body, secrets: ['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'] }),
      await post(token, { body, at: new Date(Date.now() - 330_000) }),
      await post(token, { body, at: new Date(Date.now() + 330_000) }),
    ];
    for (const response of refused) expectProblem(response, 401, 'UNAUTHENTICATED');
    const details = new Set(refused.map((response) => problemOf(response.body)['detail']));
    expect(details.size).toBe(1);

    // The same webhook-id twice: 202 both times, one event, one run.
    const before = (await runsOf(autHook.id)).length;
    const id = newId('evt');
    const first = await post(token, { body, id });
    const replay = await post(token, { body, id });
    expect([first.statusCode, replay.statusCode]).toEqual([202, 202]);
    const { rows: events } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.events
       WHERE entity_id = ${hkOrders.id} AND type = 'webhook.received'
    `.execute(db.kysely);
    expect(events[0]?.n).toBe(1);
    await settled();
    const runs = (await runsOf(autHook.id)).slice(before);
    expect(runs.map((run) => run.status)).toEqual(['succeeded']);
    const amount = await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/records/${r1}`);
    expect(amount.json<{ fields: Record<string, unknown> }>().fields['amount']).toBe(45);
  });

  // --- P46 ------------------------------------------------------------------------------

  it('P46: log, sample and URL for base admins only; never a secret or a sensitive header', async () => {
    const hook = `/incoming-webhooks/${hkOrders.id}`;
    for (const path of [hook, `${hook}/requests`, `${hook}/sample`]) {
      expectProblem(await fx.call('u_editor', 'GET', path), 403, 'PERMISSION_DENIED');
      expectProblem(await fx.call('stranger', 'GET', path), 404, 'NOT_FOUND');
    }
    expectProblem(await fx.call('u_editor', 'POST', `${hook}/listen`), 403, 'PERMISSION_DENIED');

    const read = await fx.call('u_admin', 'GET', hook);
    expect(read.statusCode, read.body).toBe(200);
    const dto = read.json<Record<string, unknown>>();
    expect(dto['url']).toBe(hkOrders.url);
    expect(dto).not.toHaveProperty('signing_secret');
    expect(dto).not.toHaveProperty('bearer_token');
    for (const secret of [hkOrders.signing_secret ?? '', hkOrders.bearer_token ?? '']) {
      expect(read.body).not.toContain(secret);
    }

    expect((await fx.call('u_admin', 'POST', `${hook}/listen`)).statusCode).toBe(200);
    const sent = await post(tokenOf(hkOrders), {
      body: { record_id: r1, amount: 46 },
      headers: {
        cookie: 'ob_session=canary-cookie',
        'x-cellhive-causation': 'canary-causation',
        'x-shop': 'web',
      },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    const sample = incomingWebhookSampleResponseSchema.parse(
      (await fx.call('u_admin', 'GET', `${hook}/sample`)).json(),
    ).sample;
    expect(sample?.body).toEqual({ record_id: r1, amount: 46 });
    expect(sample?.headers['x-shop']).toBe('web');
    for (const name of ['authorization', 'cookie', 'webhook-signature', 'x-cellhive-causation']) {
      expect(sample?.headers, name).not.toHaveProperty(name);
    }
    const log = await fx.call('u_admin', 'GET', `${hook}/requests`);
    const items = incomingWebhookRequestListSchema.parse(log.json()).items;
    expect(items.length).toBeGreaterThan(0);
    for (const canary of [
      'canary-cookie',
      'canary-causation',
      hkOrders.bearer_token ?? '',
      'webhook-signature',
      'authorization',
    ]) {
      expect(log.body).not.toContain(canary);
      expect(JSON.stringify(sample)).not.toContain(canary);
    }
    await settled();
  });

  // --- P47 ------------------------------------------------------------------------------

  it('P47: u_sales1 (manage) cannot save {{ [cost] }}; its n8n payload has no cost and a customer without title', async () => {
    await salesOrders('manage');
    try {
      const P = 'definition.actions[0].config';
      const saved = await fx.call('u_sales1', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Sales HTTP',
        definition: {
          trigger: { type: 'record.created', table_id: fx.orders.id },
          actions: [
            {
              id: 'act_http',
              type: 'http_request',
              config: {
                method: 'POST',
                url: { literal: publicUrl() },
                body: { type: 'json', value: { template: `{"c": "{{ [${F('cost')}] }}"}` } },
              },
            },
          ],
        },
      });
      expectProblem(saved, 422, 'AUTOMATION_INVALID');
      expect(
        saved
          .json<{ errors: { path: string; code: string }[] }>()
          .errors.map(({ path, code }) => ({ path, code })),
      ).toEqual([
        expect.objectContaining({ path: `${P}.body.value.template`, code: 'UNKNOWN_FIELD' }),
      ]);

      const flow = await automation(
        {
          trigger: { type: 'record.updated', table_id: fx.orders.id, watch_fields: [F('status')] },
          actions: [
            {
              id: 'act_n8n',
              type: 'run_n8n_workflow',
              config: {
                url: { literal: publicUrl('/webhook/cellhive') },
                signing_secret_id: signing.id,
                fields: null,
              },
            },
          ],
        },
        'u_sales1',
      );
      expect(flow.run_as.id).toBe(U('u_sales1'));
      const [order] = await createOrders([
        {
          [F('title')]: 'canary-p47-order',
          [F('owner')]: [{ id: U('u_sales1') }],
          [F('cost')]: 777_123,
          [customerField]: [customer],
        },
      ]);
      const before = target.received.length;
      const patched = await fx.call(
        'u_admin',
        'PATCH',
        `/tables/${fx.orders.id}/records/${order ?? ''}?field_key_type=id`,
        { fields: { [F('status')]: 'Xong', [F('cost')]: 888_456 } },
      );
      expect(patched.statusCode, patched.body).toBe(200);
      const run = await finishedRun(flow.id);
      expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
      const received = target.received.slice(before);
      expect(received).toHaveLength(1);
      const [request] = received as [Received];
      expect(
        verifyWebhook(request.headers, request.body, [signing.value as string], new Date()),
      ).toEqual({ ok: true });
      const payload = n8nWorkflowPayloadSchema.parse(JSON.parse(request.body));
      const record = payload.record;
      if (record === null) throw new Error('no record in the n8n payload');
      expect(Object.keys(record.fields)).not.toContain('cost');
      expect(Object.keys(record.fields_by_id)).not.toContain(F('cost'));
      expect(Object.keys(payload.changes ?? {})).not.toContain('cost');
      expect(request.body).not.toContain('777123');
      expect(request.body).not.toContain('888456');
      expect(record.fields_by_id[customerField]).toEqual([{ id: customer, title: null }]);
      expect(request.body).not.toContain('canary-customer-name');
      await disable(flow.id);
    } finally {
      await salesOrders('edit');
    }
    await settled();
  });

  // --- P48 ------------------------------------------------------------------------------

  it('P48: private, metadata, rebinding and redirect targets are blocked; an allowlisted name opens only itself', async () => {
    const onCreated = { type: 'record.created', table_id: fx.orders.id };
    const step = (url: string) => ({
      id: 'act_http',
      type: 'http_request',
      config: { method: 'POST', url: { literal: url } },
    });
    const cases: [string, string, Record<string, unknown>][] = [
      ['http://169.254.169.254/latest/meta-data/', 'ssrf_blocked', { reason: 'blocked_address' }],
      [`http://127.0.0.1:${String(trap.port)}/`, 'ssrf_blocked', {}],
      ['http://10.0.0.5/', 'ssrf_blocked', { reason: 'private_address' }],
      ['http://rebind.test/', 'ssrf_blocked', { reason: 'private_address' }],
      [`http://internal.test:${String(trap.port)}/`, 'ssrf_blocked', {}],
    ];
    for (const [url, code, params] of cases) {
      const flow = await automation({ trigger: onCreated, actions: [step(url)] });
      await createOrders([{ [F('title')]: `ssrf ${url}` }]);
      const run = await finishedRun(flow.id);
      expect(run, url).toMatchObject({ status: 'failed', error: { code, params } });
      await disable(flow.id);
    }
    // A 302 to loopback is never followed.
    const redirect = await automation({ trigger: onCreated, actions: [step(publicUrl())] });
    target.responders.push(reply(302, { location: `http://127.0.0.1:${String(trap.port)}/` }));
    await createOrders([{ [F('title')]: 'redirect' }]);
    expect(await finishedRun(redirect.id)).toMatchObject({
      status: 'failed',
      error: { code: 'http_status', params: { status: 302 } },
    });
    await disable(redirect.id);
    expect(trap.connections).toBe(0);

    // The organization allowlists `internal.test` (with the port: loopback needs it) and
    // `metadata.test`: the first now goes through; the metadata address never does.
    const entries = [
      await allow(`internal.test:${String(trap.port)}`),
      await allow('metadata.test'),
    ];
    const opened = await automation({
      trigger: onCreated,
      actions: [step(`http://internal.test:${String(trap.port)}/`)],
    });
    await createOrders([{ [F('title')]: 'allowlisted' }]);
    expect((await finishedRun(opened.id)).status).toBe('succeeded');
    expect(trap.received).toHaveLength(1);
    await disable(opened.id);
    const metadata = await automation({
      trigger: onCreated,
      actions: [step('http://metadata.test/')],
    });
    await createOrders([{ [F('title')]: 'metadata' }]);
    expect(await finishedRun(metadata.id)).toMatchObject({
      status: 'failed',
      error: { code: 'ssrf_blocked', params: { reason: 'blocked_address' } },
    });
    await disable(metadata.id);
    for (const entry of entries) {
      expect((await fx.call('owner', 'DELETE', `/http-allowlist/${entry}`)).statusCode).toBe(204);
    }
    await settled();
  });

  // --- P49 ------------------------------------------------------------------------------

  it('P49: a base admin who is no org admin cannot change the allowlist (403); another org 404', async () => {
    const entry = await allow('p49.example.com');
    const list = org('/http-allowlist');
    expectProblem(
      await fx.call('u_admin', 'POST', list, { pattern: 'evil.example.com' }),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_admin', 'DELETE', `/http-allowlist/${entry}`),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('stranger', 'POST', list, { pattern: 'evil.example.com' }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await fx.call('stranger', 'DELETE', `/http-allowlist/${entry}`),
      404,
      'NOT_FOUND',
    );
    const kept = await fx.call('owner', 'GET', list);
    expect(kept.json<{ items: { id: string; pattern: string }[] }>().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: entry, pattern: 'p49.example.com' })]),
    );
    expect(kept.body).not.toContain('evil.example.com');
    expect((await fx.call('owner', 'DELETE', `/http-allowlist/${entry}`)).statusCode).toBe(204);
  });

  // --- P50 ------------------------------------------------------------------------------

  it('P50: run detail and test deliveries: 404 for non-managers and other senders; no URL, header or secret', async () => {
    const header = secretWithValueSchema.parse(
      (
        await fx.call('owner', 'POST', org('/secrets'), {
          kind: 'http_header',
          name: 'P50 header',
          value: 'Bearer canary-p50-header-secret',
          allowed_hosts: [`public.test:${String(target.port)}`],
        })
      ).json(),
    );
    const flow = await automation({
      trigger: { type: 'record.created', table_id: fx.orders.id },
      actions: [
        {
          id: 'act_http',
          type: 'http_request',
          config: {
            method: 'POST',
            url: { literal: publicUrl('/canary-path?token=canary-url-token') },
            headers: [{ name: 'X-Custom', value: { literal: 'canary-header-value' } }],
            auth: { header_name: 'Authorization', secret_id: header.id },
            signing_secret_id: signing.id,
          },
        },
      ],
    });
    await createOrders([{ [F('title')]: 'p50' }]);
    const run = await finishedRun(flow.id);
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
    for (const user of ['u_editor', 'u_reader', 'u_sales1', 'stranger'] as const) {
      expectProblem(await fx.call(user, 'GET', `/automation-runs/${run.id}`), 404, 'NOT_FOUND');
    }
    const detail = await fx.call('u_admin', 'GET', `/automation-runs/${run.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    const steps = automationRunDetailSchema.parse(detail.json()).steps;
    expect(steps[0]).toMatchObject({
      action_type: 'http_request',
      delivery: { target_host: 'public.test', status: 'succeeded', attempts: 1 },
    });
    const stepText = JSON.stringify(steps);
    for (const canary of [
      'canary-url-token',
      '/canary-path',
      'canary-header-value',
      'canary-p50-header-secret',
      signing.value as string,
    ]) {
      expect(stepText, canary).not.toContain(canary);
    }
    expect(detail.body).not.toContain('canary-p50-header-secret');
    expect(detail.body).not.toContain(signing.value as string);

    // A test sent by u_admin: only u_admin reads it — not the org owner, not u_sales1.
    const [record] = await createOrders([{ [F('title')]: 'p50 test' }]);
    await settled();
    const sent = await fx.call(
      'u_admin',
      'POST',
      `/automations/${flow.id}/actions/act_http/http-test`,
      { record_id: record },
    );
    expect(sent.statusCode, sent.body).toBe(202);
    const deliveryId = sent.json<{ delivery_id: Id<'hdl'> }>().delivery_id;
    await eventually(async () => {
      const response = await fx.call('u_admin', 'GET', `/http-deliveries/${deliveryId}`);
      return ['succeeded', 'failed'].includes(response.json<{ status: string }>().status);
    }, 'the test delivery');
    for (const user of ['owner', 'u_editor', 'u_sales1', 'stranger'] as const) {
      expectProblem(await fx.call(user, 'GET', `/http-deliveries/${deliveryId}`), 404, 'NOT_FOUND');
    }
    const result = await fx.call('u_admin', 'GET', `/http-deliveries/${deliveryId}`);
    for (const canary of ['canary-url-token', 'canary-header-value', 'canary-p50-header-secret']) {
      expect(result.body).not.toContain(canary);
    }
    await disable(flow.id);
    await settled();
  });

  // --- P51 ------------------------------------------------------------------------------

  it('P51: members cannot switch the Telegram mode; the public route wants the secret and a known path', async () => {
    const patch = (user: FixtureUser) =>
      fx.call(user, 'PATCH', org('/notification-channels'), { telegram_delivery_mode: 'webhook' });
    for (const user of ['u_admin', 'u_sales1', 'u_reader'] as const) {
      expectProblem(await patch(user), 403, 'PERMISSION_DENIED');
    }
    expectProblem(await patch('stranger'), 404, 'NOT_FOUND');
    expect(telegram.callsOf('setWebhook')).toEqual([]);

    // The owner switches (TEST_PUBLIC_URL is https); u_sales1 links through the webhook.
    const switched = await patch('owner');
    expect(switched.statusCode, switched.body).toBe(200);
    expect(telegram.webhookUrl().startsWith(`${TEST_PUBLIC_URL}/api/v1/telegram/webhook/`)).toBe(
      true,
    );
    expectProblem(await telegramUpdate('/stop', { secret: 'wrong' }), 401, 'UNAUTHENTICATED');
    expectProblem(await telegramUpdate('/stop', { secret: null }), 401, 'UNAUTHENTICATED');
    expectProblem(await telegramUpdate('/stop', { path: 'x'.repeat(32) }), 404, 'NOT_FOUND');

    const created = await fx.call('u_sales1', 'POST', org('/me/channels/telegram'));
    expect(created.statusCode, created.body).toBe(201);
    const link = new URL(telegramLinkSchema.parse(created.json()).link).searchParams.get('start');
    expect((await telegramUpdate(`/start ${link ?? ''}`)).statusCode).toBe(200);
    await eventually(async () => {
      const mine = await fx.call('u_sales1', 'GET', org('/me/channels'));
      return mine.json<{ items: { status: string }[] }>().items[0]?.status === 'linked';
    }, 'the Telegram link of u_sales1');
    await settled();
  });

  // --- P52 ------------------------------------------------------------------------------

  it('P52: 200 hook requests in 50 s assigning u_sales1 → one record.assigned per window, readable records only, nothing about r2 anywhere', async () => {
    // 150 orders of u_sales1 (readable) and 50 of u_sales2 (not), r2 among the latter.
    const ids = await createOrders(
      Array.from({ length: P52_REQUESTS - 2 }, (_unused, i) => ({
        [F('title')]: i < P52_READABLE - 1 ? `Hook order ${String(i + 1)}` : `Hidden ${String(i)}`,
        [F('owner')]: [{ id: U(i < P52_READABLE - 1 ? 'u_sales1' : 'u_sales2') }],
      })),
    );
    const readable = [r1, ...ids.slice(0, P52_READABLE - 1)];
    const hidden = [r2, ...ids.slice(P52_READABLE - 1)];
    expect(readable).toHaveLength(P52_READABLE);
    expect(hidden).toHaveLength(P52_REQUESTS - P52_READABLE);
    await settled();

    // The aut_hook variant: assign `reviewers` = u_sales1 to the record of the request.
    const changed = await fx.call('u_admin', 'PATCH', `/automations/${autHook.id}`, {
      definition: {
        trigger: { type: 'webhook.received', incoming_webhook_id: hkOrders.id },
        actions: [
          {
            id: 'act_assign',
            type: 'update_record',
            config: {
              table_id: fx.orders.id,
              record_id: { trigger: 'body', path: 'record_id' },
              fields: { [reviewers]: { literal: [{ id: U('u_sales1') }] } },
            },
          },
        ],
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const socket = await TestSocket.connect(wsUrl, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie('u_sales1'),
    });
    sockets.push(socket);
    expect(await socket.subscribe(`user:${U('u_sales1')}`)).toMatchObject({
      type: 'subscribed',
    });
    const before = {
      inApp: (await inAppOf('u_sales1')).length,
      emails: emailsOf('u_sales1').length,
      telegram: telegramOf(SALES1_CHAT).length,
      runs: (await runsOf(autHook.id)).length,
    };

    // Interleaved (readable and hidden alternate), one request every 250 ms: 4/s, under
    // the hook's 5/s.
    const queue: Id<'rec'>[] = [];
    for (let i = 0, next = { readable: 0, hidden: 0 }; i < P52_REQUESTS; i += 1) {
      const fromHidden = i % 4 === 3 && next.hidden < hidden.length;
      const id = fromHidden ? hidden[next.hidden++] : readable[next.readable++];
      if (id !== undefined) queue.push(id);
    }
    expect(new Set(queue).size).toBe(P52_REQUESTS);
    const started = Date.now();
    const statuses: number[] = [];
    for (const [i, recordId] of queue.entries()) {
      const due = started + Math.round((i * P52_SPAN_MS) / P52_REQUESTS);
      const wait = due - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      statuses.push((await post(tokenOf(hkOrders), { body: { record_id: recordId } })).statusCode);
    }
    const span = Date.now() - started;
    expect(statuses.filter((status) => status !== 202)).toEqual([]);
    expect(span).toBeLessThan(P52_SPAN_MS + 5_000);

    // The window of (hook, table) is flushed 60 s after its first row by the worker's clock.
    await eventually(
      async () => (await inAppOf('u_sales1')).length > before.inApp,
      'the grouped notification',
      90_000,
    );
    await settled();
    await eventually(
      () =>
        Promise.resolve(
          emailsOf('u_sales1').length > before.emails &&
            telegramOf(SALES1_CHAT).length > before.telegram,
        ),
      'the email and the Telegram message',
    );
    // A moment more: nothing else may arrive.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const runs = (await runsOf(autHook.id)).slice(before.runs);
    expect(runs).toHaveLength(P52_REQUESTS);
    expect(runs.filter((run) => run.status !== 'succeeded')).toEqual([]);

    const fresh = (await inAppOf('u_sales1')).slice(0, -before.inApp || undefined);
    expect(fresh.map((item) => item.type)).toEqual(['record.assigned']);
    const [notice] = fresh;
    expect(notice).toMatchObject({
      entity: { type: 'table', id: fx.orders.id },
      data: {
        batch_id: null,
        count: P52_READABLE,
        field_ids: [reviewers],
        source: { incoming_webhook_id: hkOrders.id },
      },
    });
    const listed = (notice?.data['record_ids'] ?? []) as Id<'rec'>[];
    expect(listed).toHaveLength(20);
    expect(readable).toEqual(expect.arrayContaining(listed));
    const noticeText = JSON.stringify(notice);
    for (const id of hidden) expect(noticeText).not.toContain(id);

    const frames = socket.received.filter(
      (message: RealtimeServerMessage) =>
        message.type === 'notification.created' && message.notification_type === 'record.assigned',
    );
    expect(frames).toHaveLength(1);
    expect(JSON.stringify(socket.received)).not.toContain(r2);

    const emails = emailsOf('u_sales1').slice(before.emails);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toContain(`Bạn được gán ${String(P52_READABLE)} bản ghi trong`);
    expect(emails[0]).toContain('qua webhook');
    expect(emails[0]).not.toContain('Hidden');
    const messages = telegramOf(SALES1_CHAT).slice(before.telegram);
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain('Hidden');
    for (const id of hidden) {
      expect(emails[0]).not.toContain(id);
      expect(messages[0]).not.toContain(id);
    }
    // u_sales1 follows none of the hidden records (no auto-follow without read access).
    const { rows: follows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM meta.record_follows
         WHERE user_id = ${U('u_sales1')} AND record_id = ANY(${hidden}::text[])
      `.execute(db.kysely);
    expect(follows[0]?.n).toBe(0);
    process.stdout.write(
      `T615 P52: ${String(P52_REQUESTS)} requests in ${String(span)} ms → 1 notification (count ${String(P52_READABLE)})\n`,
    );
  }, 240_000);
});
