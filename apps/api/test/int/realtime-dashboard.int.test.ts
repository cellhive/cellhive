/**
 * The `dashboard:{id}` channel over a real WebSocket (BACKLOG T807,
 * CONTRACTS §7, §28.5, P69): subscribing is checked like `GET
 * /dashboards/:id`; record changes of the tables the widgets read arrive as
 * `dashboard.data_changed` hints — table ids only, never a value, a number
 * or a record id — gathered over 5 s per dashboard; configuration changes
 * as `dashboard.changed`; losing `read_only` while subscribed removes the
 * subscription (`error NOT_FOUND`, like every channel, T210).
 */
import {
  createdApiTokenSchema,
  dashboardSchema,
  roleListSchema,
  widgetSchema,
  type ApiTokenScope,
  type DashboardDto,
  type Id,
  type RealtimeServerMessage,
  type RoleDto,
} from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';
import type { LightMyRequestResponse } from 'fastify';

type Message = RealtimeServerMessage;
const DAY_MS = 86_400_000;

describe('realtime dashboard channel (T807, P69)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let url: string;
  let fx: RecordFixture;
  let dashboard: DashboardDto;
  let other: DashboardDto;
  let sales: RoleDto;
  let channel: string;
  let r1: Id<'rec'>, r2: Id<'rec'>;
  const sockets: TestSocket[] = [];

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const ok = (response: LightMyRequestResponse, status = 200) => {
    expect(response.statusCode, response.body).toBe(status);
    return response;
  };
  const setSales = async (dashboards: Record<string, string>) => {
    ok(
      await fx.call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
        config: { ...sales.config, dashboards },
      }),
    );
  };
  const patchOrders = (user: FixtureUser, records: { id: string; fields: object }[]) =>
    fx.call(user, 'PATCH', `/tables/${fx.orders.id}/records`, { records });
  async function watch(user: FixtureUser, options: { authorization?: string } = {}) {
    const socket = await TestSocket.connect(
      url,
      options.authorization === undefined
        ? { origin: TEST_PUBLIC_URL, cookie: await fx.cookie(user) }
        : { authorization: options.authorization },
    );
    sockets.push(socket);
    return socket;
  }
  async function tokenOf(user: FixtureUser, scopes: ApiTokenScope[], baseIds?: Id<'bse'>[]) {
    const response = ok(
      await fx.call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
        name: `${user} ${scopes.join(' ')} ${String(Math.random())}`,
        scopes,
        ...(baseIds === undefined ? {} : { base_ids: baseIds }),
        expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      }),
      201,
    );
    return createdApiTokenSchema.parse(response.json()).token;
  }
  const dataChanged = (message: Message) => message.type === 'dashboard.data_changed';

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    const created = ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records?typecast=true`, {
        records: [
          { fields: { title: 'r1', amount: 100, cost: 10, owner: [{ id: fx.users.u_sales1.id }] } },
          { fields: { title: 'r2', amount: 200, cost: 20, owner: [{ id: fx.users.u_sales2.id }] } },
        ],
      }),
      201,
    ).json<{ records: { id: Id<'rec'> }[] }>();
    [r1, r2] = created.records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>];

    const newDashboard = async (name: string) =>
      dashboardSchema.parse(
        ok(await fx.call('owner', 'POST', `/bases/${fx.baseId}/dashboards`, { name }), 201).json(),
      );
    dashboard = await newDashboard('Live');
    other = await newDashboard('Other');
    channel = `dashboard:${dashboard.id}`;
    const addWidget = async (target: DashboardDto, tableId: Id<'tbl'>) =>
      widgetSchema.parse(
        ok(
          await fx.call('owner', 'POST', `/dashboards/${target.id}/widgets`, {
            type: 'kpi',
            config: { table_id: tableId, metrics: [{ id: 'm1', aggregation: 'count' }] },
          }),
          201,
        ).json(),
      );
    await addWidget(dashboard, fx.orders.id);
    // Sales does not see Customers: changes there are never named to them.
    await addWidget(dashboard, fx.customers.id);
    await addWidget(other, fx.tickets.id);

    sales = roleListSchema
      .parse(ok(await fx.call('owner', 'GET', `/bases/${fx.baseId}/roles`)).json())
      .items.find((role) => role.name === 'Sales') as RoleDto;
  }, 180_000);

  afterAll(async () => {
    await closeSockets(sockets);
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('subscribing is checked like reading the dashboard (404 otherwise)', async () => {
    const sales1 = await watch('u_sales1');
    // Sales without `dashboards.D`, another org, a dashboard that does not exist.
    expect(await sales1.subscribe(channel)).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    const stranger = await watch('stranger');
    expect(await stranger.subscribe(channel)).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    expect(await sales1.subscribe('dashboard:dsh_T807NoSuchDash01')).toMatchObject({
      type: 'error',
      code: 'NOT_FOUND',
    });
    // `dashboards.D = read_only` → readable.
    await setSales({ [dashboard.id]: 'read_only' });
    expect(await sales1.subscribe(channel)).toMatchObject({ type: 'subscribed', channel });
    expect(await sales1.subscribe(`dashboard:${other.id}`)).toMatchObject({
      type: 'error',
      code: 'NOT_FOUND',
    });
    const reader = await watch('u_reader');
    expect(await reader.subscribe(channel)).toMatchObject({ type: 'subscribed' });
  });

  it('API tokens: records:read inside base_ids only', async () => {
    const readToken = await tokenOf('u_sales1', ['records:read']);
    const viaToken = await watch('u_sales1', { authorization: `Bearer ${readToken}` });
    expect(await viaToken.subscribe(channel)).toMatchObject({ type: 'subscribed' });

    const schemaOnly = await tokenOf('u_sales1', ['schema:read']);
    const noScope = await watch('u_sales1', { authorization: `Bearer ${schemaOnly}` });
    expect(await noScope.subscribe(channel)).toMatchObject({
      type: 'error',
      code: 'INSUFFICIENT_SCOPE',
    });

    // A token of the owner limited to another base (B2): the dashboard does not exist for it.
    const workspaces = ok(await fx.call('owner', 'GET', `/orgs/${fx.orgId}/workspaces`)).json<{
      items: { id: string }[];
    }>();
    const b2 = ok(
      await fx.call('owner', 'POST', `/workspaces/${workspaces.items[0]?.id ?? ''}/bases`, {
        name: 'B2',
      }),
      201,
    ).json<{ id: Id<'bse'> }>();
    const outside = await tokenOf('owner', ['records:read'], [b2.id]);
    const elsewhere = await watch('owner', { authorization: `Bearer ${outside}` });
    expect(await elsewhere.subscribe(channel)).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
    const inside = await tokenOf('owner', ['records:read'], [fx.baseId]);
    const here = await watch('owner', { authorization: `Bearer ${inside}` });
    expect(await here.subscribe(channel)).toMatchObject({ type: 'subscribed' });
  });

  it('a record write gives a hint without values within 6 s; tables the subscriber cannot see are never named', async () => {
    const sales1 = await watch('u_sales1');
    const admin = await watch('u_admin');
    expect(await sales1.subscribe(channel)).toMatchObject({ type: 'subscribed' });
    expect(await admin.subscribe(channel)).toMatchObject({ type: 'subscribed' });

    const started = Date.now();
    ok(await patchOrders('u_editor', [{ id: r2, fields: { amount: 222, cost: 33 } }]));
    const hint = await sales1.next(dataChanged, 10_000);
    expect(Date.now() - started).toBeLessThanOrEqual(6_000);
    expect(hint).toEqual({
      type: 'dashboard.data_changed',
      channel,
      dashboard_id: dashboard.id,
      table_ids: [fx.orders.id],
    });
    // Nothing of the record: no amount, no cost, no record id.
    const text = JSON.stringify(hint);
    for (const forbidden of [r2, '222', '33', F('amount'), F('cost')]) {
      expect(text).not.toContain(forbidden);
    }
    expect(await admin.next(dataChanged, 10_000)).toMatchObject({ table_ids: [fx.orders.id] });

    // Customers: the admin learns it changed, u_sales1 (no access) never does.
    ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records?field_key_type=id`, {
        records: [{ fields: { [F('customerName')]: 'An Phát' } }],
      }),
      201,
    );
    expect(await admin.next(dataChanged, 10_000)).toMatchObject({
      table_ids: [fx.customers.id],
    });
    await sales1.expectNone(dataChanged, 300);
    // Tickets: no widget of this dashboard reads it.
    ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/records?field_key_type=id`, {
        records: [{ fields: { [F('ticketTitle')]: 'T' } }],
      }),
      201,
    );
    await admin.expectNone(dataChanged, 6_000);
  });

  it('50 writes in 5 s give one or two messages', async () => {
    const sales1 = await watch('u_sales1');
    expect(await sales1.subscribe(channel)).toMatchObject({ type: 'subscribed' });
    const started = Date.now();
    for (let index = 0; index < 50; index += 1) {
      ok(await patchOrders('u_editor', [{ id: r1, fields: { amount: 1_000 + index } }]));
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000);
    // Let the last gathering window close.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const hints = sales1.received.filter(dataChanged);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints.length).toBeLessThanOrEqual(2);
  });

  it('configuration changes send dashboard.changed with the new version', async () => {
    const reader = await watch('u_reader');
    expect(await reader.subscribe(channel)).toMatchObject({ type: 'subscribed' });
    const renamed = dashboardSchema.parse(
      ok(await fx.call('owner', 'PATCH', `/dashboards/${dashboard.id}`, { name: 'Live 2' })).json(),
    );
    expect(await reader.next((message) => message.type === 'dashboard.changed', 10_000)).toEqual({
      type: 'dashboard.changed',
      channel,
      dashboard_id: dashboard.id,
      version: renamed.version,
    });
    // A widget added on Tickets: its record changes now reach the channel.
    const widget = widgetSchema.parse(
      ok(
        await fx.call('owner', 'POST', `/dashboards/${dashboard.id}/widgets`, {
          type: 'kpi',
          config: { table_id: fx.tickets.id, metrics: [{ id: 'm1', aggregation: 'count' }] },
        }),
        201,
      ).json(),
    );
    expect(
      await reader.next((message) => message.type === 'dashboard.changed', 10_000),
    ).toMatchObject({ version: renamed.version + 1 });
    ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/records?field_key_type=id`, {
        records: [{ fields: { [F('ticketTitle')]: 'T' } }],
      }),
      201,
    );
    expect(await reader.next(dataChanged, 10_000)).toMatchObject({ table_ids: [fx.tickets.id] });
    ok(await fx.call('owner', 'DELETE', `/widgets/${widget.id}`), 204);
  });

  it('losing read_only while subscribed removes the subscription', async () => {
    const sales1 = await watch('u_sales1');
    expect(await sales1.subscribe(channel)).toMatchObject({ type: 'subscribed' });
    await setSales({});
    expect(
      await sales1.next((message) => message.type === 'error' && message.channel === channel),
    ).toEqual({ type: 'error', req_id: null, code: 'NOT_FOUND', channel });
    // Nothing more reaches it.
    ok(await patchOrders('u_editor', [{ id: r1, fields: { amount: 7 } }]));
    await sales1.expectNone(dataChanged, 6_000);
  });

  it('a dashboard moved to the trash removes its subscriptions', async () => {
    const reader = await watch('u_reader');
    expect(await reader.subscribe(channel)).toMatchObject({ type: 'subscribed' });
    ok(await fx.call('owner', 'DELETE', `/dashboards/${dashboard.id}`), 204);
    expect(
      await reader.next((message) => message.type === 'error' && message.channel === channel),
    ).toEqual({ type: 'error', req_id: null, code: 'NOT_FOUND', channel });
  });
});
