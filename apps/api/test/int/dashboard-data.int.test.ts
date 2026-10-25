/**
 * `POST /widgets/{id}/data` over HTTP (BACKLOG T806, CONTRACTS §28.3): P21
 * (u_sales1 counts only r1), P66 (a widget on a hidden field, or a saved
 * filter on one, is `no_permission` with no number), P67 (a link dimension
 * needs the linked table; API tokens with `records:read`), `404` for
 * dashboards the caller cannot read, the link read rule of T710 and the
 * metric `dashboard_widget_query_seconds`.
 */
import {
  createdApiTokenSchema,
  dashboardSchema,
  recordsResponseSchema,
  roleListSchema,
  widgetDataSchema,
  widgetSchema,
  type ApiTokenScope,
  type DashboardDto,
  type Id,
  type RoleDto,
  type WidgetDataDto,
  type WidgetDto,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MetricsService } from '../../src/modules/metrics/metrics.service.js';

import { uniqueIp } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const DAY_MS = 86_400_000;

describe('Widget data: one entry point with the viewer permissions (T806, P21, P66, P67)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let dashboard: DashboardDto;
  let sales: RoleDto;
  let customerField: Id<'fld'>;
  let customers: Id<'rec'>[];
  const w: Record<string, WidgetDto> = {};

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const ok = (response: LightMyRequestResponse, status = 200) => {
    expect(response.statusCode, response.body).toBe(status);
    return response;
  };
  const data = (user: FixtureUser, widget: WidgetDto, body?: unknown) =>
    fx.call(user, 'POST', `/widgets/${widget.id}/data`, body);
  const dataOf = async (user: FixtureUser, widget: WidgetDto, body?: unknown) =>
    widgetDataSchema.parse(ok(await data(user, widget, body)).json());
  const addWidget = async (type: string, config: Record<string, unknown>) =>
    widgetSchema.parse(
      ok(
        await fx.call('owner', 'POST', `/dashboards/${dashboard.id}/widgets`, {
          type,
          title: type,
          config: { table_id: fx.orders.id, ...config },
        }),
        201,
      ).json(),
    );
  const setSales = async (config: RoleDto['config']) => {
    ok(await fx.call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, { config }));
  };

  async function tokenOf(user: FixtureUser, scopes: ApiTokenScope[]): Promise<string> {
    const response = ok(
      await fx.call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
        name: `${user} ${scopes.join(' ')}`,
        scopes,
        expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      }),
      201,
    );
    return createdApiTokenSchema.parse(response.json()).token;
  }
  const withToken = (token: string, widget: WidgetDto) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/widgets/${widget.id}/data`,
      remoteAddress: uniqueIp(),
      headers: { authorization: `Bearer ${token}` },
    });

  /** No number of any kind in a `no_permission` answer. */
  const expectNoPermission = (result: WidgetDataDto) => {
    expect(result).toMatchObject({ status: 'no_permission', columns: [], rows: [] });
    expect(result.total).toBeUndefined();
    expect(result.other).toBeUndefined();
    expect(result.compare).toBeUndefined();
  };

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);

    customerField = ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'customer',
        type: 'link',
        options: { link_table: fx.customers.id },
      }),
      201,
    ).json<{ id: Id<'fld'> }>().id;
    customers = recordsResponseSchema
      .parse(
        ok(
          await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
            records: [{ fields: { Tên: 'An Phát' } }, { fields: { Tên: 'Bình Minh' } }],
          }),
          201,
        ).json(),
      )
      .records.map((record) => record.id);
    ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records?typecast=true`, {
        records: [
          {
            fields: {
              title: 'r1',
              amount: 100,
              cost: 10,
              status: 'Mới',
              owner: [{ id: fx.users.u_sales1.id }],
              customer: [customers[0]],
            },
          },
          {
            fields: {
              title: 'r2',
              amount: 200,
              cost: 20,
              status: 'Xong',
              owner: [{ id: fx.users.u_sales2.id }],
              customer: [customers[1]],
            },
          },
          { fields: { title: 'r3', amount: 300, cost: 30, status: 'Mới' } },
        ],
      }),
      201,
    );

    dashboard = dashboardSchema.parse(
      ok(
        await fx.call('owner', 'POST', `/bases/${fx.baseId}/dashboards`, { name: 'Sales' }),
        201,
      ).json(),
    );
    const count = [{ id: 'm1', aggregation: 'count' }];
    w['count'] = await addWidget('kpi', { metrics: count });
    w['cost'] = await addWidget('kpi', {
      metrics: [{ id: 'm1', aggregation: 'sum', field: F('cost') }],
    });
    w['savedCost'] = await addWidget('kpi', {
      metrics: count,
      filter: { op: 'and', items: [{ field: F('cost'), operator: 'gt', value: 15 }] },
    });
    w['status'] = await addWidget('bar', { dimension: { field: F('status') }, metrics: count });
    w['customer'] = await addWidget('pie', { dimension: { field: customerField }, metrics: count });
    w['records'] = await addWidget('table', {
      table: { mode: 'records', fields: [F('title'), F('amount')] },
    });
    w['text'] = widgetSchema.parse(
      ok(
        await fx.call('owner', 'POST', `/dashboards/${dashboard.id}/widgets`, {
          type: 'text',
          config: { markdown: 'Hello' },
        }),
        201,
      ).json(),
    );

    const roles = roleListSchema.parse(
      ok(await fx.call('owner', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    );
    sales = roles.items.find((role) => role.name === 'Sales') as RoleDto;
  }, 120_000);

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('404 for a dashboard the caller cannot read, before anything is computed', async () => {
    for (const user of ['u_sales1', 'u_out', 'stranger'] as const) {
      expectProblem(await data(user, w['count'] as WidgetDto), 404, 'NOT_FOUND');
    }
    expectProblem(
      await fx.call('u_admin', 'POST', '/widgets/wgt_T806NoSuchWdgt01/data'),
      404,
      'NOT_FOUND',
    );
    await setSales({ ...sales.config, dashboards: { [dashboard.id]: 'read_only' } });
  });

  it('P21: u_sales1 counts only r1, u_admin all three', async () => {
    const admin = await dataOf('u_admin', w['count'] as WidgetDto);
    expect(admin).toMatchObject({ status: 'ok', rows: [[3]], cache: 'miss' });
    expect(Date.parse(admin.computed_at)).not.toBeNaN();
    expect((await dataOf('u_sales1', w['count'] as WidgetDto)).rows).toEqual([[1]]);
    expect((await dataOf('u_sales2', w['count'] as WidgetDto)).rows).toEqual([[1]]);
    const byStatus = await dataOf('u_sales1', w['status'] as WidgetDto, { filters: [] });
    expect(byStatus.rows).toEqual([[expect.objectContaining({ label: 'Mới' }), 1]]);
    expect(byStatus.total).toEqual([1]);
    const records = await dataOf('u_sales1', w['records'] as WidgetDto);
    expect(records.rows.map((row) => row.slice(1))).toEqual([['r1', 100]]);
  });

  it('P66: a hidden field, in a metric or in the saved filter, is no_permission without numbers', async () => {
    expectNoPermission(await dataOf('u_sales1', w['cost'] as WidgetDto));
    expectNoPermission(await dataOf('u_sales1', w['savedCost'] as WidgetDto));
    expect((await dataOf('u_admin', w['cost'] as WidgetDto)).rows).toEqual([[60]]);
    expect((await dataOf('u_admin', w['savedCost'] as WidgetDto)).rows).toEqual([[2]]);
  });

  it('P67: a link dimension needs the linked table; tokens follow their user', async () => {
    expectNoPermission(await dataOf('u_sales1', w['customer'] as WidgetDto));
    const admin = await dataOf('u_admin', w['customer'] as WidgetDto);
    expect(admin.rows).toHaveLength(3);
    expect(admin.columns[0]).toMatchObject({ role: 'dimension', field_type: 'link' });

    const salesReader = await tokenOf('u_sales1', ['records:read']);
    const viaToken = widgetDataSchema.parse(
      ok(await withToken(salesReader, w['count'] as WidgetDto)).json(),
    );
    expect(viaToken.rows).toEqual([[1]]);
    const schemaOnly = await tokenOf('u_sales1', ['schema:read']);
    expectProblem(await withToken(schemaOnly, w['count'] as WidgetDto), 403, 'INSUFFICIENT_SCOPE');
  });

  it('a read rule on a link field (T710) applies to the numbers', async () => {
    await setSales({
      ...sales.config,
      dashboards: { [dashboard.id]: 'read_only' },
      tables: {
        [fx.orders.id]: {
          perm: 'read_only',
          record_rule: {
            operations: [],
            edit_filter: null,
            read_scope: 'filter',
            read_filter: {
              op: 'and',
              items: [{ field: customerField, operator: 'has_any_of', value: [customers[1]] }],
            },
          },
        },
        [fx.customers.id]: { perm: 'read_only' },
      },
    });
    try {
      expect((await dataOf('u_sales1', w['count'] as WidgetDto)).rows).toEqual([[1]]);
      const byCustomer = await dataOf('u_sales1', w['customer'] as WidgetDto);
      expect(byCustomer.rows).toEqual([[{ value: customers[1], label: 'Bình Minh' }, 1]]);
      // `cost` is readable under this variant.
      expect((await dataOf('u_sales1', w['cost'] as WidgetDto)).rows).toEqual([[20]]);
    } finally {
      await setSales({ ...sales.config, dashboards: { [dashboard.id]: 'read_only' } });
    }
  });

  it('validates the request; text widgets have no data', async () => {
    const problem = await data('u_admin', w['text'] as WidgetDto);
    expectProblem(problem, 422, 'VALIDATION_FAILED');
    expect(
      (problemOf(problem.body)['errors'] as { code: string }[]).map((item) => item.code),
    ).toEqual(['UNKNOWN_WIDGET']);
    expectProblem(
      await data('u_admin', w['count'] as WidgetDto, { filters: [{ widget_id: 'x' }] }),
      422,
      'VALIDATION_FAILED',
    );
    expectProblem(
      await data('u_admin', w['count'] as WidgetDto, { timezone: 'Mars/Olympus' }),
      422,
      'VALIDATION_FAILED',
    );
    expect((await dataOf('u_admin', w['count'] as WidgetDto, { timezone: 'UTC' })).rows).toEqual([
      [3],
    ]);
  });

  it('QA S7 (T819): a zone Postgres only knows by its IANA name (Chrome: Asia/Saigon) buckets dates', async () => {
    // `postgres:18` (Debian 13) has no tzdata `backward` names: `Asia/Saigon` used
    // to reach `date_trunc(…, 'Asia/Saigon')` and answer 500 INTERNAL.
    const ordered = ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'ordered',
        type: 'datetime',
        // No zone of its own: the viewer's (then the organization's) applies.
        options: { style: { format: 'yyyy-MM-dd HH:mm' } },
      }),
      201,
    ).json<{ id: Id<'fld'> }>();
    const rows = ok(await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/records`)).json<{
      records: { id: Id<'rec'> }[];
    }>().records;
    ok(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records`, {
        records: rows.map((record) => ({
          id: record.id,
          // 31 Oct 2026 20:00 UTC = 1 Nov 03:00 in Vietnam.
          fields: { ordered: '2026-10-31T20:00:00.000Z' },
        })),
      }),
    );
    const byMonth = await addWidget('bar', {
      dimension: { field: ordered.id, date_bucket: 'month' },
      metrics: [{ id: 'm1', aggregation: 'count' }],
    });
    const compare = await addWidget('kpi', {
      metrics: [{ id: 'm1', aggregation: 'count' }],
      compare: { mode: 'previous_period', date_field: ordered.id, range: 'month' },
    });

    // The viewer's zone as Chrome reports it, then a legacy zone stored on the
    // organization before T819 (no zone in the request: the organization's).
    expect((await dataOf('u_admin', byMonth, { timezone: 'Asia/Saigon' })).status).toBe('ok');
    // Nothing ordered this month yet: `empty`, computed (200), not 500.
    expect((await dataOf('u_admin', compare, { timezone: 'Asia/Calcutta' })).status).toBe('empty');
    await db.kysely
      .updateTable('meta.organizations')
      .set({ settings: { timezone: 'Asia/Saigon' } })
      .where('id', '=', fx.orgId)
      .execute();
    const legacy = await dataOf('u_admin', byMonth);
    expect(legacy.status).toBe('ok');
    // Bucketed in Vietnam: November, not October.
    expect(JSON.stringify(legacy.rows)).toContain('2026-11-01');
    expect((await dataOf('u_admin', compare)).status).toBe('empty');
  });

  it('records dashboard_widget_query_seconds by type and status', async () => {
    const response = await t.app.get(MetricsService).render();
    expect(response.body).toMatch(
      /dashboard_widget_query_seconds_count\{type="kpi",status="no_permission"\} \d+/u,
    );
    expect(response.body).toMatch(
      /dashboard_widget_query_seconds_count\{type="kpi",status="ok"\} \d+/u,
    );
  });
});
