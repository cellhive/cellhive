/**
 * Dashboard share links and embedding over HTTP (BACKLOG T809, CONTRACTS
 * §16, §16A; P71, P72): a dashboard link reads with its creator's
 * **current** access ∩ the dashboard — the numbers are the creator's, a
 * widget or global filter on a field the creator cannot read is not shown,
 * no saved filter leaves the server, a live filter source the dashboard
 * does not declare is `403`; the creator losing the dashboard makes the
 * link `410`; turned off / expired / password links behave like view
 * links; widget CSV only with `allow_export`; embedding only for public
 * links without password, `frame-ancestors` of the link on its page;
 * tenant isolation of the management routes.
 */
import {
  createdShareLinkSchema,
  dashboardSchema,
  roleListSchema,
  sharedDashboardSchema,
  shareLinkListSchema,
  shareLinkSchema,
  widgetDataSchema,
  widgetSchema,
  type CreatedShareLinkDto,
  type DashboardDto,
  type Id,
  type RoleDto,
  type WidgetDataDto,
  type WidgetDto,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShareRateLimits } from '../../src/common/rate-limit/share-rate-limits.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const ORIGIN = 'https://intranet.example.com';

describe('Dashboard share links and embedding (T809, P71, P72)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let board: DashboardDto;
  let other: DashboardDto;
  let sales: RoleDto;
  const w: Record<string, WidgetDto> = {};
  const tokens: string[] = [];

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const ok = (response: LightMyRequestResponse, status = 200) => {
    expect(response.statusCode, response.body).toBe(status);
    return response;
  };
  const widget = (name: string) => w[name] as WidgetDto;
  const newOption = () =>
    (fx.fld['status']?.options as { options: { id: string; name: string }[] }).options.find(
      (option) => option.name === 'Mới',
    )?.id as string;

  function expectProblem(
    response: LightMyRequestResponse,
    status: number,
    code: string,
    detail?: { path?: string; code: string },
  ): void {
    const problem = problemOf(response.body);
    expect({ status: response.statusCode, code: problem['code'] }, response.body).toEqual({
      status,
      code,
    });
    if (detail !== undefined) {
      expect(problem['errors']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: detail.code,
            ...(detail.path === undefined ? {} : { path: detail.path }),
          }),
        ]),
      );
    }
  }

  /** A request through a link by `browser` (anonymous unless it signed in). */
  function share(
    browser: Browser,
    method: 'GET' | 'POST',
    token: string,
    path: string,
    payload?: object,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    return browser.request({
      method,
      url: `/api/v1/shares/${token}${path}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  const linkData = async (
    token: string,
    name: string,
    filters: unknown[] = [],
  ): Promise<WidgetDataDto> =>
    widgetDataSchema.parse(
      ok(
        await share(new Browser(t.app), 'POST', token, `/widgets/${widget(name).id}/data`, {
          filters,
        }),
      ).json(),
    );
  const memberData = async (user: FixtureUser, name: string): Promise<WidgetDataDto> =>
    widgetDataSchema.parse(
      ok(await fx.call(user, 'POST', `/widgets/${widget(name).id}/data`, { filters: [] })).json(),
    );

  async function createLink(
    user: FixtureUser,
    dashboardId: Id<'dsh'>,
    body: object = {},
  ): Promise<CreatedShareLinkDto> {
    const response = ok(
      await fx.call(user, 'POST', `/dashboards/${dashboardId}/share-links`, body),
      201,
    );
    const link = createdShareLinkSchema.parse(response.json());
    tokens.push(link.token);
    return link;
  }

  async function patchSales(change: (config: Record<string, unknown>) => object): Promise<void> {
    const roles = roleListSchema.parse(
      ok(await fx.call('owner', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    );
    sales = roles.items.find((role) => role.name === 'Sales') as RoleDto;
    ok(
      await fx.call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
        config: change(sales.config),
      }),
    );
  }

  const addWidget = async (
    dashboardId: Id<'dsh'>,
    name: string,
    type: string,
    config: Record<string, unknown>,
  ) => {
    w[name] = widgetSchema.parse(
      ok(
        await fx.call('owner', 'POST', `/dashboards/${dashboardId}/widgets`, {
          type,
          title: name,
          config,
        }),
        201,
      ).json(),
    );
  };

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    const limits = t.app.get(ShareRateLimits);
    limits.read = { limit: 100_000, windowSeconds: 1 };
    limits.widget = { limit: 100_000, windowSeconds: 1 };

    const order = (title: string, owner: FixtureUser | null, status: string, cost: number) => ({
      fields: {
        title,
        amount: cost * 10,
        cost,
        status,
        owner: owner === null ? [] : [{ id: fx.users[owner].id }],
      },
    });
    ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records?typecast=true`, {
        records: [
          order('r1', 'u_sales1', 'Mới', 10),
          order('r2', 'u_sales2', 'Xong', 20),
          order('r3', null, 'Mới', 30),
          order('r4', 'u_sales1', 'Xong', 2000),
        ],
      }),
      201,
    );

    const orders = fx.orders.id;
    board = dashboardSchema.parse(
      ok(
        await fx.call('owner', 'POST', `/bases/${fx.baseId}/dashboards`, {
          name: 'Board',
          global_filters: [
            {
              id: 'spend',
              kind: 'number_range',
              targets: [{ table_id: orders, field: F('cost') }],
            },
            {
              id: 'size',
              kind: 'number_range',
              targets: [{ table_id: orders, field: F('amount') }],
            },
          ],
        }),
        201,
      ).json(),
    );
    const count = [{ id: 'm1', aggregation: 'count' }];
    await addWidget(board.id, 'ctl_status', 'filter_control', {
      table_id: orders,
      field: F('status'),
      control: 'select',
    });
    await addWidget(board.id, 'w_count', 'kpi', {
      table_id: orders,
      metrics: count,
      filter_bindings: [widget('ctl_status').id],
    });
    await addWidget(board.id, 'w_cost', 'kpi', {
      table_id: orders,
      metrics: [{ id: 'm1', aggregation: 'sum', field: F('cost') }],
    });
    await addWidget(board.id, 'w_status', 'bar', {
      table_id: orders,
      dimension: { field: F('status') },
      metrics: count,
      filter: { op: 'and', items: [{ field: F('amount'), operator: 'gt', value: 0 }] },
    });
    await addWidget(board.id, 'w_owner', 'pie', {
      table_id: orders,
      dimension: { field: F('owner') },
      metrics: count,
    });
    await addWidget(board.id, 'w_tickets', 'kpi', { table_id: fx.tickets.id, metrics: count });

    other = dashboardSchema.parse(
      ok(
        await fx.call('owner', 'POST', `/bases/${fx.baseId}/dashboards`, { name: 'Other' }),
        201,
      ).json(),
    );
    await addWidget(other.id, 'w_other', 'kpi', { table_id: orders, metrics: count });

    // Sales may share and reads Board (not Other); `cost` stays hidden, no download.
    await patchSales((config) => ({
      ...config,
      base_rule: { copy: false, download: false, share_link: true },
      dashboards: { [board.id]: 'read_only' },
    }));
  }, 120_000);

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('management', () => {
    it('creates the link of a dashboard: target dashboard, no table', async () => {
      const link = await createLink('u_sales1', board.id, { audience: 'public' });
      expect(link).toMatchObject({
        target_type: 'dashboard',
        target_id: board.id,
        table_id: null,
        audience: 'public',
      });
      const list = shareLinkListSchema.parse(
        ok(await fx.call('u_sales1', 'GET', `/dashboards/${board.id}/share-links`)).json(),
      );
      expect(list.items.map((item) => item.id)).toEqual([link.id]);
      const all = shareLinkListSchema.parse(
        ok(await fx.call('owner', 'GET', `/bases/${fx.baseId}/share-links`)).json(),
      );
      expect(all.items.find((item) => item.id === link.id)?.target_name).toBe('Board');
    });

    it('needs to read the dashboard (404) and the right to share (403)', async () => {
      // u_sales1 does not read Other.
      expectProblem(
        await fx.call('u_sales1', 'POST', `/dashboards/${other.id}/share-links`, {}),
        404,
        'NOT_FOUND',
      );
      // A system reader reads dashboards but may not share.
      expectProblem(
        await fx.call('u_reader', 'POST', `/dashboards/${board.id}/share-links`, {}),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await fx.call('u_out', 'GET', `/dashboards/${board.id}/share-links`),
        404,
        'NOT_FOUND',
      );
    });

    it('tenant isolation: another organization never sees the dashboard or its links', async () => {
      expectProblem(
        await fx.call('stranger', 'GET', `/dashboards/${board.id}/share-links`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('stranger', 'POST', `/dashboards/${board.id}/share-links`, {}),
        404,
        'NOT_FOUND',
      );
      const link = await createLink('owner', other.id, { audience: 'org' });
      const strangerBrowser = new Browser(t.app);
      ok(await strangerBrowser.login(fx.users.stranger.email), 204);
      expectProblem(
        await share(strangerBrowser, 'GET', link.token, '/dashboard'),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await share(new Browser(t.app), 'GET', link.token, '/dashboard'),
        401,
        'UNAUTHENTICATED',
      );
      const member = new Browser(t.app);
      ok(await member.login(fx.users.u_out.email), 204);
      ok(await share(member, 'GET', link.token, '/dashboard'));
      ok(await fx.call('owner', 'DELETE', `/share-links/${link.id}`), 204);
    });

    it('validates the refresh period (30–3600 s)', async () => {
      for (const refresh of [29, 3601]) {
        expectProblem(
          await fx.call('owner', 'POST', `/dashboards/${other.id}/share-links`, {
            settings: { dashboard: { refresh_seconds: refresh } },
          }),
          422,
          'VALIDATION_FAILED',
        );
      }
    });
  });

  describe("P71: the link reads with the creator's current access ∩ the dashboard", () => {
    let link: CreatedShareLinkDto;

    beforeAll(async () => {
      link = await createLink('u_sales1', board.id, { audience: 'public' });
    });

    it('shows no widget, field or global filter outside the scope, no saved filter', async () => {
      const response = ok(await share(new Browser(t.app), 'GET', link.token, '/dashboard'));
      const shared = sharedDashboardSchema.parse(response.json());
      const byTitle = new Map(shared.widgets.map((item) => [item.title, item]));
      expect(byTitle.get('w_cost')).toMatchObject({ status: 'no_permission', config: null });
      expect(byTitle.get('w_tickets')).toMatchObject({ status: 'no_permission', config: null });
      expect(byTitle.get('w_status')).toMatchObject({ status: 'ok' });
      expect(byTitle.get('w_status')?.config?.['filter']).toBeNull();
      expect(shared.dashboard.global_filters.map((filter) => filter.id)).toEqual(['size']);
      expect(shared.fields.map((field) => field.id)).not.toContain(F('cost'));
      // Nothing of `cost`, the tickets table or the saved filter value anywhere.
      expect(response.body).not.toContain(F('cost'));
      expect(response.body).not.toContain(fx.tickets.id);
      expect(response.body).not.toContain('"gt"');
      expect(shared.settings).toEqual({
        allow_filter_controls: true,
        refresh_seconds: 60,
        tv_mode: false,
        allow_export: false,
      });
      // No realtime for links: the response sets no cookie, the page polls.
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
    });

    it("computes the creator's numbers, never another reader's cached ones", async () => {
      // Warm the cache with the admin's numbers first.
      expect((await memberData('u_admin', 'w_count')).rows).toEqual([[4]]);
      const own = await memberData('u_sales1', 'w_count');
      expect(own.rows).toEqual([[2]]);
      expect((await linkData(link.token, 'w_count')).rows).toEqual(own.rows);
      const cost = await linkData(link.token, 'w_cost');
      expect(cost.status).toBe('no_permission');
      expect(cost.rows).toEqual([]);
      expect((await linkData(link.token, 'w_tickets')).status).toBe('no_permission');
    });

    it('sends users by id and name only', async () => {
      const response = ok(
        await share(
          new Browser(t.app),
          'POST',
          link.token,
          `/widgets/${widget('w_owner').id}/data`,
        ),
      );
      expect(response.body).not.toContain('@example.test');
      expect(response.body).not.toContain('"email"');
    });

    it('P30 sweep: no response through the link names a field outside its scope', async () => {
      const bodies: string[] = [];
      for (const name of ['w_count', 'w_cost', 'w_status', 'w_owner', 'w_tickets']) {
        const response = ok(
          await share(new Browser(t.app), 'POST', link.token, `/widgets/${widget(name).id}/data`),
        );
        bodies.push(response.body);
      }
      bodies.push(
        ok(
          await share(
            new Browser(t.app),
            'POST',
            link.token,
            `/widgets/${widget('ctl_status').id}/options`,
          ),
        ).body,
      );
      for (const body of bodies) {
        expect(body).not.toContain(F('cost'));
        expect(body).not.toContain(fx.tickets.id);
      }
    });

    it('applies declared live filters; a hidden-field filter is set aside', async () => {
      const spend = { source: 'global', id: 'spend', value: { range: { from: 0, to: 15 } } };
      const result = await linkData(link.token, 'w_count', [spend]);
      expect(result.rows).toEqual([[2]]);
      expect(result.ignored_filters).toEqual([
        { source: 'global', id: 'spend', reason: 'no_permission' },
      ]);
      const status = {
        source: 'control',
        widget_id: widget('ctl_status').id,
        value: { values: [newOption()] },
      };
      const response = await share(
        new Browser(t.app),
        'POST',
        link.token,
        `/widgets/${widget('w_count').id}/data`,
        { filters: [status] },
      );
      // Of the creator's r1 (Mới) and r4 (Xong): r1.
      expect(widgetDataSchema.parse(ok(response).json()).rows).toEqual([[1]]);
    });

    it('a filter source the dashboard does not declare is 403 NOT_ALLOWED', async () => {
      const cases = [
        { source: 'global', id: 'nope', value: { range: { from: 0, to: 1 } } },
        { source: 'control', widget_id: widget('w_other').id, value: { values: [] } },
      ];
      for (const filter of cases) {
        expectProblem(
          await share(
            new Browser(t.app),
            'POST',
            link.token,
            `/widgets/${widget('w_count').id}/data`,
            { filters: [filter] },
          ),
          403,
          'PERMISSION_DENIED',
          { code: 'NOT_ALLOWED' },
        );
      }
    });

    it('only the widgets of the dashboard, no click-through, no view routes', async () => {
      const anonymous = new Browser(t.app);
      expectProblem(
        await share(anonymous, 'POST', link.token, `/widgets/${widget('w_other').id}/data`, {}),
        404,
        'NOT_FOUND',
      );
      const records = await share(
        anonymous,
        'POST',
        link.token,
        `/widgets/${widget('w_count').id}/records`,
        {},
      );
      expect(records.statusCode).toBe(404);
      expectProblem(await share(anonymous, 'GET', link.token, '/meta'), 404, 'NOT_FOUND', {
        code: 'DASHBOARD_LINK',
      });
      expectProblem(
        await share(anonymous, 'POST', link.token, '/records/query', {}),
        404,
        'NOT_FOUND',
      );
      expectProblem(await share(anonymous, 'GET', link.token, '/export'), 404, 'NOT_FOUND');
    });

    it('allow_filter_controls = false: no live filter, no control values', async () => {
      const updated = shareLinkSchema.parse(
        ok(
          await fx.call('u_sales1', 'PATCH', `/share-links/${link.id}`, {
            settings: { dashboard: { allow_filter_controls: false } },
          }),
        ).json(),
      );
      expect(updated.settings.dashboard).toMatchObject({
        allow_filter_controls: false,
        refresh_seconds: 60,
      });
      const anonymous = new Browser(t.app);
      const size = { source: 'global', id: 'size', value: { range: { from: 0, to: 150 } } };
      expectProblem(
        await share(anonymous, 'POST', link.token, `/widgets/${widget('w_count').id}/data`, {
          filters: [size],
        }),
        403,
        'PERMISSION_DENIED',
        { path: 'filters', code: 'NOT_ALLOWED' },
      );
      expectProblem(
        await share(anonymous, 'POST', link.token, `/widgets/${widget('ctl_status').id}/options`),
        403,
        'PERMISSION_DENIED',
        { code: 'NOT_ALLOWED' },
      );
      // Without filters the widget still answers.
      expect((await linkData(link.token, 'w_count')).rows).toEqual([[2]]);
      ok(
        await fx.call('u_sales1', 'PATCH', `/share-links/${link.id}`, {
          settings: { dashboard: { allow_filter_controls: true } },
        }),
      );
    });

    it('widget CSV only with allow_export and the creator’s download right', async () => {
      const url = `/widgets/${widget('w_status').id}/export?format=csv`;
      expectProblem(
        await share(new Browser(t.app), 'GET', link.token, url),
        403,
        'PERMISSION_DENIED',
        { code: 'NOT_ALLOWED' },
      );
      ok(
        await fx.call('u_sales1', 'PATCH', `/share-links/${link.id}`, {
          settings: { allow_export: true },
        }),
      );
      // Sales has no `base_rule.download`.
      expectProblem(
        await share(new Browser(t.app), 'GET', link.token, url),
        403,
        'PERMISSION_DENIED',
      );

      const ownerLink = await createLink('owner', other.id, {
        audience: 'public',
        settings: { allow_export: true },
      });
      const csv = ok(
        await share(
          new Browser(t.app),
          'GET',
          ownerLink.token,
          `/widgets/${widget('w_other').id}/export?format=csv`,
        ),
      );
      expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(csv.headers['content-disposition']).toContain('attachment');
      expect(csv.body).toContain('4');
      const audit = await sql<{ actor_type: string; actor_id: string; after: unknown }>`
        SELECT actor_type, actor_id, after FROM meta.audit_logs
         WHERE action = 'export.created' AND actor_id = ${ownerLink.id}`.execute(db.kysely);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        actor_type: 'share_link',
        after: expect.objectContaining({ share_link_id: ownerLink.id, row_count: 1 }) as unknown,
      });
      ok(await fx.call('owner', 'DELETE', `/share-links/${ownerLink.id}`), 204);
    });

    it('410 once the creator no longer reads the dashboard; back when restored', async () => {
      await patchSales((config) => ({ ...config, dashboards: {} }));
      expectProblem(
        await share(new Browser(t.app), 'GET', link.token, '/dashboard'),
        410,
        'SHARE_LINK_GONE',
      );
      expectProblem(
        await share(
          new Browser(t.app),
          'POST',
          link.token,
          `/widgets/${widget('w_count').id}/data`,
        ),
        410,
        'SHARE_LINK_GONE',
      );
      await patchSales((config) => ({ ...config, dashboards: { [board.id]: 'read_only' } }));
      ok(await share(new Browser(t.app), 'GET', link.token, '/dashboard'));

      // Losing the right to share also ends the link.
      await patchSales((config) => ({
        ...config,
        base_rule: { copy: false, download: false, share_link: false },
      }));
      expectProblem(
        await share(new Browser(t.app), 'GET', link.token, '/dashboard'),
        410,
        'SHARE_LINK_GONE',
      );
      await patchSales((config) => ({
        ...config,
        base_rule: { copy: false, download: false, share_link: true },
      }));
    });
  });

  describe('turned off, expired and password links', () => {
    it('a turned off or expired link is 410, a revoked one too', async () => {
      const link = await createLink('owner', other.id, { audience: 'public' });
      const anonymous = new Browser(t.app);
      ok(await share(anonymous, 'GET', link.token, '/dashboard'));
      ok(await fx.call('owner', 'PATCH', `/share-links/${link.id}`, { enabled: false }));
      expectProblem(
        await share(anonymous, 'GET', link.token, '/dashboard'),
        410,
        'SHARE_LINK_GONE',
      );
      ok(await fx.call('owner', 'PATCH', `/share-links/${link.id}`, { enabled: true }));
      ok(await share(anonymous, 'GET', link.token, '/dashboard'));
      await sql`UPDATE meta.share_links SET expires_at = now() - interval '1 minute'
                 WHERE id = ${link.id}`.execute(db.kysely);
      expectProblem(
        await share(anonymous, 'GET', link.token, '/dashboard'),
        410,
        'SHARE_LINK_GONE',
      );
      expectProblem(
        await share(anonymous, 'POST', link.token, `/widgets/${widget('w_other').id}/data`),
        410,
        'SHARE_LINK_GONE',
      );
      // A new link revokes the previous one.
      const next = await createLink('owner', other.id, { audience: 'public' });
      ok(await share(anonymous, 'GET', next.token, '/dashboard'));
      ok(await fx.call('owner', 'DELETE', `/share-links/${next.id}`), 204);
      expectProblem(
        await share(anonymous, 'GET', next.token, '/dashboard'),
        410,
        'SHARE_LINK_GONE',
      );
      expectProblem(await share(anonymous, 'GET', 'x'.repeat(43), '/dashboard'), 404, 'NOT_FOUND');
    });

    it('a password link needs its unlock (and the CSRF token on POST)', async () => {
      const link = await createLink('owner', other.id, {
        audience: 'public',
        password: 'correct horse battery',
      });
      const visitor = new Browser(t.app);
      expectProblem(
        await share(visitor, 'GET', link.token, '/dashboard'),
        403,
        'SHARE_PASSWORD_REQUIRED',
      );
      expectProblem(
        await share(visitor, 'POST', link.token, `/widgets/${widget('w_other').id}/data`),
        403,
        'SHARE_PASSWORD_REQUIRED',
      );
      const unlocked = ok(
        await share(visitor, 'POST', link.token, '/unlock', { password: 'correct horse battery' }),
      ).json<{ csrf_token: string }>();
      const shared = sharedDashboardSchema.parse(
        ok(await share(visitor, 'GET', link.token, '/dashboard')).json(),
      );
      expect(shared.csrf_token).toBe(unlocked.csrf_token);
      expectProblem(
        await share(visitor, 'POST', link.token, `/widgets/${widget('w_other').id}/data`),
        403,
        'CSRF_INVALID',
      );
      const data = widgetDataSchema.parse(
        ok(
          await share(
            visitor,
            'POST',
            link.token,
            `/widgets/${widget('w_other').id}/data`,
            {},
            { 'x-share-csrf-token': unlocked.csrf_token },
          ),
        ).json(),
      );
      expect(data.rows).toEqual([[4]]);
      ok(await fx.call('owner', 'DELETE', `/share-links/${link.id}`), 204);
    });
  });

  describe('P72: embedding', () => {
    const page = (token: string) =>
      new Browser(t.app).request({ method: 'GET', url: `/api/v1/shares/${token}/page` });
    const ancestorsOf = (response: LightMyRequestResponse) =>
      String(response.headers['content-security-policy']).split('; ').at(-1);

    it('only a public link without password, with valid origins', async () => {
      const create = (body: object) =>
        fx.call('owner', 'POST', `/dashboards/${other.id}/share-links`, body);
      expectProblem(
        await create({
          audience: 'org',
          settings: { embed: { enabled: true, allowed_origins: [ORIGIN] } },
        }),
        422,
        'VALIDATION_FAILED',
        { path: 'settings.embed.enabled', code: 'EMBED_NOT_SUPPORTED' },
      );
      expectProblem(
        await create({
          audience: 'public',
          password: 'correct horse battery',
          settings: { embed: { enabled: true, allowed_origins: [ORIGIN] } },
        }),
        422,
        'VALIDATION_FAILED',
        { path: 'settings.embed.enabled', code: 'EMBED_NOT_SUPPORTED' },
      );
      for (const origin of [
        'http://intranet.example.com',
        `${ORIGIN}/path`,
        'https://*.example.com',
        "'self'",
      ]) {
        expectProblem(
          await create({
            audience: 'public',
            settings: { embed: { enabled: true, allowed_origins: [ORIGIN, origin] } },
          }),
          422,
          'VALIDATION_FAILED',
          { path: 'settings.embed.allowed_origins[1]', code: 'INVALID_ORIGIN' },
        );
      }
      expectProblem(
        await create({ audience: 'public', settings: { embed: { enabled: true } } }),
        422,
        'VALIDATION_FAILED',
        { path: 'settings.embed.allowed_origins', code: 'INVALID_ORIGIN' },
      );
    });

    it("the page of an embeddable link is framed by the link's origins only", async () => {
      const link = await createLink('owner', other.id, {
        audience: 'public',
        settings: {
          embed: { enabled: true, allowed_origins: [`${ORIGIN}/`, 'https://B.example.com:443'] },
        },
      });
      expect(link.settings.embed.allowed_origins).toEqual([ORIGIN, 'https://b.example.com']);
      const response = ok(await page(link.token));
      expect(response.headers['x-accel-redirect']).toBe('/_share/embed');
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['x-frame-options']).toBeUndefined();
      expect(ancestorsOf(response)).toBe(`frame-ancestors ${ORIGIN} https://b.example.com`);
      expect(String(response.headers['content-security-policy'])).toContain("script-src 'self'");
      expect(response.body).toBe('');

      // Turning embedding off, or making the link private, ends framing.
      ok(
        await fx.call('owner', 'PATCH', `/share-links/${link.id}`, {
          settings: { embed: { enabled: false } },
        }),
      );
      const off = ok(await page(link.token));
      expect(ancestorsOf(off)).toBe("frame-ancestors 'none'");
      expect(off.headers['x-frame-options']).toBe('DENY');
      ok(
        await fx.call('owner', 'PATCH', `/share-links/${link.id}`, {
          settings: { embed: { enabled: true } },
        }),
      );
      expect(ancestorsOf(ok(await page(link.token)))).toBe(
        `frame-ancestors ${ORIGIN} https://b.example.com`,
      );
      // An org audience or a password with embedding on is refused.
      expectProblem(
        await fx.call('owner', 'PATCH', `/share-links/${link.id}`, { audience: 'org' }),
        422,
        'VALIDATION_FAILED',
        { code: 'EMBED_NOT_SUPPORTED' },
      );
      expectProblem(
        await fx.call('owner', 'PATCH', `/share-links/${link.id}`, {
          password: 'correct horse battery',
        }),
        422,
        'VALIDATION_FAILED',
        { code: 'EMBED_NOT_SUPPORTED' },
      );
      // A turned off link is not framed either.
      ok(await fx.call('owner', 'PATCH', `/share-links/${link.id}`, { enabled: false }));
      const disabled = ok(await page(link.token));
      expect(ancestorsOf(disabled)).toBe("frame-ancestors 'none'");
      expect(disabled.headers['x-frame-options']).toBe('DENY');
      ok(await fx.call('owner', 'DELETE', `/share-links/${link.id}`), 204);
    });

    it("unknown, revoked and non-embedded links: frame-ancestors 'none', DENY", async () => {
      const plain = await createLink('owner', other.id, { audience: 'public' });
      for (const token of [plain.token, 'x'.repeat(43), 'short']) {
        const response = ok(await page(token));
        expect(ancestorsOf(response)).toBe("frame-ancestors 'none'");
        expect(response.headers['x-frame-options']).toBe('DENY');
        expect(response.headers['x-accel-redirect']).toBe('/_share/embed');
      }
      ok(await fx.call('owner', 'DELETE', `/share-links/${plain.id}`), 204);
    });
  });

  it('never stores, logs or audits a token', async () => {
    const audit = await sql<{ text: string }>`
      SELECT coalesce(before::text, '') || coalesce(after::text, '') || coalesce(via::text, '') AS text
        FROM meta.audit_logs`.execute(db.kysely);
    const links = await sql<{
      text: string;
    }>`SELECT row_to_json(l)::text AS text FROM meta.share_links l`.execute(db.kysely);
    for (const token of tokens) {
      for (const row of [...audit.rows, ...links.rows]) expect(row.text).not.toContain(token);
    }
  });
});
