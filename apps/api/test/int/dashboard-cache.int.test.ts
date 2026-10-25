/**
 * The widget result cache over HTTP with a real Valkey (BACKLOG T807,
 * CONTRACTS §28.5, P68): the key holds the viewer's permission fingerprint
 * resolved for them (two members of one role whose rule is `owner
 * has_any_of current_user` never share an entry — the leak of caches keyed
 * by query only) and the tables' `data_version` (a write is never answered
 * with an older number); cold keys are computed once across instances; a
 * Valkey failure turns the cache off without failing the widget.
 */
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  dashboardSchema,
  fieldSchema,
  roleListSchema,
  widgetDataSchema,
  widgetSchema,
  type DashboardDto,
  type Id,
  type RoleDto,
  type WidgetDataDto,
  type WidgetDto,
} from '@cellhive/contracts';
import { RecordQueryService, type Db } from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CACHE_KEY_PREFIX } from '../../src/common/rate-limit/rate-limiter.js';
import { CACHE_CLIENT } from '../../src/common/tokens.js';
import { ValkeyWidgetCacheStore } from '../../src/modules/dashboard/widget-cache-store.js';
import { MetricsService } from '../../src/modules/metrics/metrics.service.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  relaxRateLimits,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';
import type { Redis } from 'ioredis';

describe('Widget cache: permission fingerprint + data_version (T807, P68)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: TestApp;
  let b: TestApp;
  let fx: RecordFixture;
  let dashboard: DashboardDto;
  let sales: RoleDto;
  let r1: Id<'rec'>;
  const w: Record<string, WidgetDto> = {};

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const ok = (response: LightMyRequestResponse, status = 200) => {
    expect(response.statusCode, response.body).toBe(status);
    return response;
  };
  const dataOf = async (user: FixtureUser, widget: WidgetDto): Promise<WidgetDataDto> =>
    widgetDataSchema.parse(ok(await fx.call(user, 'POST', `/widgets/${widget.id}/data`)).json());
  const cacheKeys = async (widget: WidgetDto): Promise<string[]> =>
    (await a.app.get<Redis>(CACHE_CLIENT).keys(`${CACHE_KEY_PREFIX}dash:${widget.id}:*`)).sort();
  const metric = async (app: TestApp, name: string, labels = ''): Promise<number> => {
    const text = await app.app.get(MetricsService).registry.metrics();
    const line = text
      .split('\n')
      .find((item) => item.startsWith(`${name}${labels === '' ? ' ' : `{${labels}} `}`));
    return line === undefined ? 0 : Number(line.split(' ').at(-1));
  };
  const statusLabel = (row: unknown[]) => (row[0] as { label: string | null }).label;
  /** `POST /widgets/:id/data` as `user` on one instance (sessions are shared). */
  const dataOn = async (app: TestApp, user: FixtureUser, widget: WidgetDto) => {
    const cookie = await fx.cookie(user);
    const csrf = /(?:^|; )([^=]+)=([^;]*)/g;
    let token = '';
    for (const match of cookie.matchAll(csrf)) if (match[1] === CSRF_COOKIE) token = match[2] ?? '';
    return app.app.inject({
      method: 'POST',
      url: `/api/v1/widgets/${widget.id}/data`,
      headers: { cookie, [CSRF_HEADER]: token },
    });
  };

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    a = await startTestApp({ DATABASE_URL: database.url });
    b = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(a, db);
    relaxRateLimits(b);
    const created = ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records?typecast=true`, {
        records: [
          {
            fields: {
              title: 'r1',
              amount: 100,
              cost: 10,
              status: 'Mới',
              owner: [{ id: fx.users.u_sales1.id }],
            },
          },
          {
            fields: {
              title: 'r2',
              amount: 200,
              cost: 20,
              status: 'Xong',
              owner: [{ id: fx.users.u_sales2.id }],
            },
          },
          { fields: { title: 'r3', amount: 300, cost: 30, status: 'Mới' } },
        ],
      }),
      201,
    ).json<{ records: { id: Id<'rec'> }[] }>();
    r1 = created.records[0]?.id as Id<'rec'>;

    dashboard = dashboardSchema.parse(
      ok(
        await fx.call('owner', 'POST', `/bases/${fx.baseId}/dashboards`, { name: 'Cache' }),
        201,
      ).json(),
    );
    const addWidget = async (type: string, config: Record<string, unknown>) =>
      widgetSchema.parse(
        ok(
          await fx.call('owner', 'POST', `/dashboards/${dashboard.id}/widgets`, {
            type,
            config: { table_id: fx.orders.id, ...config },
          }),
          201,
        ).json(),
      );
    const count = [{ id: 'm1', aggregation: 'count' }];
    w['status'] = await addWidget('bar', { dimension: { field: F('status') }, metrics: count });
    w['count'] = await addWidget('kpi', { metrics: count });
    w['amount'] = await addWidget('kpi', {
      metrics: [{ id: 'm1', aggregation: 'sum', field: F('amount') }],
    });
    w['mine'] = await addWidget('kpi', {
      metrics: count,
      filter: {
        op: 'and',
        items: [{ field: F('owner'), operator: 'has_any_of', value: [{ $var: 'current_user' }] }],
      },
    });

    const roles = roleListSchema.parse(
      ok(await fx.call('owner', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    );
    sales = roles.items.find((role) => role.name === 'Sales') as RoleDto;
    ok(
      await fx.call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
        config: { ...sales.config, dashboards: { [dashboard.id]: 'read_only' } },
      }),
    );
    sales = roleListSchema
      .parse(ok(await fx.call('owner', 'GET', `/bases/${fx.baseId}/roles`)).json())
      .items.find((role) => role.name === 'Sales') as RoleDto;
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await Promise.all([a.close(), b.close()]);
    await db.destroy();
    await database.drop();
  });

  it('two members of one role with a current_user rule never share an entry', async () => {
    const widget = w['status'] as WidgetDto;
    const admin = await dataOf('u_admin', widget);
    expect(admin).toMatchObject({ status: 'ok', cache: 'miss' });
    expect(admin.total).toEqual([3]);
    // Another reader of every record and field: the same entry.
    const editor = await dataOf('u_editor', widget);
    expect(editor).toMatchObject({ cache: 'hit', computed_at: admin.computed_at });
    expect(editor.rows).toEqual(admin.rows);

    // u_sales1 never reads the result of the admin…
    const sales1 = await dataOf('u_sales1', widget);
    expect(sales1.cache).toBe('miss');
    expect(sales1.rows.map(statusLabel)).toEqual(['Mới']);
    expect(sales1.total).toEqual([1]);
    // …and u_sales2 (same role, same group) never reads the result of u_sales1.
    const sales2 = await dataOf('u_sales2', widget);
    expect(sales2.cache).toBe('miss');
    expect(sales2.rows.map(statusLabel)).toEqual(['Xong']);
    expect(sales2.total).toEqual([1]);
    // Three keys (admin = editor, sales1, sales2), each answered from its own entry.
    const keys = await cacheKeys(widget);
    expect(keys).toHaveLength(3);
    expect(new Set(keys.map((key) => key.split(':')[4])).size).toBe(3);
    expect((await dataOf('u_sales1', widget)).cache).toBe('hit');
    expect((await dataOf('u_sales2', widget)).rows.map(statusLabel)).toEqual(['Xong']);
    // Keys carry hashes, ids and versions only: no user id in clear.
    for (const key of keys) {
      expect(key).toMatch(
        new RegExp(`^${CACHE_KEY_PREFIX}dash:${widget.id}:[0-9a-f]{64}:[0-9a-f]{64}:[0-9.]+$`),
      );
      expect(key).not.toContain(fx.users.u_sales1.id);
    }
  });

  it('a saved filter on current_user is resolved per viewer too', async () => {
    const widget = w['mine'] as WidgetDto;
    // Nobody owns a record of the admin or the editor: both empty, from two entries.
    expect(await dataOf('u_admin', widget)).toMatchObject({ status: 'empty', cache: 'miss' });
    expect(await dataOf('u_editor', widget)).toMatchObject({ status: 'empty', cache: 'miss' });
    expect(await dataOf('u_sales1', widget)).toMatchObject({ rows: [[1]], cache: 'miss' });
    expect(await dataOf('u_sales2', widget)).toMatchObject({ rows: [[1]], cache: 'miss' });
    expect(await cacheKeys(widget)).toHaveLength(4);
  });

  it('a write changes data_version: the next read is a miss with the new number', async () => {
    const widget = w['amount'] as WidgetDto;
    expect((await dataOf('u_sales1', widget)).rows).toEqual([[100]]);
    expect(await dataOf('u_sales1', widget)).toMatchObject({ rows: [[100]], cache: 'hit' });
    ok(
      await fx.call('u_sales1', 'PATCH', `/tables/${fx.orders.id}/records`, {
        records: [{ id: r1, fields: { amount: 150 } }],
      }),
    );
    expect(await dataOf('u_sales1', widget)).toMatchObject({ rows: [[150]], cache: 'miss' });
    expect(await dataOf('u_admin', widget)).toMatchObject({ rows: [[650]], cache: 'miss' });
  });

  it('a role change changes the fingerprint: miss with the numbers of the new access', async () => {
    const widget = w['count'] as WidgetDto;
    expect(await dataOf('u_sales1', widget)).toMatchObject({ rows: [[1]], cache: 'miss' });
    expect((await dataOf('u_sales1', widget)).cache).toBe('hit');
    const tables = sales.config.tables as Record<string, Record<string, unknown>>;
    const orders = tables[fx.orders.id] as { record_rule: Record<string, unknown> };
    ok(
      await fx.call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
        config: {
          ...sales.config,
          tables: {
            ...tables,
            [fx.orders.id]: {
              ...orders,
              record_rule: { ...orders.record_rule, read_scope: 'all', read_filter: null },
            },
          },
        },
      }),
    );
    expect(await dataOf('u_sales1', widget)).toMatchObject({ rows: [[3]], cache: 'miss' });
    // Every record now, but still not `cost`: not the admin's entry.
    expect(await dataOf('u_admin', widget)).toMatchObject({ rows: [[3]], cache: 'miss' });
    // u_sales2 now reads exactly what u_sales1 reads: one entry for both.
    expect(await dataOf('u_sales2', widget)).toMatchObject({ rows: [[3]], cache: 'hit' });
    ok(
      await fx.call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
        config: sales.config,
      }),
    );
    // Back to the old role: the old fingerprint, whose entry is still valid.
    expect(await dataOf('u_sales1', widget)).toMatchObject({ rows: [[1]], cache: 'hit' });
  });

  it('20 concurrent cold requests over two instances run one widget query', async () => {
    const widget = w['amount'] as WidgetDto;
    // A new data_version: every key of the widget is cold.
    ok(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records`, {
        records: [{ id: r1, fields: { amount: 160 } }],
      }),
    );
    const spies = [a, b].map((app) => vi.spyOn(app.app.get(RecordQueryService), 'widgetData'));
    const coalescedBefore =
      (await metric(a, 'dashboard_cache_coalesced_total')) +
      (await metric(b, 'dashboard_cache_coalesced_total'));
    await fx.cookie('u_admin');
    const request = (app: TestApp) => dataOn(app, 'u_admin', widget);
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) => request(index % 2 === 0 ? a : b)),
    );
    const results = responses.map((response) => widgetDataSchema.parse(ok(response).json()));
    const calls = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    for (const spy of spies) spy.mockRestore();
    expect(calls).toBe(1);
    expect(new Set(results.map((result) => JSON.stringify(result.rows)))).toEqual(
      new Set([JSON.stringify([[660]])]),
    );
    expect(results.filter((result) => result.cache === 'miss')).toHaveLength(1);
    // The others waited for that computation (or came just after it: plain hits).
    const coalescedAfter =
      (await metric(a, 'dashboard_cache_coalesced_total')) +
      (await metric(b, 'dashboard_cache_coalesced_total'));
    expect(coalescedAfter - coalescedBefore).toBeGreaterThan(0);
    expect(coalescedAfter - coalescedBefore).toBeLessThanOrEqual(19);
  });

  it('Valkey failing: the widget still answers, uncached (bypass)', async () => {
    const widget = w['count'] as WidgetDto;
    const store = a.app.get(ValkeyWidgetCacheStore);
    const bypassBefore = await metric(a, 'dashboard_cache_total', 'result="bypass"');
    store.failing = true;
    try {
      const response = await dataOn(a, 'u_sales2', widget);
      expect(widgetDataSchema.parse(ok(response).json())).toMatchObject({
        status: 'ok',
        rows: [[1]],
        cache: 'miss',
      });
    } finally {
      store.failing = false;
    }
    expect(await metric(a, 'dashboard_cache_total', 'result="bypass"')).toBe(bypassBefore + 1);
    expect(await metric(a, 'dashboard_cache_total', 'result="hit"')).toBeGreaterThan(0);
    expect(await metric(a, 'dashboard_cache_total', 'result="miss"')).toBeGreaterThan(0);
  });

  it('the viewer locale is part of the key (link titles are formatted per locale)', async () => {
    const widget = widgetSchema.parse(
      ok(
        await fx.call('owner', 'POST', `/dashboards/${dashboard.id}/widgets`, {
          type: 'kpi',
          config: { table_id: fx.orders.id, metrics: [{ id: 'm1', aggregation: 'count' }] },
        }),
        201,
      ).json(),
    );
    // Same fingerprint, same locale (the organization's): one entry.
    expect((await dataOf('u_admin', widget)).cache).toBe('miss');
    expect((await dataOf('u_editor', widget)).cache).toBe('hit');
    await db.kysely
      .updateTable('meta.users')
      .set({ locale: 'en' })
      .where('id', '=', fx.users.u_editor.id)
      .execute();
    try {
      // Another locale: never the entry formatted for the admin's.
      expect((await dataOf('u_editor', widget)).cache).toBe('miss');
      expect((await dataOf('u_editor', widget)).cache).toBe('hit');
      expect((await dataOf('u_admin', widget)).cache).toBe('hit');
      expect(await cacheKeys(widget)).toHaveLength(2);
    } finally {
      await db.kysely
        .updateTable('meta.users')
        .set({ locale: null })
        .where('id', '=', fx.users.u_editor.id)
        .execute();
    }
  });

  it('records widgets are never cached: button cells stay per viewer and follow the automation', async () => {
    const button = fieldSchema.parse(
      ok(
        await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
          name: 'Duyệt',
          type: 'button',
          options: { label: 'Duyệt' },
        }),
        201,
      ).json(),
    );
    const widget = widgetSchema.parse(
      ok(
        await fx.call('owner', 'POST', `/dashboards/${dashboard.id}/widgets`, {
          type: 'table',
          config: {
            table_id: fx.orders.id,
            table: { mode: 'records', fields: [F('title'), button.id] },
          },
        }),
        201,
      ).json(),
    );
    const cellOf = (data: WidgetDataDto) => data.rows.find((row) => row[0] === r1)?.[2];

    const before = await dataOf('u_admin', widget);
    expect(before.cache).toBe('miss');
    expect(cellOf(before)).toEqual({ state: 'disabled', reason: 'no_automation' });
    // Attaching an automation writes no record (no data_version change)…
    ok(
      await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Duyệt',
        enabled: true,
        definition: {
          trigger: { type: 'button.clicked', table_id: fx.orders.id, field_id: button.id },
          condition: null,
          actions: [
            {
              id: 'act_1',
              type: 'update_record',
              config: {
                table_id: fx.orders.id,
                record_id: null,
                fields: { [F('amount')]: { literal: 7 } },
              },
            },
          ],
        },
      }),
      201,
    );
    // …yet the next read shows it at once.
    const admin = await dataOf('u_admin', widget);
    expect(admin.cache).toBe('miss');
    expect(cellOf(admin)).toEqual({ state: 'ready', reason: null });
    // A reader reads the same records and fields (same fingerprint) but cannot edit.
    const reader = await dataOf('u_reader', widget);
    expect(reader.cache).toBe('miss');
    expect(cellOf(reader)).toEqual({ state: 'disabled', reason: 'permission' });
    expect((await dataOf('u_admin', widget)).cache).toBe('miss');
    expect(await cacheKeys(widget)).toEqual([]);
  });
});
