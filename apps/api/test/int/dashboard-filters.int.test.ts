/**
 * Live filters, filter control values, click-through and widget CSV over
 * HTTP (BACKLOG T808, CONTRACTS §28.4, §28.6): P70 — a control or global
 * filter on a field the viewer cannot read (`cost` for u_sales1) is set
 * aside (`ignored_filters: no_permission`) and the numbers do not change; a
 * free or undeclared filter is `422`; a cross-filter filters every widget of
 * the same table and is `ignored_filters: other_table` elsewhere; cascading
 * slicers offer only values of the parent's selection among the records the
 * viewer reads; click-through lists only those records, without hidden
 * fields — and P74: CSV needs `base_rule.download`, is the aggregate table,
 * audited with `row_count`.
 */
import {
  createdApiTokenSchema,
  dashboardSchema,
  roleListSchema,
  widgetDataSchema,
  widgetOptionsSchema,
  widgetRecordsSchema,
  widgetSchema,
  type ApiTokenScope,
  type DashboardDto,
  type Id,
  type RoleDto,
  type WidgetDto,
  type WidgetOptionsDto,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

describe('Dashboard live filters, slicers, click-through and CSV (T808, P70, P74)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let dashboard: DashboardDto;
  let sales: RoleDto;
  const fields: Record<string, Id<'fld'>> = {};
  const options: Record<string, string> = {};
  const w: Record<string, WidgetDto> = {};

  const F = (name: string) => (fields[name] ?? fx.fld[name]?.id) as Id<'fld'>;
  const ok = (response: LightMyRequestResponse, status = 200) => {
    expect(response.statusCode, response.body).toBe(status);
    return response;
  };
  const widget = (name: string) => w[name] as WidgetDto;
  const dataOf = async (user: FixtureUser, name: string, filters: unknown[] = []) =>
    widgetDataSchema.parse(
      ok(await fx.call(user, 'POST', `/widgets/${widget(name).id}/data`, { filters })).json(),
    );
  const optionsOf = async (
    user: FixtureUser,
    name: string,
    body: Record<string, unknown> = {},
  ): Promise<WidgetOptionsDto> =>
    widgetOptionsSchema.parse(
      ok(await fx.call(user, 'POST', `/widgets/${widget(name).id}/options`, body)).json(),
    );
  const recordsOf = async (user: FixtureUser, name: string, body: Record<string, unknown>) =>
    widgetRecordsSchema.parse(
      ok(await fx.call(user, 'POST', `/widgets/${widget(name).id}/records`, body)).json(),
    );
  const control = (name: string, value: unknown) => ({
    source: 'control',
    widget_id: widget(name).id,
    value,
  });
  const addWidget = async (name: string, type: string, config: Record<string, unknown>) => {
    w[name] = widgetSchema.parse(
      ok(
        await fx.call('owner', 'POST', `/dashboards/${dashboard.id}/widgets`, {
          type,
          title: name,
          config,
        }),
        201,
      ).json(),
    );
  };
  const addField = async (name: string, type: string, fieldOptions: unknown = {}) => {
    const response = ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name,
        type,
        options: fieldOptions,
      }),
      201,
    ).json<{ id: Id<'fld'>; options: { options?: { id: string; name: string }[] } }>();
    fields[name] = response.id;
    for (const option of response.options.options ?? []) options[option.name] = option.id;
  };
  const codesOf = (response: LightMyRequestResponse) =>
    (problemOf(response.body)['errors'] as { code: string; path: string }[]).map(
      (item) => item.code,
    );
  const labels = (result: WidgetOptionsDto) => result.items.map((item) => item.label ?? item.value);

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

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);

    await addField('province', 'select', {
      options: [{ name: 'Hà Nội' }, { name: 'Hồ Chí Minh' }],
    });
    await addField('district', 'select', {
      options: [{ name: 'Ba Đình' }, { name: 'Cầu Giấy' }, { name: 'Quận 1' }, { name: 'Quận 3' }],
    });
    await addField('ordered_on', 'datetime', { style: { format: 'dd/MM/yyyy' } });
    await addField('note', 'text');
    const order = (
      title: string,
      owner: FixtureUser | null,
      status: string,
      cost: number,
      province: string,
      district: string,
      day: string,
    ) => ({
      fields: {
        title,
        amount: cost * 10,
        cost,
        status,
        owner: owner === null ? [] : [{ id: fx.users[owner].id }],
        province,
        district,
        ordered_on: day,
        note: `note ${title}`,
      },
    });
    ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records?typecast=true`, {
        records: [
          order('r1', 'u_sales1', 'Mới', 10, 'Hà Nội', 'Ba Đình', '2026-10-01'),
          order('r2', 'u_sales2', 'Xong', 20, 'Hà Nội', 'Cầu Giấy', '2026-10-05'),
          order('r3', null, 'Mới', 30, 'Hồ Chí Minh', 'Quận 1', '2026-09-20'),
          order('r4', 'u_sales1', 'Xong', 2000, 'Hồ Chí Minh', 'Quận 3', '2026-08-15'),
        ],
      }),
      201,
    );
    const statusOptions = (fx.fld['status']?.options as { options: { id: string; name: string }[] })
      .options;
    for (const option of statusOptions) options[option.name] = option.id;

    dashboard = dashboardSchema.parse(
      ok(
        await fx.call('owner', 'POST', `/bases/${fx.baseId}/dashboards`, {
          name: 'Filters',
          global_filters: [
            {
              id: 'period',
              kind: 'date_range',
              targets: [{ table_id: fx.orders.id, field: F('ordered_on') }],
            },
            {
              id: 'spend',
              kind: 'number_range',
              targets: [{ table_id: fx.orders.id, field: F('cost') }],
            },
          ],
        }),
        201,
      ).json(),
    );
    const orders = fx.orders.id;
    const controlConfig = (field: string, kind: string, extra: Record<string, unknown> = {}) => ({
      table_id: orders,
      field: F(field),
      control: kind,
      ...extra,
    });
    await addWidget('ctl_status', 'filter_control', controlConfig('status', 'select'));
    await addWidget('ctl_cost', 'filter_control', controlConfig('cost', 'number_range'));
    await addWidget('ctl_province', 'filter_control', controlConfig('province', 'select'));
    await addWidget(
      'ctl_district',
      'filter_control',
      controlConfig('district', 'select', { parent_control_id: widget('ctl_province').id }),
    );
    await addWidget('ctl_owner', 'filter_control', controlConfig('owner', 'user'));
    await addWidget('ctl_note', 'filter_control', controlConfig('note', 'text'));
    await addWidget('ctl_ticket', 'filter_control', {
      table_id: fx.tickets.id,
      field: F('ticketStatus'),
      control: 'select',
    });
    const count = [{ id: 'm1', aggregation: 'count' }];
    const bindings = ['ctl_status', 'ctl_cost', 'ctl_province', 'ctl_ticket'].map(
      (name) => widget(name).id,
    );
    await addWidget('w_count', 'kpi', {
      table_id: orders,
      metrics: count,
      filter_bindings: bindings,
    });
    await addWidget('w_status', 'bar', {
      table_id: orders,
      dimension: { field: F('status') },
      metrics: [
        { id: 'm1', aggregation: 'count', label: 'Orders' },
        { id: 'm2', aggregation: 'sum', field: F('amount') },
      ],
      filter_bindings: [widget('ctl_status').id],
    });
    await addWidget('w_by_owner', 'bar', {
      table_id: orders,
      dimension: { field: F('status') },
      series_dimension: { field: F('owner') },
      metrics: count,
    });
    await addWidget('w_owner', 'pie', {
      table_id: orders,
      dimension: { field: F('owner') },
      metrics: count,
    });
    await addWidget('w_tickets', 'kpi', { table_id: fx.tickets.id, metrics: count });
    await addWidget('w_records', 'table', {
      table_id: orders,
      table: { mode: 'records', fields: [F('title')] },
    });

    const roles = roleListSchema.parse(
      ok(await fx.call('owner', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    );
    sales = roles.items.find((role) => role.name === 'Sales') as RoleDto;
    const tables = sales.config['tables'] as Record<string, unknown>;
    const orderRule = tables[fx.orders.id] as {
      field_rule: { fields: Record<string, string> };
    };
    ok(
      await fx.call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
        config: {
          ...sales.config,
          dashboards: { [dashboard.id]: 'read_only' },
          tables: {
            ...tables,
            [fx.orders.id]: {
              ...orderRule,
              field_rule: {
                ...orderRule.field_rule,
                fields: { ...orderRule.field_rule.fields, [F('note')]: 'no_perm' },
              },
            },
          },
        },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('P70: a control or global filter on a hidden field is set aside, numbers unchanged', async () => {
    const plain = await dataOf('u_sales1', 'w_count');
    expect(plain.rows).toEqual([[2]]);
    expect(plain.ignored_filters).toEqual([]);

    const costRange = control('ctl_cost', { range: { from: 0, to: 1000 } });
    const viaControl = await dataOf('u_sales1', 'w_count', [costRange]);
    expect(viaControl.rows).toEqual([[2]]);
    expect(viaControl.ignored_filters).toEqual([
      { source: 'control', id: widget('ctl_cost').id, reason: 'no_permission' },
    ]);
    const spend = { source: 'global', id: 'spend', value: { range: { from: 0, to: 1000 } } };
    const viaGlobal = await dataOf('u_sales1', 'w_count', [spend]);
    expect(viaGlobal.rows).toEqual([[2]]);
    expect(viaGlobal.ignored_filters).toEqual([
      { source: 'global', id: 'spend', reason: 'no_permission' },
    ]);
    // The admin reads `cost`: r4 (2 000) is filtered out.
    expect((await dataOf('u_admin', 'w_count', [costRange])).rows).toEqual([[3]]);
    expect((await dataOf('u_admin', 'w_count', [spend])).rows).toEqual([[3]]);
    // An upper bound so low nothing matches: the viewer still sees their own count.
    const nothing = control('ctl_cost', { range: { from: null, to: 0 } });
    expect((await dataOf('u_admin', 'w_count', [nothing])).status).toBe('empty');
    expect((await dataOf('u_sales1', 'w_count', [nothing])).rows).toEqual([[2]]);
  });

  it('QA S7 (T819): the default of a control on a hidden field is not sent to that viewer', async () => {
    const config = (name: string) => widget(name).config;
    ok(
      await fx.call('owner', 'PATCH', `/widgets/${widget('ctl_cost').id}`, {
        config: { ...config('ctl_cost'), default: { range: { from: 50_000, to: null } } },
      }),
    );
    ok(
      await fx.call('owner', 'PATCH', `/widgets/${widget('ctl_status').id}`, {
        config: { ...config('ctl_status'), default: { values: [options['Xong']] } },
      }),
    );
    const defaults = async (user: FixtureUser) => {
      const read = dashboardSchema.parse(
        ok(await fx.call(user, 'GET', `/dashboards/${dashboard.id}`)).json(),
      );
      const of = (name: string) =>
        (
          read.widgets.find((item) => item.id === widget(name).id)?.config as {
            default?: unknown;
          }
        ).default;
      return { cost: of('ctl_cost'), status: of('ctl_status') };
    };
    expect(await defaults('u_admin')).toEqual({
      cost: { range: { from: 50_000, to: null } },
      status: { values: [options['Xong']] },
    });
    // u_sales1 cannot read `cost`: its stored range is not theirs to see.
    expect(await defaults('u_sales1')).toEqual({
      cost: null,
      status: { values: [options['Xong']] },
    });
    for (const name of ['ctl_cost', 'ctl_status']) {
      ok(
        await fx.call('owner', 'PATCH', `/widgets/${widget(name).id}`, {
          config: { ...config(name), default: null },
        }),
      );
    }
  });

  it('P70: a free or undeclared filter is 422 and nothing is applied', async () => {
    const url = `/widgets/${widget('w_count').id}/data`;
    const cases: { filters: unknown[]; code: string }[] = [
      {
        filters: [{ field: F('cost'), operator: 'gt', value: 100 }],
        code: 'INVALID_UNION',
      },
      {
        filters: [
          {
            source: 'control',
            widget_id: widget('ctl_cost').id,
            value: { range: { from: 0, to: 1 } },
            filter: {},
          },
        ],
        code: 'UNRECOGNIZED_KEY',
      },
      {
        filters: [{ source: 'global', id: 'nope', value: { values: [] } }],
        code: 'UNKNOWN_FILTER',
      },
      {
        filters: [{ source: 'control', widget_id: widget('w_status').id, value: { values: [] } }],
        code: 'UNKNOWN_WIDGET',
      },
      {
        filters: [{ source: 'cross', widget_id: widget('w_count').id, value: 'x' }],
        code: 'UNKNOWN_WIDGET',
      },
      {
        filters: [control('ctl_status', { range: { from: 1, to: 2 } })],
        code: 'INVALID_FILTER_VALUE',
      },
      {
        filters: [control('ctl_status', { values: ['opt_NoSuchOption0001'] })],
        code: 'INVALID_FILTER_VALUE',
      },
      {
        filters: [{ source: 'cross', widget_id: widget('w_status').id, value: 42 }],
        code: 'INVALID_FILTER_VALUE',
      },
      {
        filters: [
          control('ctl_cost', { range: { from: 0, to: 1 } }),
          control('ctl_cost', { range: { from: 0, to: 2 } }),
        ],
        code: 'CUSTOM',
      },
    ];
    for (const { filters, code } of cases) {
      const response = await fx.call('u_admin', 'POST', url, { filters });
      expectProblem(response, 422, 'VALIDATION_FAILED');
      if (code !== 'CUSTOM' && code !== 'INVALID_UNION') expect(codesOf(response)).toContain(code);
    }
  });

  it('P70: a cross-filter filters every widget of the source table, other tables say so', async () => {
    const urgent = { source: 'cross', widget_id: widget('w_status').id, value: options['Mới'] };
    expect((await dataOf('u_admin', 'w_count', [urgent])).rows).toEqual([[2]]);
    expect((await dataOf('u_sales1', 'w_count', [urgent])).rows).toEqual([[1]]);
    const byOwner = await dataOf('u_admin', 'w_by_owner', [urgent]);
    expect(
      byOwner.rows.every((row) => (row[0] as { value: unknown }).value === options['Mới']),
    ).toBe(true);
    // The source widget keeps every group; another table is not filtered.
    const self = await dataOf('u_admin', 'w_status', [urgent]);
    expect(self.rows).toHaveLength(2);
    expect(self.ignored_filters).toEqual([
      { source: 'cross', id: widget('w_status').id, reason: 'self' },
    ]);
    const tickets = await dataOf('u_admin', 'w_tickets', [urgent]);
    expect(tickets.ignored_filters).toEqual([
      { source: 'cross', id: widget('w_status').id, reason: 'other_table' },
    ]);
    expect(tickets.rows).toEqual((await dataOf('u_admin', 'w_tickets')).rows);
    // The empty group of a series: orders without an owner.
    const noOwner = { source: 'cross', widget_id: widget('w_owner').id, value: null };
    expect((await dataOf('u_admin', 'w_count', [noOwner])).rows).toEqual([[1]]);
  });

  it('applies bound controls and global filters, reports the others', async () => {
    const done = control('ctl_status', { values: [options['Xong']] });
    const byStatus = await dataOf('u_admin', 'w_status', [done]);
    expect(byStatus.rows.map((row) => (row[0] as { label: string }).label)).toEqual(['Xong']);
    const unbound = await dataOf('u_admin', 'w_by_owner', [done]);
    expect(unbound.ignored_filters).toEqual([
      { source: 'control', id: widget('ctl_status').id, reason: 'not_bound' },
    ]);
    const ticketControl = control('ctl_ticket', { values: [] });
    expect((await dataOf('u_admin', 'w_count', [ticketControl])).ignored_filters).toEqual([
      { source: 'control', id: widget('ctl_ticket').id, reason: 'other_table' },
    ]);
    const october = {
      source: 'global',
      id: 'period',
      value: { range: { from: '2026-10-01', to: '2026-10-31' } },
    };
    expect((await dataOf('u_admin', 'w_count', [october])).rows).toEqual([[2]]);
    expect((await dataOf('u_sales1', 'w_count', [october])).rows).toEqual([[1]]);
    const septemberOn = {
      source: 'global',
      id: 'period',
      value: { range: { from: '2026-09-01', to: null } },
    };
    expect((await dataOf('u_admin', 'w_count', [septemberOn])).rows).toEqual([[3]]);
    const longAgo = { source: 'global', id: 'period', value: { relative: 'last_year' } };
    expect((await dataOf('u_admin', 'w_count', [longAgo])).status).toBe('empty');
    expect((await dataOf('u_admin', 'w_tickets', [october])).ignored_filters).toEqual([
      { source: 'global', id: 'period', reason: 'other_table' },
    ]);
    // Province = Hà Nội on the count (bound) — the cache keys differ per filter.
    const hanoi = control('ctl_province', { values: [options['Hà Nội']] });
    const first = await dataOf('u_admin', 'w_count', [hanoi]);
    expect(first.rows).toEqual([[2]]);
    const again = await dataOf('u_admin', 'w_count', [hanoi]);
    expect(again).toMatchObject({ rows: [[2]], cache: 'hit' });
    expect((await dataOf('u_admin', 'w_count')).rows).toEqual([[4]]);
  });

  it('P70: cascading slicers offer only values of the parent selection the viewer reads', async () => {
    const hanoi = control('ctl_province', { values: [options['Hà Nội']] });
    expect(labels(await optionsOf('u_admin', 'ctl_district', { filters: [hanoi] }))).toEqual([
      'Ba Đình',
      'Cầu Giấy',
    ]);
    expect(labels(await optionsOf('u_sales1', 'ctl_district', { filters: [hanoi] }))).toEqual([
      'Ba Đình',
    ]);
    expect(labels(await optionsOf('u_sales1', 'ctl_district'))).toEqual(['Ba Đình', 'Quận 3']);
    // Only parents narrow the options; a sibling control is reported.
    const done = control('ctl_status', { values: [options['Xong']] });
    const sibling = await optionsOf('u_admin', 'ctl_district', { filters: [done] });
    expect(labels(sibling)).toEqual(['Ba Đình', 'Cầu Giấy', 'Quận 1', 'Quận 3']);
    expect(sibling.ignored_filters).toEqual([
      { source: 'control', id: widget('ctl_status').id, reason: 'not_bound' },
    ]);
    expect(labels(await optionsOf('u_admin', 'ctl_district', { search: 'cau' }))).toEqual([
      'Cầu Giấy',
    ]);
    const owners = await optionsOf('u_sales1', 'ctl_owner');
    expect(owners.items).toEqual([{ value: fx.users.u_sales1.id, label: 'User sales1' }]);
    expect((await optionsOf('u_admin', 'ctl_owner', { search: 'SALES2' })).items).toEqual([
      { value: fx.users.u_sales2.id, label: 'User sales2' },
    ]);
    expect((await optionsOf('u_admin', 'ctl_note', { search: 'R3' })).items).toEqual([
      { value: 'note r3', label: null },
    ]);
    // A field the viewer cannot read: no value at all.
    expect(await optionsOf('u_sales1', 'ctl_note')).toEqual({
      status: 'no_permission',
      items: [],
      has_more: false,
      ignored_filters: [],
    });
    const range = await fx.call('u_admin', 'POST', `/widgets/${widget('ctl_cost').id}/options`, {});
    expectProblem(range, 422, 'VALIDATION_FAILED');
    expect(codesOf(range)).toEqual(['UNKNOWN_WIDGET']);
    expectProblem(
      await fx.call('u_admin', 'POST', `/widgets/${widget('w_count').id}/options`, {}),
      422,
      'VALIDATION_FAILED',
    );
    expectProblem(
      await fx.call('u_admin', 'POST', `/widgets/${widget('ctl_district').id}/options`, {
        search: 'x'.repeat(101),
      }),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('P70: click-through of u_sales1 lists only r1, without cost', async () => {
    const segment = { dimension: options['Mới'] };
    const own = await recordsOf('u_sales1', 'w_status', { segment });
    expect(own.status).toBe('ok');
    expect(own.records.map((record) => record.fields[F('title')])).toEqual(['r1']);
    expect(own.total).toBe(1);
    for (const record of own.records) expect(Object.keys(record.fields)).not.toContain(F('cost'));

    const admin = await recordsOf('u_admin', 'w_status', { segment, limit: 1 });
    expect(admin.records).toHaveLength(1);
    expect(admin.total).toBe(2);
    expect(Object.keys(admin.records[0]?.fields ?? {})).toContain(F('cost'));
    const page2 = await recordsOf('u_admin', 'w_status', { segment, limit: 1, offset: 1 });
    expect(page2.records.map((record) => record.fields[F('title')])).toEqual(['r3']);

    // Series + live filters, the empty series, and a KPI without segment.
    const withSeries = await recordsOf('u_admin', 'w_by_owner', {
      segment: { dimension: options['Mới'], series: null },
    });
    expect(withSeries.records.map((record) => record.fields[F('title')])).toEqual(['r3']);
    const hanoi = control('ctl_province', { values: [options['Hà Nội']] });
    const kpi = await recordsOf('u_admin', 'w_count', { filters: [hanoi] });
    expect(kpi.records.map((record) => record.fields[F('title')])).toEqual(['r1', 'r2']);
    const costly = await recordsOf('u_sales1', 'w_count', {
      filters: [control('ctl_cost', { range: { from: 1000, to: null } })],
    });
    expect(costly.records).toHaveLength(2);
    expect(costly.ignored_filters).toEqual([
      { source: 'control', id: widget('ctl_cost').id, reason: 'no_permission' },
    ]);
    const empty = await recordsOf('u_admin', 'w_status', { segment: { dimension: null } });
    expect(empty).toMatchObject({ status: 'empty', records: [] });

    const kpiSegment = await fx.call(
      'u_admin',
      'POST',
      `/widgets/${widget('w_count').id}/records`,
      {
        segment,
      },
    );
    expectProblem(kpiSegment, 422, 'VALIDATION_FAILED');
    expect(codesOf(kpiSegment)).toEqual(['INVALID_FILTER_VALUE']);
    const series = await fx.call('u_admin', 'POST', `/widgets/${widget('w_status').id}/records`, {
      segment: { dimension: options['Mới'], series: 'x' },
    });
    expect(codesOf(series)).toEqual(['INVALID_FILTER_VALUE']);
    expectProblem(
      await fx.call('u_admin', 'POST', `/widgets/${widget('w_status').id}/records`, { limit: 201 }),
      422,
      'VALIDATION_FAILED',
    );
    expectProblem(
      await fx.call('u_out', 'POST', `/widgets/${widget('w_status').id}/records`, {}),
      404,
      'NOT_FOUND',
    );
  });

  it('P74: CSV needs download, is the aggregate table and is audited', async () => {
    const url = `/widgets/${widget('w_status').id}/export?format=csv`;
    expectProblem(await fx.call('u_sales1', 'GET', url), 403, 'PERMISSION_DENIED');
    expectProblem(await fx.call('u_out', 'GET', url), 404, 'NOT_FOUND');
    const before = await db.kysely
      .selectFrom('meta.audit_logs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('action', '=', 'export.created')
      .executeTakeFirstOrThrow();

    const response = ok(await fx.call('u_reader', 'GET', url));
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toBe('﻿status,Orders,Tổng amount\r\nMới,2,400\r\nXong,2,20200\r\n');
    const entry = await db.kysely
      .selectFrom('meta.audit_logs')
      .selectAll()
      .where('action', '=', 'export.created')
      .where('entity_type', '=', 'dashboard_widget')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(entry).toMatchObject({
      entity_id: widget('w_status').id,
      table_id: fx.orders.id,
      base_id: fx.baseId,
    });
    expect(entry.after).toEqual({ dashboard_id: dashboard.id, format: 'csv', row_count: 2 });
    const after = await db.kysely
      .selectFrom('meta.audit_logs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('action', '=', 'export.created')
      .executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n) + 1);

    // With live filters in the query string.
    const filters = encodeURIComponent(
      JSON.stringify([control('ctl_status', { values: [options['Xong']] })]),
    );
    const filtered = ok(await fx.call('u_reader', 'GET', `${url}&filters=${filters}`));
    expect(filtered.body).toBe('﻿status,Orders,Tổng amount\r\nXong,2,20200\r\n');
    const malformed = await fx.call('u_reader', 'GET', `${url}&filters=%7Bnope`);
    expectProblem(malformed, 422, 'VALIDATION_FAILED');
    expect(codesOf(malformed)).toContain('MALFORMED_JSON');
    const records = await fx.call(
      'u_reader',
      'GET',
      `/widgets/${widget('w_records').id}/export?format=csv`,
    );
    expectProblem(records, 422, 'VALIDATION_FAILED');
    expect(codesOf(records)).toEqual(['WIDGET_NOT_EXPORTABLE']);
    expectProblem(
      await fx.call('u_reader', 'GET', `/widgets/${widget('w_status').id}/export?format=xlsx`),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('API tokens need records:read for options, click-through and CSV', async () => {
    const reader = await tokenOf('u_reader', ['records:read']);
    const schemaOnly = await tokenOf('u_reader', ['schema:read']);
    const call = (token: string, method: 'GET' | 'POST', url: string) =>
      t.app.inject({
        method,
        url: `/api/v1${url}`,
        remoteAddress: uniqueIp(),
        headers: { authorization: `Bearer ${token}` },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
    const routes: ['GET' | 'POST', string][] = [
      ['POST', `/widgets/${widget('ctl_district').id}/options`],
      ['POST', `/widgets/${widget('w_status').id}/records`],
      ['GET', `/widgets/${widget('w_status').id}/export?format=csv`],
    ];
    for (const [method, url] of routes) {
      expect((await call(reader, method, url)).statusCode).toBe(200);
      expectProblem(await call(schemaOnly, method, url), 403, 'INSUFFICIENT_SCOPE');
    }
  });
});
