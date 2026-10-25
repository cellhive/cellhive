import {
  createdApiTokenSchema,
  dashboardListSchema,
  dashboardSchema,
  dashboardTrashSchema,
  roleListSchema,
  widgetSchema,
  type ApiTokenScope,
  type DashboardDto,
  type Id,
  type WidgetDto,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
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

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const DAY_MS = 86_400_000;

/** `errors[].code` of a problem response. */
function detailCodes(response: LightMyRequestResponse): string[] {
  const errors = problemOf(response.body)['errors'] as { code: string }[] | undefined;
  return (errors ?? []).map((item) => item.code);
}

describe('Dashboards: CRUD, layout, widgets, trash and permissions (T805, P65)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let dashboard: DashboardDto;
  let kpi: WidgetDto;
  let bar: WidgetDto;
  let control: WidgetDto;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const ok = (response: LightMyRequestResponse, status = 200) => {
    expect(response.statusCode, response.body).toBe(status);
    return response;
  };
  /** A dashboard of a `200` (or `201` for a creation) response. */
  const dashboardOf = (response: LightMyRequestResponse) => {
    expect([200, 201], response.body).toContain(response.statusCode);
    return dashboardSchema.parse(response.json());
  };
  const get = (user: FixtureUser, id: Id<'dsh'> = dashboard.id) =>
    fx.call(user, 'GET', `/dashboards/${id}`);
  const listIds = async (user: FixtureUser) =>
    dashboardListSchema
      .parse(ok(await fx.call(user, 'GET', `/bases/${fx.baseId}/dashboards`)).json())
      .items.map((item) => item.id);
  const addWidget = async (body: Record<string, unknown>, status = 201) =>
    fx.call('owner', 'POST', `/dashboards/${dashboard.id}/widgets`, body).then((response) => {
      expect(response.statusCode, response.body).toBe(status);
      return response;
    });

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

  const withToken = (token: string, method: Method, url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      remoteAddress: uniqueIp(),
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  async function auditActions(entityId: string): Promise<string[]> {
    const { rows } = await sql<{ action: string; organization_id: string }>`
      SELECT action, organization_id FROM meta.audit_logs
       WHERE entity_id = ${entityId} ORDER BY created_at, action
    `.execute(db.kysely);
    for (const row of rows) expect(row.organization_id).toBe(fx.orgId);
    return rows.map((row) => row.action);
  }

  async function eventTypes(entityId: string): Promise<string[]> {
    const { rows } = await sql<{ type: string }>`
      SELECT type FROM meta.events WHERE entity_id = ${entityId} ORDER BY created_at, type
    `.execute(db.kysely);
    return rows.map((row) => row.type);
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);

    dashboard = dashboardOf(
      await fx.call('owner', 'POST', `/bases/${fx.baseId}/dashboards`, {
        name: 'Sales overview',
        icon: 'chart',
        theme: { mode: 'light' },
      }),
    );
    control = widgetSchema.parse(
      (
        await addWidget({
          type: 'filter_control',
          title: 'Status',
          config: { table_id: fx.orders.id, field: F('status'), control: 'select' },
          layout: { x: 0, y: 0, w: 12, h: 2 },
        })
      ).json(),
    );
    kpi = widgetSchema.parse(
      (
        await addWidget({
          type: 'kpi',
          title: 'Revenue',
          config: {
            table_id: fx.orders.id,
            metrics: [{ id: 'm1', aggregation: 'sum', field: F('amount') }],
            filter: { op: 'and', items: [{ field: F('amount'), operator: 'gt', value: 0 }] },
          },
        })
      ).json(),
    );
    bar = widgetSchema.parse(
      (
        await addWidget({
          type: 'bar',
          title: 'Orders by status',
          config: {
            table_id: fx.orders.id,
            dimension: { field: F('status') },
            metrics: [{ id: 'm1', aggregation: 'count' }],
            filter_bindings: [control.id],
          },
        })
      ).json(),
    );
    dashboard = dashboardOf(await get('owner'));
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('creates a dashboard and places widgets below each other', () => {
    expect(dashboard).toMatchObject({
      base_id: fx.baseId,
      name: 'Sales overview',
      icon: 'chart',
      theme: { mode: 'light' },
      global_filters: [],
      position: 0,
      // Created, then three widgets: every change bumps the version.
      version: 4,
      created_by: { id: fx.users.owner.id, name: 'Owner' },
    });
    expect(kpi.layout).toEqual({ x: 0, y: 2, w: 6, h: 6 });
    expect(bar.layout).toEqual({ x: 0, y: 8, w: 6, h: 6 });
    expect(dashboard.widgets.map((widget) => widget.id)).toEqual([control.id, kpi.id, bar.id]);
    expect(dashboard.widgets.every((widget) => widget.status === 'ok')).toBe(true);
    // The saved filter is stored as DSL.
    expect(kpi.config['filter']).toEqual({
      op: 'and',
      items: [{ field: F('amount'), operator: 'gt', value: 0 }],
    });
  });

  it('P65: system readers read but cannot change; Sales without dashboards.D sees nothing', async () => {
    const asReader = dashboardOf(await get('u_reader'));
    expect(asReader.widgets).toHaveLength(3);
    // Saved filters are for the admins who edit them.
    expect(asReader.widgets.find((widget) => widget.id === kpi.id)?.config['filter']).toBeNull();
    expect(await listIds('u_reader')).toEqual([dashboard.id]);
    ok(await get('u_editor'));
    expectProblem(
      await fx.call('u_reader', 'PATCH', `/dashboards/${dashboard.id}`, { name: 'X' }),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_editor', 'PATCH', `/widgets/${kpi.id}`, { title: 'X' }),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_reader', 'POST', `/bases/${fx.baseId}/dashboards`, { name: 'Mine' }),
      403,
      'PERMISSION_DENIED',
    );

    // Sales (custom role, `dashboards: {}`): 404 on every route of D, not listed.
    expect(await listIds('u_sales1')).toEqual([]);
    const routes: [Method, string, unknown?][] = [
      ['GET', `/dashboards/${dashboard.id}`],
      ['PATCH', `/dashboards/${dashboard.id}`, { name: 'X' }],
      ['DELETE', `/dashboards/${dashboard.id}`],
      ['POST', `/dashboards/${dashboard.id}/duplicate`, {}],
      ['POST', `/dashboards/${dashboard.id}/restore`],
      ['PUT', `/dashboards/${dashboard.id}/layout`, { layout: {} }],
      ['POST', `/dashboards/${dashboard.id}/widgets`, { type: 'text' }],
      ['PATCH', `/widgets/${kpi.id}`, { title: 'X' }],
      ['DELETE', `/widgets/${kpi.id}`],
      ['POST', `/widgets/${kpi.id}/duplicate`],
    ];
    for (const user of ['u_sales1', 'u_out', 'stranger'] as const) {
      for (const [method, url, payload] of routes) {
        const response = await fx.call(user, method, url, payload);
        expect({ user, method, url, status: response.statusCode }).toEqual({
          user,
          method,
          url,
          status: 404,
        });
      }
    }
    expectProblem(
      await fx.call('u_out', 'GET', `/bases/${fx.baseId}/dashboards`),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await fx.call('u_reader', 'GET', `/bases/${fx.baseId}/dashboards/trash`),
      403,
      'PERMISSION_DENIED',
    );

    // Adding `read_only` to Sales: D becomes visible.
    const roles = roleListSchema.parse(
      ok(await fx.call('owner', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    );
    const sales = roles.items.find((role) => role.name === 'Sales');
    expect(sales).toBeDefined();
    ok(
      await fx.call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${String(sales?.id)}`, {
        config: { ...sales?.config, dashboards: { [dashboard.id]: 'read_only' } },
      }),
    );
    ok(await get('u_sales1'));
    expect(await listIds('u_sales2')).toEqual([dashboard.id]);
    expectProblem(
      await fx.call('u_sales1', 'PATCH', `/dashboards/${dashboard.id}`, { name: 'X' }),
      403,
      'PERMISSION_DENIED',
    );
  });

  it('P65: API tokens read with schema:read and need schema:write to change', async () => {
    const reader = await tokenOf('u_admin', ['schema:read']);
    ok(await withToken(reader, 'GET', `/dashboards/${dashboard.id}`));
    ok(await withToken(reader, 'GET', `/bases/${fx.baseId}/dashboards`));
    expectProblem(
      await withToken(reader, 'PATCH', `/dashboards/${dashboard.id}`, { name: 'X' }),
      403,
      'INSUFFICIENT_SCOPE',
    );
    expectProblem(
      await withToken(reader, 'POST', `/dashboards/${dashboard.id}/widgets`, { type: 'text' }),
      403,
      'INSUFFICIENT_SCOPE',
    );
    const records = await tokenOf('u_admin', ['records:read']);
    expectProblem(
      await withToken(records, 'GET', `/dashboards/${dashboard.id}`),
      403,
      'INSUFFICIENT_SCOPE',
    );
    // A dashboard the token's user cannot read: 404, never the scope error.
    const outsider = await tokenOf('u_out', ['records:read']);
    expectProblem(
      await withToken(outsider, 'PATCH', `/dashboards/${dashboard.id}`, { name: 'X' }),
      404,
      'NOT_FOUND',
    );
    const writer = await tokenOf('u_admin', ['schema:read', 'schema:write']);
    const renamed = dashboardOf(
      await withToken(writer, 'PATCH', `/dashboards/${dashboard.id}`, { description: 'Q4' }),
    );
    expect(renamed.description).toBe('Q4');
    dashboard = renamed;
  });

  it('checks layouts: 12 columns, no overlap, every widget, stored compacted', async () => {
    const url = `/dashboards/${dashboard.id}/layout`;
    const overlap = await fx.call('owner', 'PUT', url, {
      layout: {
        [control.id]: { x: 0, y: 0, w: 12, h: 2 },
        [kpi.id]: { x: 0, y: 2, w: 6, h: 4 },
        [bar.id]: { x: 3, y: 3, w: 6, h: 4 },
      },
    });
    expectProblem(overlap, 422, 'VALIDATION_FAILED');
    expect(detailCodes(overlap)).toEqual(['LAYOUT_OVERLAP']);
    expectProblem(
      await fx.call('owner', 'PUT', url, {
        layout: {
          [control.id]: { x: 0, y: 0, w: 12, h: 2 },
          [kpi.id]: { x: 0, y: 2, w: 6, h: 4 },
          [bar.id]: { x: 8, y: 2, w: 6, h: 4 },
        },
      }),
      422,
      'VALIDATION_FAILED',
    );
    const incomplete = await fx.call('owner', 'PUT', url, {
      layout: { [kpi.id]: { x: 0, y: 0, w: 6, h: 4 } },
    });
    expectProblem(incomplete, 422, 'VALIDATION_FAILED');
    expect(detailCodes(incomplete)).toEqual(['LAYOUT_INCOMPLETE']);
    const foreign = await fx.call('owner', 'PUT', url, {
      layout: {
        [control.id]: { x: 0, y: 0, w: 12, h: 2 },
        [kpi.id]: { x: 0, y: 2, w: 6, h: 4 },
        [bar.id]: { x: 6, y: 2, w: 6, h: 4 },
        wgt_NotOnThisBoard01: { x: 0, y: 9, w: 6, h: 4 },
      },
    });
    expect(detailCodes(foreign)).toEqual(['UNKNOWN_WIDGET']);

    const placed = dashboardOf(
      await fx.call('owner', 'PUT', url, {
        layout: {
          [control.id]: { x: 0, y: 0, w: 12, h: 2 },
          [kpi.id]: { x: 0, y: 10, w: 6, h: 4 },
          [bar.id]: { x: 6, y: 20, w: 6, h: 4 },
        },
        version: dashboard.version,
      }),
    );
    // Compacted upwards: both go right below the control.
    expect(Object.fromEntries(placed.widgets.map((widget) => [widget.id, widget.layout]))).toEqual({
      [control.id]: { x: 0, y: 0, w: 12, h: 2 },
      [kpi.id]: { x: 0, y: 2, w: 6, h: 4 },
      [bar.id]: { x: 6, y: 2, w: 6, h: 4 },
    });
    expect(placed.version).toBe(dashboard.version + 1);
    dashboard = placed;

    // A widget placed over another one.
    const overlapping = await fx.call('owner', 'PATCH', `/widgets/${bar.id}`, {
      layout: { x: 3, y: 2, w: 6, h: 4 },
    });
    expect(detailCodes(overlapping)).toEqual(['LAYOUT_OVERLAP']);
  });

  it('checks widget configs against the base', async () => {
    // A field of another table.
    const foreign = await addWidget(
      {
        type: 'bar',
        config: {
          table_id: fx.orders.id,
          dimension: { field: F('ticketStatus') },
          metrics: [{ id: 'm1', aggregation: 'count' }],
        },
      },
      422,
    );
    expect(detailCodes(foreign)).toEqual(['UNKNOWN_FIELD']);
    // A date dimension without a bucket.
    const bucket = await addWidget(
      {
        type: 'line',
        config: {
          table_id: fx.tickets.id,
          dimension: { field: F('due') },
          metrics: [{ id: 'm1', aggregation: 'count' }],
        },
      },
      422,
    );
    expect(detailCodes(bucket)).toEqual(['DATE_BUCKET_REQUIRED']);
    // `sum` of a select.
    const metric = await addWidget(
      {
        type: 'kpi',
        config: {
          table_id: fx.orders.id,
          metrics: [{ id: 'm1', aggregation: 'sum', field: F('status') }],
        },
      },
      422,
    );
    expect(detailCodes(metric)).toEqual(['INVALID_METRIC']);
    // Bound to a widget that is not a filter control of this dashboard.
    const binding = await addWidget(
      {
        type: 'pie',
        config: {
          table_id: fx.orders.id,
          dimension: { field: F('status') },
          metrics: [{ id: 'm1', aggregation: 'count' }],
          filter_bindings: [kpi.id],
        },
      },
      422,
    );
    expect(detailCodes(binding)).toEqual(['UNKNOWN_WIDGET']);
    // Six metrics.
    const many = await addWidget(
      {
        type: 'combo',
        config: {
          table_id: fx.orders.id,
          dimension: { field: F('status') },
          metrics: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `m${String(n)}`, aggregation: 'count' })),
        },
      },
      422,
    );
    expect(problemOf(many.body)['code']).toBe('VALIDATION_FAILED');
  });

  it('409 when two editors change the same version', async () => {
    const version = dashboard.version;
    const first = dashboardOf(
      await fx.call(
        'owner',
        'PATCH',
        `/dashboards/${dashboard.id}`,
        { name: 'Sales 2025' },
        {
          'if-match': `"${String(version)}"`,
        },
      ),
    );
    expect(first.version).toBe(version + 1);
    const second = await fx.call(
      'u_admin',
      'PATCH',
      `/dashboards/${dashboard.id}`,
      { name: 'Sales 2026' },
      { 'if-match': `"${String(version)}"` },
    );
    expectProblem(second, 409, 'VERSION_CONFLICT');
    expect((problemOf(second.body)['errors'] as { params: unknown }[])[0]?.params).toMatchObject({
      current_version: version + 1,
      version,
    });
    const widget = await fx.call('u_admin', 'PATCH', `/widgets/${kpi.id}`, {
      title: 'Stale',
      version,
    });
    expectProblem(widget, 409, 'VERSION_CONFLICT');
    expectProblem(
      await fx.call(
        'owner',
        'PATCH',
        `/dashboards/${dashboard.id}`,
        { name: 'X' },
        {
          'if-match': 'soon',
        },
      ),
      422,
      'VALIDATION_FAILED',
    );
    dashboard = first;
  });

  it('keeps names unique per base, ignoring case', async () => {
    const other = dashboardOf(
      await fx.call('owner', 'POST', `/bases/${fx.baseId}/dashboards`, { name: 'Ops' }),
    );
    expect(other.position).toBe(1);
    expectProblem(
      await fx.call('owner', 'POST', `/bases/${fx.baseId}/dashboards`, { name: 'OPS' }),
      409,
      'NAME_CONFLICT',
    );
    expectProblem(
      await fx.call('owner', 'PATCH', `/dashboards/${other.id}`, { name: 'sales 2025' }),
      409,
      'NAME_CONFLICT',
    );
    // Moving it first.
    ok(await fx.call('owner', 'PATCH', `/dashboards/${other.id}`, { position: 0 }));
    expect(await listIds('owner')).toEqual([other.id, dashboard.id]);
    ok(await fx.call('owner', 'DELETE', `/dashboards/${other.id}`), 204);
  });

  it('duplicates a dashboard with its widgets, and a widget', async () => {
    const copy = dashboardOf(
      await fx.call('owner', 'POST', `/dashboards/${dashboard.id}/duplicate`),
    );
    expect(copy).toMatchObject({ name: 'Sales 2025 (bản sao)', version: 1 });
    expect(copy.id).not.toBe(dashboard.id);
    expect(copy.widgets.map((widget) => widget.title)).toEqual([
      'Status',
      'Revenue',
      'Orders by status',
    ]);
    const copiedControl = copy.widgets.find((widget) => widget.type === 'filter_control');
    const copiedBar = copy.widgets.find((widget) => widget.type === 'bar');
    expect(copiedControl?.id).not.toBe(control.id);
    expect(copiedBar?.config['filter_bindings']).toEqual([copiedControl?.id]);
    expect(await eventTypes(copy.id)).toEqual(['dashboard.duplicated']);
    // Again: numbered.
    const again = dashboardOf(
      await fx.call('owner', 'POST', `/dashboards/${dashboard.id}/duplicate`, {}),
    );
    expect(again.name).toBe('Sales 2025 (bản sao) 2');
    expectProblem(
      await fx.call('owner', 'POST', `/dashboards/${dashboard.id}/duplicate`, {
        name: 'sales 2025 (BẢN SAO)',
      }),
      409,
      'NAME_CONFLICT',
    );

    const twin = widgetSchema.parse(
      ok(await fx.call('owner', 'POST', `/widgets/${bar.id}/duplicate`), 201).json(),
    );
    expect(twin).toMatchObject({ title: 'Orders by status', type: 'bar' });
    expect(twin.layout).toEqual({ x: 0, y: 6, w: 6, h: 4 });
    expect(await auditActions(twin.id)).toEqual(['dashboard.widget_created']);
    ok(await fx.call('owner', 'DELETE', `/widgets/${twin.id}`), 204);
    expect(await auditActions(twin.id)).toEqual([
      'dashboard.widget_created',
      'dashboard.widget_deleted',
    ]);
  });

  it('moves to the trash and back', async () => {
    const victim = dashboardOf(
      await fx.call('owner', 'POST', `/bases/${fx.baseId}/dashboards`, { name: 'Temp' }),
    );
    ok(await fx.call('owner', 'DELETE', `/dashboards/${victim.id}`), 204);
    expectProblem(await get('owner', victim.id), 404, 'NOT_FOUND');
    expectProblem(await get('u_reader', victim.id), 404, 'NOT_FOUND');
    expect(await listIds('owner')).not.toContain(victim.id);
    const trash = dashboardTrashSchema.parse(
      ok(await fx.call('owner', 'GET', `/bases/${fx.baseId}/dashboards/trash`)).json(),
    );
    const trashed = trash.items.find((item) => item.id === victim.id);
    expect(trashed).toMatchObject({ name: 'Temp', deleted_by: { id: fx.users.owner.id } });
    expect(
      new Date(String(trashed?.purge_at)).getTime() -
        new Date(String(trashed?.deleted_at)).getTime(),
    ).toBe(30 * DAY_MS);
    // A dashboard outside the trash cannot be restored; one in it cannot be changed.
    expectProblem(
      await fx.call('owner', 'POST', `/dashboards/${dashboard.id}/restore`),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await fx.call('owner', 'PATCH', `/dashboards/${victim.id}`, { name: 'Nope' }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await fx.call('u_reader', 'POST', `/dashboards/${victim.id}/restore`),
      404,
      'NOT_FOUND',
    );

    // Its name was taken meanwhile: restoring needs it free.
    const squatter = dashboardOf(
      await fx.call('owner', 'POST', `/bases/${fx.baseId}/dashboards`, { name: 'temp' }),
    );
    expectProblem(
      await fx.call('owner', 'POST', `/dashboards/${victim.id}/restore`),
      409,
      'NAME_CONFLICT',
    );
    ok(await fx.call('owner', 'DELETE', `/dashboards/${squatter.id}`), 204);
    const restored = dashboardOf(
      await fx.call('owner', 'POST', `/dashboards/${victim.id}/restore`),
    );
    expect(restored.name).toBe('Temp');
    expect(await auditActions(victim.id)).toEqual([
      'dashboard.created',
      'dashboard.deleted',
      'dashboard.restored',
    ]);
    expect(await eventTypes(victim.id)).toEqual([
      'dashboard.created',
      'dashboard.deleted',
      'dashboard.restored',
    ]);
  });

  it('audits configurations, never record data', async () => {
    const { rows } = await sql<{ action: string; before: unknown; after: unknown }>`
      SELECT action, before, after FROM meta.audit_logs
       WHERE entity_id = ${kpi.id} ORDER BY created_at
    `.execute(db.kysely);
    expect(rows.map((row) => row.action)).toEqual(['dashboard.widget_created']);
    expect(rows[0]?.after).toMatchObject({ type: 'kpi', title: 'Revenue' });
    const events = await eventTypes(dashboard.id);
    expect(events).toContain('dashboard.created');
    expect(events).toContain('dashboard.updated');
  });

  it('a widget whose field is deleted reads as broken; deleting a control unbinds', async () => {
    ok(await fx.call('owner', 'DELETE', `/fields/${F('amount')}`), 204);
    const after = dashboardOf(await get('owner'));
    const broken = after.widgets.find((widget) => widget.id === kpi.id);
    expect(broken).toMatchObject({ status: 'broken', broken_reason: 'field_deleted' });
    // The config is kept.
    expect(broken?.config['metrics']).toEqual(kpi.config['metrics']);

    ok(await fx.call('owner', 'DELETE', `/widgets/${control.id}`), 204);
    const unbound = dashboardOf(await get('owner'));
    expect(
      unbound.widgets.find((widget) => widget.id === bar.id)?.config['filter_bindings'],
    ).toEqual([]);
  });
});
