import {
  createdApiTokenSchema,
  createdShareLinkSchema,
  CSRF_COOKIE,
  CSRF_HEADER,
  dashboardListSchema,
  dashboardSchema,
  passwordResetLinkSchema,
  REALTIME_CLOSE_CODES,
  recordListResponseSchema,
  roleListSchema,
  sharedDashboardSchema,
  widgetDataSchema,
  widgetOptionsSchema,
  widgetRecordsSchema,
  widgetSchema,
  type ApiTokenScope,
  type CreatedApiToken,
  type CreatedShareLinkDto,
  type DashboardDto,
  type Id,
  type RealtimeServerMessage,
  type RoleDto,
  type WidgetDataDto,
  type WidgetDto,
} from '@cellhive/contracts';
import { RecordQueryService, type Db } from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DB } from '../../src/common/tokens.js';
import { ExportLeases } from '../../src/modules/export/export-leases.js';

import { uniqueIp } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

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
const INTRANET = 'https://intranet.test';
const NEW_PASSWORD = 'S7-Matrix-Reset-2026-ok';
const RULE = { cost: 'clr_S7CostRedAAAAAAA', done: 'clr_S7DoneGreenAAAAA' } as const;

/** A response read off the socket: status, headers, body. */
interface Wire {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  json<T = unknown>(): T;
}

/**
 * BACKLOG T818: the S7 rows of the permission matrix (CONTRACTS §5 P21,
 * P65–P77, BACKLOG "Phụ lục ma trận quyền S7") end to end on one fixture —
 * every request over a real TCP connection to two listening api instances
 * (`fetch`, no `inject`; the dashboard cache and the realtime hints cross
 * instances through Valkey), a real graphile worker and the Node `ws`
 * client (cookie + Origin for sessions, `Authorization` for tokens). The
 * per-task tests (T802, T805–T810, T816) go deeper on each row;
 * `pnpm test:matrix` runs them together with this file and P01–P64.
 *
 * Fixture (appendix S7): dashboard D in B (u_admin) with `w_count`,
 * `w_cost`, `w_status` (status × owner), `w_customer` (link → Customers),
 * `w_saved_cost` (saved filter `cost > 100`), `w_tickets` (another table),
 * controls `ctl_status`, `ctl_cost`, `ctl_province` → `ctl_district`; Sales
 * reads D; D2 in B2 (u_admin only); `viw_color` (color rules `cost > 100`
 * red, `status is Xong` green) and `viw_sales` (same rules, `amount ≥ 150`,
 * `cost` hidden) of Orders; the S6 tokens. P75 runs last (it signs u_sales1
 * out everywhere).
 */
describe('permission matrix S7 over HTTP (T818)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: TestApp;
  let b: TestApp;
  let wsA: string;
  let wsB: string;
  let httpA: string;
  let httpB: string;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  const workerLogs = captureLogger();
  const sockets: TestSocket[] = [];

  let r1: Id<'rec'>, r2: Id<'rec'>, r3: Id<'rec'>;
  let c1: Id<'rec'>;
  let customer: Id<'fld'>;
  let base2: Id<'bse'>;
  let D: DashboardDto;
  let D2: DashboardDto;
  let viwColor: Id<'viw'>;
  let viwSales: Id<'viw'>;
  let salesRole: RoleDto;
  const w: Record<string, WidgetDto> = {};
  const fields: Record<string, Id<'fld'>> = {};
  const options: Record<string, string> = {};
  const tk = {} as Record<
    'sales_r' | 'sales_w' | 'sales_schema' | 'editor' | 'admin_b2',
    CreatedApiToken
  >;

  const F = (name: string): Id<'fld'> => {
    const id = fields[name] ?? fx.fld[name]?.id;
    if (id === undefined) throw new Error(`no field ${name}`);
    return id;
  };
  const widget = (name: string): WidgetDto => {
    const found = w[name];
    if (found === undefined) throw new Error(`no widget ${name}`);
    return found;
  };
  const orders = () => `/tables/${fx.orders.id}/records`;

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
        // share links and failed Bearer authentications are limited per IP.
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
    origin: string = httpA,
  ): Promise<Wire> {
    return send(origin, method, `/api/v1${path}`, {
      body: body ?? (method === 'GET' || method === 'DELETE' ? undefined : {}),
      headers: { authorization: `Bearer ${token}` },
    });
  }

  /** A request with the session cookie (and CSRF token) of `user`, like the SPA. */
  async function session(
    user: FixtureUser,
    method: Method,
    path: string,
    body?: unknown,
    origin: string = httpA,
  ): Promise<Wire> {
    const cookie = await fx.cookie(user);
    let token = '';
    for (const match of cookie.matchAll(/(?:^|; )([^=]+)=([^;]*)/gu)) {
      if (match[1] === CSRF_COOKIE) token = match[2] ?? '';
    }
    return send(origin, method, `/api/v1${path}`, {
      body: body ?? (method === 'GET' || method === 'DELETE' ? undefined : {}),
      headers: { cookie, ...(method === 'GET' ? {} : { [CSRF_HEADER]: token }) },
    });
  }

  /** Anonymous request through a share link (instance B: links are stateless). */
  function viaLink(method: 'GET' | 'POST', token: string, path: string, body?: unknown) {
    return send(httpB, method, `/api/v1/shares/${token}${path}`, {
      body: body ?? (method === 'GET' ? undefined : {}),
    });
  }

  function problem(response: Wire): {
    code?: string;
    errors?: { code: string; path?: string; params?: unknown }[];
  } {
    return response.json();
  }

  function expectProblem(response: Wire, status: number, code: string, detail?: string): void {
    expect({ status: response.status, code: problem(response).code }, response.body).toEqual({
      status,
      code,
    });
    if (detail !== undefined) {
      expect(problem(response).errors?.map((error) => error.code)).toContain(detail);
    }
  }

  function expectScope(response: Wire, required: string): void {
    expectProblem(response, 403, 'INSUFFICIENT_SCOPE');
    expect(problem(response).errors?.[0]).toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
      params: { required: [required] },
    });
  }

  function ok(response: Wire, status = 200): Wire {
    expect(response.status, response.body).toBe(status);
    return response;
  }

  /** Widget data as `user` (session), on instance A unless given. */
  async function dataOf(
    user: FixtureUser,
    name: string,
    filters: unknown[] = [],
    origin: string = httpA,
  ): Promise<WidgetDataDto> {
    return widgetDataSchema.parse(
      ok(
        await session(user, 'POST', `/widgets/${widget(name).id}/data`, { filters }, origin),
      ).json(),
    );
  }

  async function linkData(token: string, name: string, filters: unknown[] = []) {
    return widgetDataSchema.parse(
      ok(await viaLink('POST', token, `/widgets/${widget(name).id}/data`, { filters })).json(),
    );
  }

  /** No number of any kind in a `no_permission` answer. */
  function expectNoPermission(result: WidgetDataDto): void {
    expect(result).toMatchObject({ status: 'no_permission', columns: [], rows: [] });
    expect(result.total).toBeUndefined();
    expect(result.other).toBeUndefined();
    expect(result.compare).toBeUndefined();
  }

  const control = (name: string, value: unknown) => ({
    source: 'control',
    widget_id: widget(name).id,
    value,
  });

  async function createToken(
    user: FixtureUser,
    scopes: ApiTokenScope[],
    extra: Record<string, unknown> = {},
  ): Promise<CreatedApiToken> {
    const response = await session(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: `${user} ${scopes.join(' ')} ${String(Math.random()).slice(2, 8)}`.slice(0, 100),
      scopes,
      expires_at: new Date(Date.now() + 90 * DAY_MS).toISOString(),
      ...extra,
    });
    expect(response.status, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  async function createDashboardLink(
    user: FixtureUser,
    body: Record<string, unknown> = {},
  ): Promise<CreatedShareLinkDto> {
    const response = ok(
      await session(user, 'POST', `/dashboards/${D.id}/share-links`, {
        audience: 'public',
        ...body,
      }),
      201,
    );
    return createdShareLinkSchema.parse(response.json());
  }

  async function watchAs(user: FixtureUser, url: string = wsB): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
      forwardedFor: uniqueIp(),
    });
    sockets.push(socket);
    return socket;
  }

  async function watchWith(token: string, url: string = wsB): Promise<TestSocket> {
    const result = await TestSocket.open(url, {
      authorization: `Bearer ${token}`,
      forwardedFor: uniqueIp(),
    });
    if (!result.ok) throw new Error(`refused: ${String(result.status)} ${result.body}`);
    sockets.push(result.socket);
    return result.socket;
  }

  /** Changes the Sales role config from the one of the fixture (restored by `restoreSales`). */
  async function setSales(change: (config: RoleDto['config']) => RoleDto['config']) {
    ok(
      await session('u_admin', 'PATCH', `/bases/${fx.baseId}/roles/${salesRole.id}`, {
        config: change(structuredClone(salesRole.config)),
      }),
    );
  }

  async function restoreSales(): Promise<void> {
    ok(
      await session('u_admin', 'PATCH', `/bases/${fx.baseId}/roles/${salesRole.id}`, {
        config: salesRole.config,
      }),
    );
  }

  const withBaseRule = (rule: Record<string, boolean>) => (config: RoleDto['config']) => ({
    ...config,
    base_rule: { ...(config.base_rule as Record<string, boolean>), ...rule },
  });

  function csvOf(response: Wire): string[][] {
    expect(response.status, response.body).toBe(200);
    return response.body
      .replace(/^\uFEFF/u, '')
      .split('\r\n')
      .filter((line) => line !== '')
      .map((line) => line.split(','));
  }

  const dataChanged = (message: Message) => message.type === 'dashboard.data_changed';

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    a = await startTestApp({ DATABASE_URL: database.url });
    b = await startTestApp({ DATABASE_URL: database.url });
    wsA = await listen(a.app);
    wsB = await listen(b.app);
    httpA = wsA.replace('ws://', 'http://').replace(/\/ws$/u, '');
    httpB = wsB.replace('ws://', 'http://').replace(/\/ws$/u, '');
    fx = await buildRecordFixture(a, db);

    // Orders: customer → Customers, province → district (the cascading slicer).
    const addField = async (name: string, type: string, fieldOptions: object) => {
      const response = ok(
        await session('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
          name,
          type,
          options: fieldOptions,
        }),
        201,
      );
      const created = response.json<{
        id: Id<'fld'>;
        options: { options?: { id: string; name: string }[] };
      }>();
      fields[name] = created.id;
      for (const option of created.options.options ?? []) options[option.name] = option.id;
      return created.id;
    };
    customer = await addField('customer', 'link', { link_table: fx.customers.id });
    const choices = (names: string[]) => ({ options: names.map((name) => ({ name })) });
    await addField('province', 'select', choices(['Hà Nội', 'Hồ Chí Minh']));
    await addField('district', 'select', choices(['Ba Đình', 'Cầu Giấy', 'Quận 1']));
    for (const option of (fx.fld['status']?.options as { options: { id: string; name: string }[] })
      .options) {
      options[option.name] = option.id;
    }
    const customers = ok(
      await session('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
        records: [{ fields: { Tên: 'An Phát' } }, { fields: { Tên: 'Bình Minh' } }],
      }),
      201,
    ).json<{ records: { id: Id<'rec'> }[] }>().records;
    c1 = customers[0]?.id as Id<'rec'>;
    const order = (
      title: string,
      owner: FixtureUser | null,
      status: string,
      amount: number,
      cost: number,
      where: [string, string],
    ) => ({
      fields: {
        title,
        amount,
        cost,
        status,
        owner: owner === null ? [] : [{ id: fx.users[owner].id }],
        customer: [customers[title === 'r2' ? 1 : 0]?.id],
        province: where[0],
        district: where[1],
      },
    });
    const created = ok(
      await session('u_admin', 'POST', `${orders()}?typecast=true`, {
        records: [
          order('r1', 'u_sales1', 'Mới', 100, 150, ['Hà Nội', 'Ba Đình']),
          order('r2', 'u_sales2', 'Xong', 200, 20, ['Hà Nội', 'Cầu Giấy']),
          order('r3', null, 'Mới', 300, 130, ['Hồ Chí Minh', 'Quận 1']),
        ],
      }),
      201,
    ).json<{ records: { id: Id<'rec'> }[] }>().records;
    [r1, r2, r3] = created.map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];

    // B2 (u_admin admin, u_sales1 no role) with D2.
    const workspaces = ok(await session('owner', 'GET', `/orgs/${fx.orgId}/workspaces`)).json<{
      items: { id: Id<'wsp'> }[];
    }>();
    const workspaceId = workspaces.items[0]?.id as Id<'wsp'>;
    base2 = ok(
      await session('owner', 'POST', `/workspaces/${workspaceId}/bases`, { name: 'B2' }),
      201,
    ).json<{ id: Id<'bse'> }>().id;
    const roles2 = roleListSchema.parse(
      ok(await session('owner', 'GET', `/bases/${base2}/roles`)).json(),
    ).items;
    ok(
      await session('owner', 'PUT', `/bases/${base2}/role-assignments`, {
        principal_type: 'user',
        principal_id: fx.users.u_admin.id,
        role_id: roles2.find((role) => role.kind === 'system_admin')?.id,
      }),
    );
    D2 = dashboardSchema.parse(
      ok(
        await session('u_admin', 'POST', `/bases/${base2}/dashboards`, { name: 'D2' }),
        201,
      ).json(),
    );

    // Dashboard D of the appendix, built by u_admin.
    D = dashboardSchema.parse(
      ok(
        await session('u_admin', 'POST', `/bases/${fx.baseId}/dashboards`, { name: 'D' }),
        201,
      ).json(),
    );
    const add = async (name: string, type: string, config: Record<string, unknown>) => {
      w[name] = widgetSchema.parse(
        ok(
          await session('u_admin', 'POST', `/dashboards/${D.id}/widgets`, {
            type,
            title: name,
            config,
          }),
          201,
        ).json(),
      );
    };
    const tbl = fx.orders.id;
    const count = [{ id: 'm1', aggregation: 'count' }];
    await add('ctl_status', 'filter_control', {
      table_id: tbl,
      field: F('status'),
      control: 'select',
    });
    await add('ctl_cost', 'filter_control', {
      table_id: tbl,
      field: F('cost'),
      control: 'number_range',
    });
    await add('ctl_province', 'filter_control', {
      table_id: tbl,
      field: F('province'),
      control: 'select',
    });
    await add('ctl_district', 'filter_control', {
      table_id: tbl,
      field: F('district'),
      control: 'select',
      parent_control_id: widget('ctl_province').id,
    });
    await add('w_count', 'kpi', {
      table_id: tbl,
      metrics: count,
      filter_bindings: [widget('ctl_status').id, widget('ctl_cost').id],
    });
    await add('w_cost', 'kpi', {
      table_id: tbl,
      metrics: [{ id: 'm1', aggregation: 'sum', field: F('cost') }],
    });
    await add('w_status', 'bar', {
      table_id: tbl,
      dimension: { field: F('status') },
      series_dimension: { field: F('owner') },
      metrics: count,
    });
    await add('w_customer', 'bar', {
      table_id: tbl,
      dimension: { field: customer },
      metrics: count,
    });
    await add('w_saved_cost', 'bar', {
      table_id: tbl,
      dimension: { field: F('status') },
      metrics: count,
      filter: { op: 'and', items: [{ field: F('cost'), operator: 'gt', value: 100 }] },
    });
    await add('w_tickets', 'kpi', { table_id: fx.tickets.id, metrics: count });

    // Sales reads D (read_only); the config of the fixture otherwise.
    const sales = roleListSchema
      .parse(ok(await session('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json())
      .items.find((role) => role.name === 'Sales');
    if (sales === undefined) throw new Error('no Sales role');
    salesRole = { ...sales, config: { ...sales.config, dashboards: { [D.id]: 'read_only' } } };
    await restoreSales();

    // Views of Orders with the color rules of P76; viw_sales hides cost (link shl_V).
    const rules = [
      {
        id: RULE.cost,
        color: 'red',
        target: 'row',
        filter: { op: 'and', items: [{ field: F('cost'), operator: 'gt', value: 100 }] },
      },
      {
        id: RULE.done,
        color: 'green',
        target: 'row',
        filter: {
          op: 'and',
          items: [{ field: F('status'), operator: 'is', value: options['Xong'] }],
        },
      },
    ];
    const view = async (name: string, config: Record<string, unknown>) =>
      ok(
        await session('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
          name,
          type: 'grid',
          config,
        }),
        201,
      ).json<{ id: Id<'viw'> }>().id;
    viwColor = await view('viw_color', { color_rules: rules });
    viwSales = await view('viw_sales', {
      color_rules: rules,
      hidden_fields: [F('cost')],
      filter: { op: 'and', items: [{ field: F('amount'), operator: 'gte', value: 150 }] },
    });

    // The tokens of the S6 fixture (and a schema-only token of u_sales1, P77).
    tk.sales_r = await createToken('u_sales1', ['records:read', 'schema:read']);
    tk.sales_w = await createToken('u_sales1', ['records:write']);
    tk.sales_schema = await createToken('u_sales1', ['schema:read']);
    tk.editor = await createToken('u_editor', ALL_SCOPES);
    tk.admin_b2 = await createToken('u_admin', ALL_SCOPES, { base_ids: [base2] });

    worker = await createWorker(a.config, {
      logger: workerLogs.logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: a.config,
        db: a.app.get<Db>(DB),
        logger: workerLogs.logger,
      }),
    });
  }, 180_000);

  afterAll(async () => {
    await closeSockets(sockets);
    await worker.close();
    await Promise.all([a.close(), b.close()]);
    await db.destroy();
    await database.drop();
  });

  // --- P21, P65–P67 ----------------------------------------------------------------------------

  it('P21: w_count — u_sales1 counts only r1 (both instances), u_admin all three', async () => {
    expect((await dataOf('u_sales1', 'w_count')).rows).toEqual([[1]]);
    expect((await dataOf('u_sales1', 'w_count', [], httpB)).rows).toEqual([[1]]);
    expect((await dataOf('u_sales2', 'w_count')).rows).toEqual([[1]]);
    expect((await dataOf('u_admin', 'w_count')).rows).toEqual([[3]]);
    expect((await dataOf('u_reader', 'w_count', [], httpB)).rows).toEqual([[3]]);
  });

  it('P65: u_reader reads D but cannot change it; Sales without D → 404 everywhere; u_out, another org → 404', async () => {
    ok(await session('u_reader', 'GET', `/dashboards/${D.id}`));
    expectProblem(
      await session('u_reader', 'PATCH', `/dashboards/${D.id}`, { name: 'Renamed' }),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await session('u_reader', 'POST', `/dashboards/${D.id}/widgets`, {
        type: 'text',
        config: { markdown: 'x' },
      }),
      403,
      'PERMISSION_DENIED',
    );

    const listed = async (user: FixtureUser) =>
      dashboardListSchema
        .parse(ok(await session(user, 'GET', `/bases/${fx.baseId}/dashboards`)).json())
        .items.map((item) => item.id);
    expect(await listed('u_sales1')).toEqual([D.id]);
    await setSales((config) => ({ ...config, dashboards: {} }));
    try {
      expect(await listed('u_sales1')).toEqual([]);
      for (const [method, path, body] of [
        ['GET', `/dashboards/${D.id}`, undefined],
        ['PATCH', `/dashboards/${D.id}`, { name: 'x' }],
        ['POST', `/dashboards/${D.id}/widgets`, { type: 'text', config: {} }],
        ['POST', `/widgets/${widget('w_count').id}/data`, {}],
        ['POST', `/dashboards/${D.id}/duplicate`, {}],
        ['DELETE', `/dashboards/${D.id}`, undefined],
      ] as const) {
        expectProblem(await session('u_sales1', method, path, body), 404, 'NOT_FOUND');
      }
    } finally {
      await restoreSales();
    }
    ok(await session('u_sales1', 'GET', `/dashboards/${D.id}`, undefined, httpB));
    for (const user of ['u_out', 'stranger'] as const) {
      expectProblem(await session(user, 'GET', `/dashboards/${D.id}`), 404, 'NOT_FOUND');
      expectProblem(
        await session(user, 'POST', `/widgets/${widget('w_count').id}/data`),
        404,
        'NOT_FOUND',
      );
      expectProblem(await session(user, 'GET', `/bases/${fx.baseId}/dashboards`), 404, 'NOT_FOUND');
    }
    expectProblem(await session('u_sales1', 'GET', `/dashboards/${D2.id}`), 404, 'NOT_FOUND');
  });

  it('P66: w_cost and w_saved_cost are no_permission without numbers; w_status only the group of r1', async () => {
    const cost = await dataOf('u_sales1', 'w_cost');
    expectNoPermission(cost);
    // The saved filter names a hidden field: never dropped (that would count more).
    const saved = await dataOf('u_sales1', 'w_saved_cost');
    expectNoPermission(saved);
    expect((await dataOf('u_admin', 'w_saved_cost')).total).toEqual([2]);
    expect((await dataOf('u_admin', 'w_cost')).rows).toEqual([[300]]);
    const status = await dataOf('u_sales1', 'w_status');
    expect(status.rows).toEqual([
      [
        expect.objectContaining({ value: options['Mới'] }),
        expect.objectContaining({ value: fx.users.u_sales1.id }),
        1,
      ],
    ]);
    expect(status.total).toEqual([1]);
  });

  it('P67: w_customer is no_permission for Sales (no Customers title); tk_sales_r counts 1 like the session', async () => {
    const byCustomer = await session(
      'u_sales1',
      'POST',
      `/widgets/${widget('w_customer').id}/data`,
    );
    expectNoPermission(widgetDataSchema.parse(ok(byCustomer).json()));
    expect(byCustomer.body).not.toContain('An Phát');
    expect(byCustomer.body).not.toContain(c1);
    expect((await dataOf('u_admin', 'w_customer')).rows).toHaveLength(2);
    const viaToken = await bearer(
      tk.sales_r.token,
      'POST',
      `/widgets/${widget('w_count').id}/data`,
    );
    expect(widgetDataSchema.parse(ok(viaToken).json()).rows).toEqual([[1]]);
  });

  // --- P68, P69 ------------------------------------------------------------------------------

  it('P68: one cache entry per reading access across instances; writes and role changes miss', async () => {
    // A fresh data_version: every key of w_status is cold.
    ok(
      await session('u_admin', 'PATCH', orders(), {
        records: [{ id: r3, fields: { amount: 301 } }],
      }),
    );
    const admin = await dataOf('u_admin', 'w_status');
    expect(admin.cache).toBe('miss');
    expect(admin.total).toEqual([3]);
    // Instance B reads the entry of A; the editor reads the same records and fields.
    const warm = await dataOf('u_admin', 'w_status', [], httpB);
    expect(warm).toMatchObject({ cache: 'hit', computed_at: admin.computed_at });
    expect(await dataOf('u_editor', 'w_status', [], httpB)).toMatchObject({ cache: 'hit' });
    // u_sales1 and u_sales2 (same role, `current_user` rule): an entry each, their numbers.
    const sales1 = await dataOf('u_sales1', 'w_status');
    expect(sales1).toMatchObject({ cache: 'miss', total: [1] });
    expect(sales1.rows[0]?.[1]).toMatchObject({ value: fx.users.u_sales1.id });
    const sales2 = await dataOf('u_sales2', 'w_status', [], httpB);
    expect(sales2).toMatchObject({ cache: 'miss', total: [1] });
    expect(sales2.rows[0]?.[1]).toMatchObject({ value: fx.users.u_sales2.id });
    expect((await dataOf('u_sales1', 'w_status', [], httpB)).cache).toBe('hit');

    // A write to r1: new data_version → miss with the new number.
    ok(
      await session('u_sales1', 'PATCH', orders(), {
        records: [{ id: r1, fields: { amount: 110 } }],
      }),
    );
    expect((await dataOf('u_sales1', 'w_status')).cache).toBe('miss');
    // A role change: a new fingerprint → miss with the numbers of the new access.
    await setSales((config) => {
      const tables = config.tables as Record<string, { record_rule: Record<string, unknown> }>;
      const rule = tables[fx.orders.id]?.record_rule ?? {};
      return {
        ...config,
        tables: {
          ...tables,
          [fx.orders.id]: {
            ...tables[fx.orders.id],
            record_rule: { ...rule, read_scope: 'all', read_filter: null },
          },
        },
      };
    });
    try {
      expect(await dataOf('u_sales1', 'w_status')).toMatchObject({ cache: 'miss', total: [3] });
    } finally {
      await restoreSales();
    }

    // 20 cold requests over the two instances: one widget query.
    ok(
      await session('u_admin', 'PATCH', orders(), {
        records: [{ id: r3, fields: { amount: 302 } }],
      }),
    );
    const spies = [a, b].map((app) => vi.spyOn(app.app.get(RecordQueryService), 'widgetData'));
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          dataOf('u_admin', 'w_status', [], index % 2 === 0 ? httpA : httpB),
        ),
      );
      expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(1);
      expect(results.filter((result) => result.cache === 'miss')).toHaveLength(1);
      expect(new Set(results.map((result) => JSON.stringify(result.rows))).size).toBe(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('P69: dashboard:D — 404 without D; table ids only within 6 s; tokens; losing read_only ends it', async () => {
    const channel = `dashboard:${D.id}`;
    await setSales((config) => ({ ...config, dashboards: {} }));
    try {
      const without = await watchAs('u_sales1');
      expect(await without.subscribe(channel)).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    } finally {
      await restoreSales();
    }

    const sales1 = await watchAs('u_sales1');
    const admin = await watchAs('u_admin', wsA);
    expect(await sales1.subscribe(channel)).toMatchObject({ type: 'subscribed', channel });
    expect(await admin.subscribe(channel)).toMatchObject({ type: 'subscribed', channel });
    // The write lands on instance A, u_sales1 listens on B.
    const started = Date.now();
    ok(
      await session('u_editor', 'PATCH', orders(), {
        records: [{ id: r2, fields: { amount: 222, cost: 33 } }],
      }),
    );
    const hint = await sales1.next(dataChanged, 10_000);
    expect(Date.now() - started).toBeLessThanOrEqual(6_000);
    expect(hint).toEqual({
      type: 'dashboard.data_changed',
      channel,
      dashboard_id: D.id,
      table_ids: [fx.orders.id],
    });
    const text = JSON.stringify(hint);
    for (const forbidden of [r2, '222', '33', F('amount'), F('cost')]) {
      expect(text).not.toContain(forbidden);
    }
    await admin.next(dataChanged, 10_000);
    // Tickets (w_tickets): the admin hears of it, Sales (no Tickets) never does.
    ok(
      await session('u_admin', 'POST', `/tables/${fx.tickets.id}/records`, {
        records: [{ fields: { 'Tiêu đề': 'T' } }],
      }),
      201,
    );
    expect(await admin.next(dataChanged, 10_000)).toMatchObject({ table_ids: [fx.tickets.id] });
    await sales1.expectNone(dataChanged, 300);

    // Tokens: records:read inside base_ids.
    expect(await (await watchWith(tk.sales_r.token)).subscribe(channel)).toMatchObject({
      type: 'subscribed',
    });
    expect(await (await watchWith(tk.sales_schema.token)).subscribe(channel)).toMatchObject({
      type: 'error',
      code: 'INSUFFICIENT_SCOPE',
    });
    expect(await (await watchWith(tk.admin_b2.token)).subscribe(channel)).toMatchObject({
      type: 'error',
      code: 'NOT_FOUND',
    });

    // Losing read_only while subscribed: error NOT_FOUND (req_id null), then silence.
    await setSales((config) => ({ ...config, dashboards: {} }));
    try {
      expect(
        await sales1.next((message) => message.type === 'error' && message.channel === channel),
      ).toEqual({ type: 'error', req_id: null, code: 'NOT_FOUND', channel });
      ok(
        await session('u_editor', 'PATCH', orders(), {
          records: [{ id: r1, fields: { amount: 120 } }],
        }),
      );
      await sales1.expectNone(dataChanged, 6_000);
    } finally {
      await restoreSales();
    }
  });

  // --- P70, P74 ------------------------------------------------------------------------------

  it('P70: hidden-field controls are set aside; free filters 422; cross-filter; slicers; click-through', async () => {
    // ctl_cost on a field Sales cannot read: ignored, the number does not move.
    const costRange = control('ctl_cost', { range: { from: 0, to: 1000 } });
    const viaControl = await dataOf('u_sales1', 'w_count', [costRange]);
    expect(viaControl.rows).toEqual([[1]]);
    expect(viaControl.ignored_filters).toEqual([
      { source: 'control', id: widget('ctl_cost').id, reason: 'no_permission' },
    ]);
    const nothing = control('ctl_cost', { range: { from: null, to: 0 } });
    expect((await dataOf('u_admin', 'w_count', [nothing])).status).toBe('empty');
    expect((await dataOf('u_sales1', 'w_count', [nothing])).rows).toEqual([[1]]);

    // A free filter or an undeclared source: 422, nothing applied.
    for (const filters of [
      [{ field: F('cost'), operator: 'gt', value: 100 }],
      [{ source: 'global', id: 'nope', value: { values: [] } }],
      [{ source: 'control', widget_id: widget('w_status').id, value: { values: [] } }],
    ]) {
      expectProblem(
        await session('u_sales1', 'POST', `/widgets/${widget('w_count').id}/data`, { filters }),
        422,
        'VALIDATION_FAILED',
      );
    }

    // Cross-filter "Mới" from w_status: every widget of Orders, the source keeps its groups.
    const fresh = { source: 'cross', widget_id: widget('w_status').id, value: options['Mới'] };
    expect((await dataOf('u_admin', 'w_count', [fresh])).rows).toEqual([[2]]);
    expect((await dataOf('u_sales1', 'w_count', [fresh])).rows).toEqual([[1]]);
    expect((await dataOf('u_sales1', 'w_status', [fresh])).ignored_filters).toEqual([
      { source: 'cross', id: widget('w_status').id, reason: 'self' },
    ]);
    expect((await dataOf('u_admin', 'w_tickets', [fresh])).ignored_filters).toEqual([
      { source: 'cross', id: widget('w_status').id, reason: 'other_table' },
    ]);

    // Cascading slicers: districts of Hà Nội among the records the viewer reads.
    const districts = async (user: FixtureUser) =>
      widgetOptionsSchema
        .parse(
          ok(
            await session(user, 'POST', `/widgets/${widget('ctl_district').id}/options`, {
              filters: [control('ctl_province', { values: [options['Hà Nội']] })],
            }),
          ).json(),
        )
        .items.map((item) => item.label);
    expect(await districts('u_admin')).toEqual(['Ba Đình', 'Cầu Giấy']);
    expect(await districts('u_sales1')).toEqual(['Ba Đình']);

    // Click-through of the "Mới" segment: r1 only, without cost.
    const through = widgetRecordsSchema.parse(
      ok(
        await session('u_sales1', 'POST', `/widgets/${widget('w_status').id}/records`, {
          segment: { dimension: options['Mới'], series: fx.users.u_sales1.id },
        }),
      ).json(),
    );
    expect(through.records.map((record) => record.id)).toEqual([r1]);
    for (const record of through.records)
      expect(Object.keys(record.fields)).not.toContain(F('cost'));
  });

  it('P74: widget CSV — u_sales1 (no download) 403; u_reader gets the aggregate table, audited', async () => {
    const url = `/widgets/${widget('w_status').id}/export?format=csv`;
    expectProblem(await session('u_sales1', 'GET', url), 403, 'PERMISSION_DENIED');
    const response = await session('u_reader', 'GET', url, undefined, httpB);
    const [header, ...rows] = csvOf(response);
    // The metric's default name follows the reader's locale (Count / Số lượng).
    expect(header?.slice(0, 2)).toEqual(['status', 'owner']);
    expect(header).toHaveLength(3);
    expect(rows).toHaveLength(3);
    // Groups and counts only: no record title.
    expect(response.body).not.toContain('r1');
    const entry = await db.kysely
      .selectFrom('meta.audit_logs')
      .selectAll()
      .where('action', '=', 'export.created')
      .where('entity_type', '=', 'dashboard_widget')
      .executeTakeFirstOrThrow();
    expect(entry).toMatchObject({
      entity_id: widget('w_status').id,
      actor_id: fx.users.u_reader.id,
    });
    expect(entry.after).toEqual({ dashboard_id: D.id, format: 'csv', row_count: 3 });
  });

  // --- P71, P72 (links of D) -------------------------------------------------------------------

  it("P71: shl_D (public, u_editor) — no saved filter; the creator's numbers; undeclared sources 403", async () => {
    // Warm the cache with u_sales1's number first: the link never reads it.
    expect((await dataOf('u_sales1', 'w_count')).rows).toEqual([[1]]);
    const link = await createDashboardLink('u_editor');
    const response = ok(await viaLink('GET', link.token, '/dashboard'));
    const shared = sharedDashboardSchema.parse(response.json());
    expect(shared.widgets.every((item) => item.config?.['filter'] == null)).toBe(true);
    expect(response.body).not.toContain('"gt"');
    expect((await linkData(link.token, 'w_count')).rows).toEqual([[3]]);
    expect((await linkData(link.token, 'w_saved_cost')).total).toEqual([2]);
    expectProblem(
      await viaLink('POST', link.token, `/widgets/${widget('w_count').id}/data`, {
        filters: [{ source: 'global', id: 'nope', value: { range: { from: 0, to: 1 } } }],
      }),
      403,
      'PERMISSION_DENIED',
      'NOT_ALLOWED',
    );
    expectProblem(
      await viaLink('POST', link.token, `/widgets/${widget('w_count').id}/records`, {}),
      404,
      'NOT_FOUND',
    );
    expectProblem(await viaLink('GET', link.token, '/meta'), 404, 'NOT_FOUND', 'DASHBOARD_LINK');
    expectProblem(await viaLink('POST', link.token, '/records/query', {}), 404, 'NOT_FOUND');

    // allow_filter_controls = false: live filters and control values 403.
    ok(
      await session('u_editor', 'PATCH', `/share-links/${link.id}`, {
        settings: { dashboard: { allow_filter_controls: false } },
      }),
    );
    expectProblem(
      await viaLink('POST', link.token, `/widgets/${widget('w_count').id}/data`, {
        filters: [control('ctl_status', { values: [options['Mới']] })],
      }),
      403,
      'PERMISSION_DENIED',
      'NOT_ALLOWED',
    );
    expectProblem(
      await viaLink('POST', link.token, `/widgets/${widget('ctl_status').id}/options`, {}),
      403,
      'PERMISSION_DENIED',
      'NOT_ALLOWED',
    );
  });

  it('P71: the u_sales1 variant (Sales may share) — numbers of u_sales1, nothing of cost; 410 without D', async () => {
    await setSales(withBaseRule({ share_link: true }));
    try {
      const link = await createDashboardLink('u_sales1');
      const response = ok(await viaLink('GET', link.token, '/dashboard'));
      const shared = sharedDashboardSchema.parse(response.json());
      const byTitle = new Map(shared.widgets.map((item) => [item.title, item]));
      expect(byTitle.get('w_cost')).toMatchObject({ status: 'no_permission', config: null });
      expect(byTitle.get('w_saved_cost')).toMatchObject({ status: 'no_permission', config: null });
      expect(byTitle.get('w_tickets')).toMatchObject({ status: 'no_permission', config: null });
      expect(byTitle.get('ctl_cost')).toMatchObject({ status: 'no_permission', config: null });
      expect(response.body).not.toContain(F('cost'));
      expect(response.body).not.toContain(fx.tickets.id);
      expect(shared.fields.map((field) => field.id)).not.toContain(F('cost'));
      expect((await linkData(link.token, 'w_count')).rows).toEqual([[1]]);
      expectNoPermission(await linkData(link.token, 'w_cost'));
      expectNoPermission(await linkData(link.token, 'w_saved_cost'));

      // The creator loses D: 410.
      await setSales((config) => ({
        ...withBaseRule({ share_link: true })(config),
        dashboards: {},
      }));
      expectProblem(await viaLink('GET', link.token, '/dashboard'), 410, 'SHARE_LINK_GONE');
      expectProblem(
        await viaLink('POST', link.token, `/widgets/${widget('w_count').id}/data`),
        410,
        'SHARE_LINK_GONE',
      );
    } finally {
      await restoreSales();
    }
  });

  it("P72: embedding — org or password links 422; public + intranet framed by that origin; otherwise 'none' + DENY", async () => {
    const embed = { embed: { enabled: true, allowed_origins: [INTRANET] } };
    for (const body of [
      { audience: 'org', settings: embed },
      { audience: 'public', password: 'secret-password-1', settings: embed },
    ]) {
      expectProblem(
        await session('u_editor', 'POST', `/dashboards/${D.id}/share-links`, body),
        422,
        'VALIDATION_FAILED',
        'EMBED_NOT_SUPPORTED',
      );
    }
    const ancestors = (response: Wire) =>
      String(response.headers.get('content-security-policy')).split('; ').at(-1);
    const embedded = await createDashboardLink('u_editor', { settings: embed });
    const page = await viaLink('GET', embedded.token, '/page');
    expect(ancestors(page)).toBe(`frame-ancestors ${INTRANET}`);
    expect(page.headers.get('x-frame-options')).toBeNull();

    const plain = await createDashboardLink('u_editor');
    const closed = await viaLink('GET', plain.token, '/page');
    expect(ancestors(closed)).toBe("frame-ancestors 'none'");
    expect(closed.headers.get('x-frame-options')).toBe('DENY');
  });

  // --- P73 (shl_V) ---------------------------------------------------------------------------

  it('P73: shl_V export — off 403; on: no cost column, only rows of the view filter, audited as the link; Sales link 403; parallel 429', async () => {
    const created = ok(
      await session('u_editor', 'POST', `/views/${viwSales}/share-links`, { audience: 'public' }),
      201,
    );
    const link = createdShareLinkSchema.parse(created.json());
    expectProblem(await viaLink('GET', link.token, '/export'), 403, 'PERMISSION_DENIED');
    ok(
      await session('u_editor', 'PATCH', `/share-links/${link.id}`, {
        settings: { allow_export: true },
      }),
    );
    const [header, ...rows] = csvOf(await viaLink('GET', link.token, '/export'));
    expect(header).not.toContain('cost');
    expect(header).toContain('amount');
    expect(rows.map((row) => row[0]).sort()).toEqual(['r2', 'r3']);
    const audits = await sql<{ actor_type: string; actor_id: string; row_count: number }>`
      SELECT actor_type, actor_id, (after->>'row_count')::int AS row_count FROM meta.audit_logs
       WHERE action = 'export.created' AND after->>'share_link_id' = ${link.id}
    `.execute(db.kysely);
    expect(audits.rows).toEqual([{ actor_type: 'share_link', actor_id: link.id, row_count: 2 }]);

    // An export of the link still running (its Valkey lease): 429 + Retry-After on either instance.
    const held = await a.app.get(ExportLeases).acquire(link.id);
    try {
      const busy = await viaLink('GET', link.token, '/export');
      expectProblem(busy, 429, 'RATE_LIMITED');
      expect(Number(busy.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await held.release();
    }
    ok(await viaLink('GET', link.token, '/export'));

    // A link made by Sales (share_link, no download): 403 even with allow_export.
    // (A view has one live link: this one replaces the editor's.)
    await setSales(withBaseRule({ share_link: true }));
    try {
      const sales = createdShareLinkSchema.parse(
        ok(
          await session('u_sales1', 'POST', `/views/${viwSales}/share-links`, {
            audience: 'public',
            settings: { allow_export: true },
          }),
          201,
        ).json(),
      );
      expectProblem(await viaLink('GET', sales.token, '/export'), 403, 'PERMISSION_DENIED');
    } finally {
      await restoreSales();
    }
  });

  // --- P76 -----------------------------------------------------------------------------------

  it('P76: color rules per reader — u_admin red on cost, u_sales1 and the shl_V viewer never; status green for all; realtime per subscriber', async () => {
    const page = async (user: FixtureUser, viewId: Id<'viw'>) => {
      const response = ok(
        await session(user, 'POST', `${orders()}/query?field_key_type=id`, { view_id: viewId }),
      );
      return {
        body: response.body,
        byId: new Map(
          recordListResponseSchema
            .parse(response.json())
            .records.map((record) => [record.id, record.meta?.color]),
        ),
      };
    };
    const admin = await page('u_admin', viwColor);
    expect(admin.byId.get(r1)).toEqual({ row: RULE.cost });
    expect(admin.byId.get(r2)).toEqual({ row: RULE.done });
    expect(admin.byId.get(r3)).toEqual({ row: RULE.cost });
    const sales = await page('u_sales1', viwColor);
    expect([...sales.byId.keys()]).toEqual([r1]);
    expect(sales.byId.get(r1)?.row).toBeUndefined();
    expect(sales.body).not.toContain(RULE.cost);

    const created = createdShareLinkSchema.parse(
      ok(
        await session('u_editor', 'POST', `/views/${viwSales}/share-links`, {
          audience: 'public',
        }),
        201,
      ).json(),
    );
    const viaShare = ok(
      await viaLink('POST', created.token, '/records/query?field_key_type=id', {}),
    );
    const shared = new Map(
      recordListResponseSchema
        .parse(viaShare.json())
        .records.map((record) => [record.id, record.meta?.color]),
    );
    expect(shared.get(r2)?.row).toBe(RULE.done);
    expect(shared.get(r3)?.row).toBeUndefined();
    expect(viaShare.body).not.toContain(RULE.cost);

    // r1 → Xong: the admin keeps red (first rule), u_sales1 turns green, each on their socket.
    const adminSocket = await watchAs('u_admin');
    const salesSocket = await watchAs('u_sales1');
    for (const socket of [adminSocket, salesSocket]) {
      expect(
        await socket.subscribe(`table:${fx.orders.id}`, 'p76', { view: { id: viwColor } }),
      ).toMatchObject({ type: 'subscribed' });
    }
    ok(
      await session('u_editor', 'PATCH', `${orders()}?field_key_type=id`, {
        records: [{ id: r1, fields: { [F('status')]: options['Xong'] } }],
      }),
    );
    const updated = (message: Message) =>
      message.type === 'record.updated' && message.record_id === r1;
    const toAdmin = await adminSocket.next(updated);
    const toSales = await salesSocket.next(updated);
    expect('meta' in toAdmin ? toAdmin.meta?.color : null).toEqual({ row: RULE.cost });
    expect('meta' in toSales ? toSales.meta?.color : null).toEqual({ row: RULE.done });
    expect(JSON.stringify(toSales)).not.toContain(RULE.cost);
  });

  // --- P77 -----------------------------------------------------------------------------------

  it('P77: tokens — tk_sales_r counts 1; schema:read reads D but no data; tk_admin_b2 404; tk_editor cannot share', async () => {
    const viaB = await bearer(
      tk.sales_r.token,
      'POST',
      `/widgets/${widget('w_count').id}/data`,
      {},
      httpB,
    );
    expect(widgetDataSchema.parse(ok(viaB).json()).rows).toEqual([[1]]);
    ok(await bearer(tk.sales_schema.token, 'GET', `/dashboards/${D.id}`));
    expectScope(
      await bearer(tk.sales_schema.token, 'POST', `/widgets/${widget('w_count').id}/data`),
      'records:read',
    );
    expectProblem(await bearer(tk.admin_b2.token, 'GET', `/dashboards/${D.id}`), 404, 'NOT_FOUND');
    expectProblem(
      await bearer(tk.admin_b2.token, 'POST', `/widgets/${widget('w_count').id}/data`),
      404,
      'NOT_FOUND',
    );
    ok(await bearer(tk.admin_b2.token, 'GET', `/dashboards/${D2.id}`));
    expectScope(
      await bearer(tk.editor.token, 'POST', `/dashboards/${D.id}/share-links`, {
        audience: 'public',
      }),
      'session',
    );
    // tk_sales_w (records:write only) reads no dashboard data.
    expectScope(
      await bearer(tk.sales_w.token, 'POST', `/widgets/${widget('w_count').id}/data`),
      'records:read',
    );
  });

  // --- P75 (last: it signs u_sales1 out everywhere) ---------------------------------------------

  it('P75: password reset — revoke_tokens = false keeps tk_sales_r/w; by default both → 401 TOKEN_REVOKED on A and B, WS 4401 ≤ 1 s, audited', async () => {
    const resetLink = async (body: Record<string, unknown>) => {
      const created = passwordResetLinkSchema.parse(
        ok(
          await session(
            'owner',
            'POST',
            `/orgs/${fx.orgId}/members/${fx.users.u_sales1.id}/password-reset`,
            body,
          ),
          201,
        ).json(),
      );
      return new URL(created.reset_url).pathname.split('/').pop() ?? '';
    };
    const redeem = (token: string, body: Record<string, unknown>) =>
      send(httpB, 'POST', `/api/v1/auth/password-reset/${token}`, {
        body: { password: NEW_PASSWORD, ...body },
      });
    const me = (token: string, origin: string) => bearer(token, 'GET', '/me', undefined, origin);

    // Kept: the admin link and the redemption both say revoke_tokens = false.
    ok(await redeem(await resetLink({ revoke_tokens: false }), { revoke_tokens: false }), 204);
    ok(await me(tk.sales_r.token, httpA));
    ok(
      await bearer(tk.sales_w.token, 'PATCH', orders(), {
        records: [{ id: r1, fields: { amount: 130 } }],
      }),
    );

    // By default (the admin link keeps them, the redemption revokes).
    const onA = await watchWith(tk.sales_r.token, wsA);
    const onB = await watchWith(tk.sales_r.token, wsB);
    expect(await onB.subscribe(`dashboard:${D.id}`)).toMatchObject({ type: 'subscribed' });
    ok(await redeem(await resetLink({ revoke_tokens: false }), {}), 204);
    const since = performance.now();
    for (const socket of [onA, onB]) {
      expect((await socket.closed).code).toBe(REALTIME_CLOSE_CODES.unauthenticated);
    }
    expect(performance.now() - since).toBeLessThan(1_000);
    for (const token of [tk.sales_r, tk.sales_w]) {
      for (const origin of [httpA, httpB]) {
        // Revocation is checked before the scope: 401 even where records:write has no access.
        expectProblem(await me(token.token, origin), 401, 'TOKEN_REVOKED');
      }
    }
    // Other people's tokens keep working.
    ok(await me(tk.editor.token, httpB));
    const audit = await db.kysely
      .selectFrom('meta.audit_logs')
      .select(['organization_id', 'after'])
      .where('action', '=', 'api_token.revoked')
      .where('entity_id', '=', fx.users.u_sales1.id)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      organization_id: fx.orgId,
      after: { reason: 'password_reset', count: 3 },
    });
  });
});
