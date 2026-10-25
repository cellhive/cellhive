import {
  baseDetailSchema,
  createdShareLinkSchema,
  fieldListSchema,
  fieldSchema,
  recordGroupCountsResponseSchema,
  recordListResponseSchema,
  recordSchema,
  recordsResponseSchema,
  roleListSchema,
  roleSchema,
  SHARE_CSRF_HEADER,
  shareMetaSchema,
  shareUnlockResponseSchema,
  tableSchema,
  viewSchema,
  workspaceSchema,
  type CreatedShareLinkDto,
  type FieldDto,
  type Id,
  type RoleDto,
  type TableDto,
  type ViewDto,
} from '@cellhive/contracts';
import { ShareLinksRepository, orgScope, type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from 'vitest';

import {
  DEFAULT_SHARE_READ_RATE_LIMIT,
  ShareRateLimits,
} from '../../src/common/rate-limit/share-rate-limits.js';
import { FormSpamGuard } from '../../src/modules/form/form-spam-guard.js';
import { ShareAccessStats } from '../../src/modules/share/share-access-stats.js';

import { Browser, seedOrg, seedUser, setCookiesOf, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * T305: public read-only access through share links — P30 over HTTP, view
 * filter never removable, scope of fields, link settings, password +
 * unlock cookie + CSRF + lockout, audience `org`, `410`, per-IP rate limit,
 * noindex/no-referrer headers, batched access statistics; T317: group
 * counts through a link.
 */
describe('public share endpoints (T305)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let org: Id<'org'>;
  let owner: SeededUser;
  let sales1: SeededUser;
  let sales2: SeededUser;
  let outsider: SeededUser;
  let stranger: SeededUser;
  let baseId: Id<'bse'>;
  let orders: TableDto;
  let primary: FieldDto;
  const f = {} as Record<'amount' | 'cost' | 'status' | 'owner', FieldDto>;
  let salesShare: RoleDto;
  let viewSales: ViewDto;
  let formView: ViewDto;
  const r = {} as Record<'r1' | 'r2' | 'r3', Id<'rec'>>;
  const tokens: string[] = [];
  const browsers = new Map<string, Browser>();

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    // Fast test sequences from one IP must not trip the per-IP limit; one test sets its own.
    t.app.get(ShareRateLimits).read = { limit: 100_000, windowSeconds: 1 };
    org = await seedOrg(db, 'Public share');
    const otherOrg = await seedOrg(db, 'Elsewhere');
    const member = (role: 'owner' | 'member') => ({ memberships: [{ orgId: org, role }] });
    owner = await seedUser(db, member('owner'));
    sales1 = await seedUser(db, { ...member('member'), displayName: 'Sales One' });
    sales2 = await seedUser(db, member('member'));
    outsider = await seedUser(db, member('member'));
    stranger = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] });

    const workspace = workspaceSchema.parse(
      (await call(owner, 'POST', `/orgs/${org}/workspaces`, { name: 'Main' })).json(),
    );
    baseId = baseDetailSchema.parse(
      (await call(owner, 'POST', `/workspaces/${workspace.id}/bases`, { name: 'CRM' })).json(),
    ).id;
    orders = tableSchema.parse(
      (await call(owner, 'POST', `/bases/${baseId}/tables`, { name: 'Orders' })).json(),
    );
    const field = async (body: object) => {
      const response = await call(owner, 'POST', `/tables/${orders.id}/fields`, body);
      expect(response.statusCode, response.body).toBe(201);
      return fieldSchema.parse(response.json());
    };
    f.amount = await field({ name: 'amount', type: 'number' });
    f.cost = await field({ name: 'cost', type: 'number' });
    f.status = await field({
      name: 'status',
      type: 'select',
      options: { options: [{ name: 'New' }, { name: 'Done' }] },
    });
    f.owner = await field({ name: 'owner', type: 'user', options: { multiple: false } });
    primary = fieldListSchema
      .parse((await call(owner, 'GET', `/tables/${orders.id}/fields`)).json())
      .items.find((item) => item.is_primary) as FieldDto;

    const created = recordsResponseSchema.parse(
      (
        await call(owner, 'POST', `/tables/${orders.id}/records?field_key_type=id`, {
          records: [
            {
              fields: {
                [primary.id]: 'r1',
                [f.amount.id]: 10,
                [f.cost.id]: 1,
                [f.status.id]: 'New',
                [f.owner.id]: [{ id: sales1.id }],
              },
            },
            {
              fields: {
                [primary.id]: 'r2',
                [f.amount.id]: 20,
                [f.cost.id]: 2,
                [f.status.id]: 'Done',
                [f.owner.id]: [{ id: sales2.id }],
              },
            },
            { fields: { [primary.id]: 'r3', [f.amount.id]: 0, [f.cost.id]: 3 } },
          ],
        })
      ).json(),
    ).records;
    [r.r1, r.r2, r.r3] = created.map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];

    viewSales = await createView({
      name: 'Sales',
      type: 'grid',
      config: {
        filter: { op: 'and', items: [{ field: f.amount.id, operator: 'gt', value: 0 }] },
        sort: [{ field: f.amount.id, direction: 'desc' }],
        hidden_fields: [f.status.id],
      },
    });
    formView = await createView({ name: 'Order form', type: 'form' });
    salesShare = await createSalesRole();
    const roles = roleListSchema.parse((await call(owner, 'GET', `/bases/${baseId}/roles`)).json());
    expect(roles.items.length).toBeGreaterThan(0);
    await assign(sales1, salesShare.id);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  async function as(user: SeededUser): Promise<Browser> {
    let browser = browsers.get(user.id);
    if (browser === undefined) {
      browser = new Browser(t.app);
      expect((await browser.login(user.email)).statusCode).toBe(204);
      browsers.set(user.id, browser);
    }
    return browser;
  }

  async function call(
    user: SeededUser,
    method: Method,
    url: string,
    payload?: object,
  ): Promise<LightMyRequestResponse> {
    return (await as(user)).request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
    });
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

  async function assign(user: SeededUser, roleId: Id<'rol'>): Promise<void> {
    const response = await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: user.id,
      role_id: roleId,
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function createView(body: Record<string, unknown>): Promise<ViewDto> {
    const response = await call(owner, 'POST', `/tables/${orders.id}/views`, body);
    expect(response.statusCode, response.body).toBe(201);
    return viewSchema.parse(response.json());
  }

  /** Sales of CONTRACTS §5 with `base_rule.share_link = true` (BACKLOG S3 decision 1). */
  async function createSalesRole(): Promise<RoleDto> {
    const response = await call(owner, 'POST', `/bases/${baseId}/roles`, {
      name: 'Sales sharing',
      config: {
        base_rule: { copy: false, download: false, share_link: true },
        tables: {
          [orders.id]: {
            perm: 'edit',
            view_rule: { allow_edit: false, visible_views: [viewSales.id] },
            record_rule: {
              operations: ['add'],
              edit_filter: {
                op: 'and',
                items: [
                  { field: f.owner.id, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
                ],
              },
              read_scope: 'editable',
            },
            field_rule: {
              mode: 'specify',
              fields: { [f.cost.id]: 'no_perm', [f.status.id]: 'read' },
            },
          },
        },
        dashboards: {},
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return roleSchema.parse(response.json());
  }

  async function createLink(
    user: SeededUser,
    viewId: Id<'viw'>,
    body: object = {},
  ): Promise<CreatedShareLinkDto> {
    const response = await call(user, 'POST', `/views/${viewId}/share-links`, body);
    expect(response.statusCode, response.body).toBe(201);
    const link = createdShareLinkSchema.parse(response.json());
    tokens.push(link.token);
    return link;
  }

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

  function names(response: LightMyRequestResponse): string[] {
    expect(response.statusCode, response.body).toBe(200);
    return recordListResponseSchema
      .parse(response.json())
      .records.map((record) => record.fields[primary.name] as string);
  }

  const query = (browser: Browser, token: string, body: object = {}) =>
    share(browser, 'POST', token, '/records/query', body);

  describe('P30: a public link of the Sales view (share_link variant)', () => {
    it('shows only r1, without cost or fields hidden in the view', async () => {
      const link = await createLink(sales1, viewSales.id, { audience: 'public' });
      const anonymous = new Browser(t.app);
      const response = await query(anonymous, link.token, {});
      expect(response.statusCode, response.body).toBe(200);
      const page = recordListResponseSchema.parse(response.json());
      expect(page.records.map((record) => record.id)).toEqual([r.r1]);
      expect(page).toMatchObject({ total: 1 });
      const keys = Object.keys(page.records[0]?.fields ?? {});
      expect(keys).toContain('amount');
      expect(keys).not.toContain('cost');
      expect(keys).not.toContain('status');
      // User values never carry emails through a link.
      expect(page.records[0]?.fields['owner']).toEqual([{ id: sales1.id, name: 'Sales One' }]);
      expect(response.body).not.toContain(sales1.email);

      const meta = shareMetaSchema.parse(
        (await share(anonymous, 'GET', link.token, '/meta')).json(),
      );
      expect(meta.fields.map((item) => item.id).sort()).toEqual(
        [primary.id, f.amount.id, f.owner.id].sort(),
      );
      expect(meta.view).toMatchObject({ id: viewSales.id, name: 'Sales', type: 'grid' });
      expect(meta.view.config).not.toHaveProperty('filter');
      expect(meta.view.config.sort).toEqual([{ field: f.amount.id, direction: 'desc' }]);
      expect(meta.view.config.hidden_fields).toEqual([]);
      expect(meta.target_type).toBe('view');
      expect(meta.csrf_token).toBeNull();
      // Nothing about the organization, the creator or the base.
      const body = JSON.stringify(meta);
      for (const secret of [org, baseId, sales1.id, 'Sales One', 'Public share']) {
        expect(body).not.toContain(secret);
      }

      // The record detail: r1 only; r2 (outside the creator's rule) and r3 (outside the view) are 404.
      const detail = await share(anonymous, 'GET', link.token, `/records/${r.r1}`);
      expect(detail.statusCode, detail.body).toBe(200);
      expect(Object.keys(recordSchema.parse(detail.json()).fields)).not.toContain('cost');
      for (const id of [r.r2, r.r3, 'rec_doesNotExist0001', 'nope']) {
        expectProblem(
          await share(anonymous, 'GET', link.token, `/records/${id}`),
          404,
          'NOT_FOUND',
        );
      }
    });

    it('answers 410 once the creator loses the role, 200 again when it comes back', async () => {
      const link = await createLink(sales1, viewSales.id, { audience: 'public' });
      const anonymous = new Browser(t.app);
      expect((await query(anonymous, link.token)).statusCode).toBe(200);
      const removed = await call(owner, 'DELETE', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: sales1.id,
      });
      expect(removed.statusCode).toBe(204);
      expectProblem(await query(anonymous, link.token), 410, 'SHARE_LINK_GONE');
      expectProblem(await share(anonymous, 'GET', link.token, '/meta'), 410, 'SHARE_LINK_GONE');
      await assign(sales1, salesShare.id);
      expect((await query(anonymous, link.token)).statusCode).toBe(200);
    });
  });

  /**
   * T319: every read route of `/shares/:token/*` × the ways a viewer can ask
   * for more (explicit `fields`, `ids`, `field_key_type`, `cell_format`,
   * search, grouping, detail), generated from the C§5 fixture: the answer
   * never carries a field outside the link (`cost`: `no_perm` for the
   * creator; `status`: hidden in the view), a record outside it (r2: the
   * creator's record rule; r3: the view filter), an email, or the
   * organization, base, role or creator.
   */
  describe('P30 sweep: no share route answers outside the link (T319)', () => {
    it('keeps every read route inside the link, whatever the viewer asks for', async () => {
      const link = await createLink(sales1, viewSales.id, { audience: 'public' });
      const anonymous = new Browser(t.app);
      const inScope = [primary, f.amount, f.owner];
      const requests: [string, 'GET' | 'POST', string, object?][] = [
        ['meta', 'GET', '/meta'],
        ['query', 'POST', '/records/query', {}],
        ['query by id', 'POST', '/records/query?field_key_type=id', {}],
        ['query as text', 'POST', '/records/query?cell_format=text', {}],
        ['query ids', 'POST', '/records/query', { ids: [r.r1, r.r2, r.r3] }],
        ['query fields', 'POST', '/records/query', { fields: inScope.map((item) => item.name) }],
        [
          'query field ids',
          'POST',
          '/records/query?field_key_type=id',
          { fields: inScope.map((item) => item.id) },
        ],
        ['query search', 'POST', '/records/query', { search: 'r' }],
        ['query total', 'POST', '/records/query', { include_total: true, limit: 1000 }],
        [
          'query filter',
          'POST',
          '/records/query',
          {
            filter: {
              logic: 'or',
              conditions: [
                ['amount', '>=', 0],
                ['amount', '<', 0],
              ],
            },
          },
        ],
        ['query group', 'POST', '/records/query', { group: [{ field: 'owner' }] }],
        ['counts', 'POST', '/records/group-counts', { group: [{ field: 'owner' }] }],
        [
          'counts by id',
          'POST',
          '/records/group-counts?field_key_type=id',
          { group: [{ field: f.amount.id }, { field: f.owner.id }] },
        ],
        ['counts search', 'POST', '/records/group-counts', { search: 'r', group: [] }],
        ['detail', 'GET', `/records/${r.r1}`],
        ['detail by id', 'GET', `/records/${r.r1}?field_key_type=id`],
        ['detail as text', 'GET', `/records/${r.r1}?cell_format=text`],
      ];
      const outside = [
        f.cost.id,
        f.status.id,
        '"cost"',
        '"status"',
        r.r2,
        r.r3,
        sales1.email,
        sales2.email,
        org,
        baseId,
        salesShare.id,
        'Public share',
      ];
      for (const [label, method, path, payload] of requests) {
        const response = await share(anonymous, method, link.token, path, payload);
        expect(response.statusCode, `${label}: ${response.body}`).toBe(200);
        for (const secret of outside) {
          expect(response.body, `${label} leaks ${secret}`).not.toContain(secret);
        }
      }

      // Asking for anything outside the link is answered like asking for a field that does not exist.
      const refused: [string, string, object][] = [
        ['query cost', '/records/query', { fields: ['cost'] }],
        ['query cost id', '/records/query?field_key_type=id', { fields: [f.cost.id] }],
        [
          'filter cost',
          '/records/query',
          { filter: { logic: 'and', conditions: [['cost', '>', 0]] } },
        ],
        ['sort cost', '/records/query', { sort: [{ field: 'cost' }] }],
        ['group cost', '/records/query', { group: [{ field: 'cost' }] }],
        ['counts cost', '/records/group-counts', { group: [{ field: 'cost' }] }],
        ['counts status', '/records/group-counts', { group: [{ field: 'status' }] }],
      ];
      for (const [label, path, payload] of refused) {
        const response = await share(anonymous, 'POST', link.token, path, payload);
        const missing = await share(
          anonymous,
          'POST',
          link.token,
          path,
          JSON.parse(
            JSON.stringify(payload)
              .replaceAll(f.cost.id, 'fld_doesNotExist0001')
              .replaceAll('"cost"', '"nope"')
              .replaceAll('"status"', '"nope"'),
          ) as object,
        );
        expect(response.statusCode, `${label}: ${response.body}`).toBe(422);
        expect(
          [problemOf(response.body)['code'], problemOf(response.body)['errors']],
          label,
        ).toEqual([
          problemOf(missing.body)['code'],
          (problemOf(missing.body)['errors'] as { path: string; code: string }[]).map(
            (item): unknown => expect.objectContaining({ path: item.path, code: item.code }),
          ),
        ]);
      }
      for (const id of [r.r2, r.r3]) {
        expectProblem(
          await share(anonymous, 'GET', link.token, `/records/${id}`),
          404,
          'NOT_FOUND',
        );
      }
    });

    it('keeps a form link to the fields of its form', async () => {
      const narrow = await createView({
        name: 'Narrow form',
        type: 'form',
        config: { form: { fields: [{ field: primary.id }, { field: f.amount.id }] } },
      });
      const link = await createLink(owner, narrow.id, { audience: 'public' });
      const anonymous = new Browser(t.app);
      const meta = shareMetaSchema.parse(
        (await share(anonymous, 'GET', link.token, '/meta')).json(),
      );
      expect(meta.fields.map((field) => field.id).sort()).toEqual([primary.id, f.amount.id].sort());
      for (const path of ['/meta', '/submit-token']) {
        const response = await share(anonymous, 'GET', link.token, path);
        expect(response.statusCode, response.body).toBe(200);
        for (const secret of [f.cost.id, f.status.id, f.owner.id, org, baseId, owner.email]) {
          expect(response.body, `${path} leaks ${secret}`).not.toContain(secret);
        }
      }
      for (const path of ['/records/query', '/records/group-counts']) {
        expectProblem(await share(anonymous, 'POST', link.token, path, {}), 404, 'NOT_FOUND');
      }
      expectProblem(
        await share(anonymous, 'GET', link.token, `/records/${r.r1}`),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('viewer filter, sort, search', () => {
    let token: string;
    let anonymous: Browser;

    beforeAll(async () => {
      token = (await createLink(owner, viewSales.id, { audience: 'public' })).token;
      anonymous = new Browser(t.app);
    });

    it('reads through the view: its filter and sort apply', async () => {
      expect(names(await query(anonymous, token))).toEqual(['r2', 'r1']);
    });

    it('cannot remove the view filter', async () => {
      const zero = { logic: 'and', conditions: [['amount', '==', 0]] };
      expect(names(await query(anonymous, token, { filter: zero }))).toEqual([]);
      const any = {
        logic: 'or',
        conditions: [
          ['amount', '>=', 0],
          ['amount', '<', 1000],
        ],
      };
      expect(names(await query(anonymous, token, { filter: any }))).toEqual(['r2', 'r1']);
      expect(
        names(
          await query(anonymous, token, {
            ids: [r.r1, r.r2, r.r3],
            sort: [{ field: primary.name }],
          }),
        ),
      ).toEqual(['r2', 'r1']);
    });

    it('treats fields outside the link (hidden in the view) as missing', async () => {
      expectProblem(
        await query(anonymous, token, {
          filter: { logic: 'and', conditions: [['status', 'intersects', ['New']]] },
        }),
        422,
        'INVALID_FILTER',
        { code: 'UNKNOWN_FIELD' },
      );
      // Same answer as a field that does not exist at all.
      const errorsOf = async (name: string) =>
        (
          problemOf(
            (
              await query(anonymous, token, {
                filter: { logic: 'and', conditions: [[name, '==', 1]] },
              })
            ).body,
          )['errors'] as { path: string; code: string }[]
        ).map((item) => [item.path, item.code]);
      expect(await errorsOf('status')).toEqual(await errorsOf('nope'));
      expectProblem(
        await query(anonymous, token, { sort: [{ field: 'status' }] }),
        422,
        'INVALID_SORT',
        { code: 'UNKNOWN_FIELD' },
      );
      expectProblem(
        await query(anonymous, token, { fields: ['status'] }),
        422,
        'VALIDATION_FAILED',
        {
          code: 'UNKNOWN_FIELD',
        },
      );
      expect(names(await query(anonymous, token, { search: 'r1' }))).toEqual(['r1']);
    });

    it('refuses viewer filter/sort/group without allow_viewer_filter_sort, search without allow_search', async () => {
      const link = await createLink(owner, viewSales.id, {
        audience: 'public',
        settings: { allow_viewer_filter_sort: false, allow_search: false },
      });
      const filter = { logic: 'and', conditions: [['amount', '>', 5]] };
      expectProblem(await query(anonymous, link.token, { filter }), 403, 'PERMISSION_DENIED', {
        path: 'filter',
        code: 'NOT_ALLOWED',
      });
      expectProblem(
        await query(anonymous, link.token, { sort: [{ field: 'amount' }] }),
        403,
        'PERMISSION_DENIED',
        { path: 'sort', code: 'NOT_ALLOWED' },
      );
      expectProblem(await query(anonymous, link.token, { group: [] }), 403, 'PERMISSION_DENIED', {
        path: 'group',
        code: 'NOT_ALLOWED',
      });
      expectProblem(await query(anonymous, link.token, { search: 'r' }), 403, 'PERMISSION_DENIED', {
        path: 'search',
        code: 'NOT_ALLOWED',
      });
      // T311: setting the view's sort aside is a viewer sort; its filter never can be.
      expectProblem(
        await query(anonymous, link.token, { sort_mode: 'replace' }),
        403,
        'PERMISSION_DENIED',
        { path: 'sort_mode', code: 'NOT_ALLOWED' },
      );
      expectProblem(
        await query(anonymous, link.token, { filter_mode: 'replace' }),
        422,
        'VALIDATION_FAILED',
        { code: 'UNRECOGNIZED_KEY' },
      );
      // Plain paging still works, the view's own sort included.
      expect(names(await query(anonymous, link.token, { sort: [], offset: 1 }))).toEqual(['r1']);
      const meta = shareMetaSchema.parse(
        (await share(anonymous, 'GET', link.token, '/meta')).json(),
      );
      expect(meta.settings).toMatchObject({ allow_viewer_filter_sort: false, allow_search: false });
    });

    it('hides the record detail with show_record_detail = false', async () => {
      const link = await createLink(owner, viewSales.id, {
        audience: 'public',
        settings: { show_record_detail: false },
      });
      expectProblem(
        await share(anonymous, 'GET', link.token, `/records/${r.r1}`),
        404,
        'NOT_FOUND',
      );
      expect(names(await query(anonymous, link.token))).toEqual(['r2', 'r1']);
    });

    it('has no records through a form link', async () => {
      const link = await createLink(owner, formView.id, { audience: 'public' });
      const meta = shareMetaSchema.parse(
        (await share(anonymous, 'GET', link.token, '/meta')).json(),
      );
      expect(meta.target_type).toBe('form');
      expect(meta.view.config.form?.fields.map((item) => item.field)).toBeDefined();
      expectProblem(await query(anonymous, link.token), 404, 'NOT_FOUND');
      expectProblem(
        await share(anonymous, 'GET', link.token, `/records/${r.r1}`),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('group counts (T317)', () => {
    let anonymous: Browser;
    let byStatus: ViewDto;
    let board: ViewDto;

    beforeAll(async () => {
      anonymous = new Browser(t.app);
      byStatus = await createView({
        name: 'By status',
        type: 'grid',
        config: {
          filter: { op: 'and', items: [{ field: f.amount.id, operator: 'gt', value: 0 }] },
          group: [{ field: f.status.id, direction: 'asc' }],
        },
      });
      board = await createView({
        name: 'Board',
        type: 'kanban',
        config: { kanban: { group_field: f.status.id } },
      });
    });

    const counts = (token: string, body: object = {}, query = '?field_key_type=id') =>
      share(anonymous, 'POST', token, `/records/group-counts${query}`, body);

    function groupsOf(response: LightMyRequestResponse) {
      expect(response.statusCode, response.body).toBe(200);
      return recordGroupCountsResponseSchema.parse(response.json());
    }

    it("counts by the view's saved group, inside the view filter", async () => {
      const link = await createLink(owner, byStatus.id, { audience: 'public' });
      const result = groupsOf(await counts(link.token));
      expect(result.group).toEqual([{ field: f.status.id, direction: 'asc' }]);
      expect(result.groups.map((group) => group.count)).toEqual([1, 1]);
      expect(result.truncated).toBe(false);
      // The viewer's filter narrows the counts, never widens them past the view filter.
      const narrowed = groupsOf(
        await counts(link.token, {
          filter: { op: 'and', items: [{ field: f.amount.id, operator: 'gt', value: 15 }] },
        }),
      );
      expect(narrowed.groups.map((group) => group.count)).toEqual([1]);
      const everything = groupsOf(
        await counts(link.token, {
          filter: { op: 'and', items: [{ field: f.amount.id, operator: 'gte', value: 0 }] },
          group: [],
        }),
      );
      expect(everything.groups).toEqual([{ values: [], count: 2 }]);
    });

    it('never groups by a field outside the link; user values carry id and name only', async () => {
      const sales = await createLink(sales1, viewSales.id, { audience: 'public' });
      expectProblem(
        await counts(sales.token, { group: [{ field: f.status.id }] }),
        422,
        'INVALID_SORT',
        { code: 'UNKNOWN_FIELD' },
      );
      expectProblem(
        await counts(sales.token, { group: [{ field: f.cost.id }] }),
        422,
        'INVALID_SORT',
        { code: 'UNKNOWN_FIELD' },
      );
      // P30: the creator's rule applies (r1 only).
      const byOwner = await counts(sales.token, { group: [{ field: f.owner.id }] });
      const result = groupsOf(byOwner);
      expect(result.groups).toEqual([
        { values: [[{ id: sales1.id, name: 'Sales One' }]], count: 1 },
      ]);
      expect(byOwner.body).not.toContain(sales1.email);
    });

    it('refuses viewer filter/group/search by the settings, except the columns of a board', async () => {
      const grid = await createLink(owner, byStatus.id, {
        audience: 'public',
        settings: { allow_viewer_filter_sort: false, allow_search: false },
      });
      expect(groupsOf(await counts(grid.token)).groups).toHaveLength(2);
      for (const [body, path] of [
        [{ group: [{ field: f.amount.id }] }, 'group'],
        [{ group: [] }, 'group'],
        [{ filter: { op: 'and', items: [] } }, 'filter'],
        [{ search: 'r' }, 'search'],
      ] as const) {
        expectProblem(await counts(grid.token, body), 403, 'PERMISSION_DENIED', {
          path,
          code: 'NOT_ALLOWED',
        });
      }
      expectProblem(
        await counts(grid.token, { filter_mode: 'replace' }),
        422,
        'VALIDATION_FAILED',
        {
          code: 'UNRECOGNIZED_KEY',
        },
      );

      const kanban = await createLink(owner, board.id, {
        audience: 'public',
        settings: { allow_viewer_filter_sort: false },
      });
      const columns = groupsOf(await counts(kanban.token, { group: [{ field: f.status.id }] }));
      expect(columns.groups.map((group) => group.count).reduce((a, b) => a + b, 0)).toBe(3);
      // By name as well; any other grouping is the viewer's.
      expect(
        groupsOf(await counts(kanban.token, { group: [{ field: 'status' }] }, '')).groups,
      ).toHaveLength(3);
      expectProblem(
        await counts(kanban.token, { group: [{ field: f.amount.id }] }),
        403,
        'PERMISSION_DENIED',
        { path: 'group', code: 'NOT_ALLOWED' },
      );
      expectProblem(
        await counts(kanban.token, { group: [{ field: f.status.id }, { field: f.amount.id }] }),
        403,
        'PERMISSION_DENIED',
        { path: 'group', code: 'NOT_ALLOWED' },
      );
    });

    it('has no counts through a form link, needs the unlock of a password link', async () => {
      const form = await createLink(owner, formView.id, { audience: 'public' });
      expectProblem(await counts(form.token), 404, 'NOT_FOUND');
      const locked = await createLink(owner, byStatus.id, {
        audience: 'public',
        password: 'open-sesame-42',
      });
      expectProblem(await counts(locked.token), 403, 'SHARE_PASSWORD_REQUIRED');
    });
  });

  describe('tokens and link state', () => {
    it('answers 404 for unknown or malformed tokens and 410 for revoked or expired links', async () => {
      const anonymous = new Browser(t.app);
      for (const token of ['x'.repeat(43), 'short', 'A'.repeat(90)]) {
        expectProblem(await share(anonymous, 'GET', token, '/meta'), 404, 'NOT_FOUND');
        expectProblem(await query(anonymous, token), 404, 'NOT_FOUND');
      }
      const revoked = await createLink(owner, viewSales.id, { audience: 'public' });
      expect((await call(owner, 'DELETE', `/share-links/${revoked.id}`)).statusCode).toBe(204);
      expectProblem(await query(anonymous, revoked.token), 410, 'SHARE_LINK_GONE');

      const expired = await createLink(owner, viewSales.id, { audience: 'public' });
      await db.kysely
        .updateTable('meta.share_links')
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where('id', '=', expired.id)
        .execute();
      expectProblem(await share(anonymous, 'GET', expired.token, '/meta'), 410, 'SHARE_LINK_GONE');

      const disabled = await createLink(owner, viewSales.id, {
        audience: 'public',
        enabled: false,
      });
      expectProblem(await query(anonymous, disabled.token), 410, 'SHARE_LINK_GONE');
    });

    it('audience org: sign-in required, members of the organization only', async () => {
      const link = await createLink(owner, viewSales.id, { audience: 'org' });
      expectProblem(await query(new Browser(t.app), link.token), 401, 'UNAUTHENTICATED');
      expectProblem(
        await share(new Browser(t.app), 'GET', link.token, '/meta'),
        401,
        'UNAUTHENTICATED',
      );
      // A member of another organization: the link does not exist for them.
      expectProblem(await query(await as(stranger), link.token), 404, 'NOT_FOUND');
      // A member without any role in the base sees the link's scope.
      expect(names(await query(await as(outsider), link.token))).toEqual(['r2', 'r1']);
      // A session cookie still needs its CSRF token on POST.
      expectProblem(
        await (
          await as(outsider)
        ).request({
          method: 'POST',
          url: `/api/v1/shares/${link.token}/records/query`,
          payload: {},
          csrf: false,
        }),
        403,
        'CSRF_INVALID',
      );
    });
  });

  describe('password', () => {
    const PASSWORD = 'open-sesame-42';

    it('locks the link until unlocked; the unlock cookie needs its CSRF token', async () => {
      const link = await createLink(owner, viewSales.id, {
        audience: 'public',
        password: PASSWORD,
      });
      const visitor = new Browser(t.app);
      expectProblem(
        await share(visitor, 'GET', link.token, '/meta'),
        403,
        'SHARE_PASSWORD_REQUIRED',
      );
      expectProblem(await query(visitor, link.token), 403, 'SHARE_PASSWORD_REQUIRED');
      expectProblem(
        await share(visitor, 'GET', link.token, `/records/${r.r1}`),
        403,
        'SHARE_PASSWORD_REQUIRED',
      );

      const unlocked = await share(visitor, 'POST', link.token, '/unlock', { password: PASSWORD });
      expect(unlocked.statusCode, unlocked.body).toBe(200);
      const { csrf_token: csrf, expires_at: expiresAt } = shareUnlockResponseSchema.parse(
        unlocked.json(),
      );
      expect(csrf).not.toBeNull();
      expect(Date.parse(expiresAt ?? '') - Date.now()).toBeGreaterThan(23.9 * 3600 * 1000);
      const cookie = setCookiesOf(unlocked).get(`ob_share_${link.id}`);
      expect(cookie?.attributes).toEqual(
        expect.arrayContaining([
          'HttpOnly',
          'SameSite=Strict',
          'Path=/api/v1/shares/',
          'Max-Age=86400',
        ]),
      );
      expect(cookie?.raw).not.toContain(link.token);

      const meta = shareMetaSchema.parse((await share(visitor, 'GET', link.token, '/meta')).json());
      expect(meta.csrf_token).toBe(csrf);
      expect((await share(visitor, 'GET', link.token, `/records/${r.r1}`)).statusCode).toBe(200);
      expectProblem(await query(visitor, link.token), 403, 'CSRF_INVALID');
      expectProblem(
        await share(
          visitor,
          'POST',
          link.token,
          '/records/query',
          {},
          { [SHARE_CSRF_HEADER]: 'x' },
        ),
        403,
        'CSRF_INVALID',
      );
      const ok = await share(
        visitor,
        'POST',
        link.token,
        '/records/query',
        {},
        { [SHARE_CSRF_HEADER]: csrf ?? '' },
      );
      expect(names(ok)).toEqual(['r2', 'r1']);

      // The cookie of one link opens nothing else.
      const other = await createLink(owner, formView.id, {
        audience: 'public',
        password: PASSWORD,
      });
      expectProblem(
        await share(visitor, 'GET', other.token, '/meta'),
        403,
        'SHARE_PASSWORD_REQUIRED',
      );

      // A new password invalidates earlier unlocks.
      const changed = await call(owner, 'PATCH', `/share-links/${link.id}`, {
        password: 'another-secret-9',
      });
      expect(changed.statusCode, changed.body).toBe(200);
      // The audit notes the change, never the password (`password` is a forbidden audit key).
      const updated = await sql<{ before: object; after: object }>`
        SELECT before, after FROM meta.audit_logs
         WHERE entity_id = ${link.id} AND action = 'share_link.updated'
      `.execute(db.kysely);
      expect(updated.rows).toEqual([
        { before: { password_changed: false }, after: { password_changed: true } },
      ]);
      expectProblem(
        await share(visitor, 'GET', link.token, '/meta'),
        403,
        'SHARE_PASSWORD_REQUIRED',
      );
    });

    it('locks an IP out after 5 wrong passwords (6th → 429) and audits it', async () => {
      const link = await createLink(owner, viewSales.id, {
        audience: 'public',
        password: PASSWORD,
      });
      const guesser = new Browser(t.app);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expectProblem(
          await share(guesser, 'POST', link.token, '/unlock', {
            password: `wrong-${String(attempt)}`,
          }),
          403,
          'SHARE_PASSWORD_INVALID',
        );
      }
      const sixth = await share(guesser, 'POST', link.token, '/unlock', { password: PASSWORD });
      expectProblem(sixth, 429, 'RATE_LIMITED');
      expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(800);
      expect(setCookiesOf(sixth).size).toBe(0);

      const audit = await sql<{
        action: string;
        actor_type: string;
        actor_id: string;
        ip: string | null;
        after: object;
      }>`
        SELECT action, actor_type, actor_id, host(ip) AS ip, after FROM meta.audit_logs
         WHERE entity_id = ${link.id} AND action = 'share_link.unlock_failed'
      `.execute(db.kysely);
      expect(audit.rows).toEqual([
        {
          action: 'share_link.unlock_failed',
          actor_type: 'share_link',
          actor_id: link.id,
          ip: guesser.ip,
          after: { failures: 5, locked_seconds: 900 },
        },
      ]);
      expect(JSON.stringify(audit.rows)).not.toContain('wrong-');

      // Another IP is not locked out.
      const other = new Browser(t.app);
      const unlocked = await share(other, 'POST', link.token, '/unlock', { password: PASSWORD });
      expect(unlocked.statusCode, unlocked.body).toBe(200);
    });

    it('form links (T306 submit) accept the same unlock cookie and CSRF token', async () => {
      t.app.get(FormSpamGuard).minFillMs = 0;
      const link = await createLink(owner, formView.id, { audience: 'public', password: PASSWORD });
      const visitor = new Browser(t.app);
      const submit = async (headers: Record<string, string> = {}) => {
        const issued = await share(visitor, 'GET', link.token, '/submit-token');
        expect(issued.statusCode, issued.body).toBe(200);
        const { submit_token: submitToken } = issued.json<{ submit_token: string }>();
        return share(
          visitor,
          'POST',
          link.token,
          '/submit',
          { fields: { [primary.id]: 'via locked form' }, submit_token: submitToken },
          headers,
        );
      };
      expectProblem(await submit(), 403, 'SHARE_PASSWORD_REQUIRED', {
        path: '',
        code: 'UNLOCK_REQUIRED',
      });
      const meta = await share(visitor, 'GET', link.token, '/meta');
      expectProblem(meta, 403, 'SHARE_PASSWORD_REQUIRED', { code: 'UNLOCK_REQUIRED' });

      const unlocked = shareUnlockResponseSchema.parse(
        (await share(visitor, 'POST', link.token, '/unlock', { password: PASSWORD })).json(),
      );
      expectProblem(await submit(), 403, 'CSRF_INVALID');
      const ok = await submit({ [SHARE_CSRF_HEADER]: unlocked.csrf_token ?? '' });
      expect(ok.statusCode, ok.body).toBe(200);
      const found = await call(owner, 'POST', `/tables/${orders.id}/records/query`, {
        search: 'via locked form',
      });
      expect(recordListResponseSchema.parse(found.json()).records).toHaveLength(1);
      // The form meta is readable once unlocked.
      const formMeta = shareMetaSchema.parse(
        (await share(visitor, 'GET', link.token, '/meta')).json(),
      );
      expect(formMeta).toMatchObject({ target_type: 'form', csrf_token: unlocked.csrf_token });
    });

    it('unlock of a link without password is a no-op', async () => {
      const link = await createLink(owner, viewSales.id, { audience: 'public' });
      const response = await share(new Browser(t.app), 'POST', link.token, '/unlock', {
        password: 'anything',
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ expires_at: null, csrf_token: null });
      expect(setCookiesOf(response).size).toBe(0);
    });
  });

  describe('rate limit and headers', () => {
    afterEach(() => {
      t.app.get(ShareRateLimits).read = { limit: 100_000, windowSeconds: 1 };
    });

    it('limits reads per IP: 429 with Retry-After', async () => {
      expect(DEFAULT_SHARE_READ_RATE_LIMIT).toEqual({ limit: 20, windowSeconds: 1 });
      const link = await createLink(owner, viewSales.id, { audience: 'public' });
      t.app.get(ShareRateLimits).read = { limit: 3, windowSeconds: 37 };
      const client = new Browser(t.app);
      for (let i = 0; i < 3; i += 1) {
        expect((await share(client, 'GET', link.token, '/meta')).statusCode).toBe(200);
      }
      const limited = await query(client, link.token);
      expectProblem(limited, 429, 'RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // Unknown tokens count too (no free token guessing).
      expectProblem(await share(client, 'GET', 'y'.repeat(43), '/meta'), 429, 'RATE_LIMITED');
      // Another IP has its own budget.
      expect((await share(new Browser(t.app), 'GET', link.token, '/meta')).statusCode).toBe(200);
    });

    it('counts form submit tokens as reads, unknown tokens included (T319)', async () => {
      const link = await createLink(owner, formView.id, { audience: 'public' });
      t.app.get(ShareRateLimits).read = { limit: 2, windowSeconds: 41 };
      const client = new Browser(t.app);
      expect((await share(client, 'GET', link.token, '/submit-token')).statusCode).toBe(200);
      expectProblem(await share(client, 'GET', 'q'.repeat(43), '/submit-token'), 404, 'NOT_FOUND');
      const limited = await share(client, 'GET', link.token, '/submit-token');
      expectProblem(limited, 429, 'RATE_LIMITED');
      expect(limited.headers).toMatchObject({
        'x-robots-tag': 'noindex, nofollow',
        'referrer-policy': 'no-referrer',
      });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('sends noindex/no-referrer/no-store on every share response, errors included', async () => {
      const link = await createLink(owner, viewSales.id, { audience: 'public' });
      const anonymous = new Browser(t.app);
      const responses = [
        await share(anonymous, 'GET', link.token, '/meta'),
        await query(anonymous, link.token),
        await share(anonymous, 'GET', 'z'.repeat(43), '/meta'),
        await share(anonymous, 'GET', link.token, '/nope'),
        await query(anonymous, link.token, { limit: 0 }),
      ];
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 404, 404, 422]);
      for (const response of responses) {
        expect(response.headers).toMatchObject({
          'x-robots-tag': 'noindex, nofollow',
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store',
        });
      }
      const other = await call(owner, 'GET', `/tables/${orders.id}/views`);
      expect(other.headers['x-robots-tag']).toBeUndefined();
    });

    it('ignores Idempotency-Key on share POSTs', async () => {
      const link = await createLink(owner, viewSales.id, { audience: 'public' });
      const anonymous = new Browser(t.app);
      const key = { 'idempotency-key': 'same-key-1' };
      const first = await share(anonymous, 'POST', link.token, '/records/query', {}, key);
      const second = await share(
        anonymous,
        'POST',
        link.token,
        '/records/query',
        { limit: 1 },
        key,
      );
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(second.headers['idempotent-replayed']).toBeUndefined();
      expect(recordListResponseSchema.parse(second.json()).records).toHaveLength(1);
    });
  });

  describe('access statistics', () => {
    it('are written in batches: page opens counted, last access moved by any read', async () => {
      const stats = t.app.get(ShareAccessStats);
      // The periodic write (every 10 s) could otherwise land between the
      // requests and the first check: stop it (this also writes what is
      // pending) and flush by hand; it is started again afterwards.
      await stats.onApplicationShutdown();
      onTestFinished(() => {
        stats.onModuleInit();
      });
      const link = await createLink(owner, viewSales.id, { audience: 'public' });
      const anonymous = new Browser(t.app);
      await share(anonymous, 'GET', link.token, '/meta');
      await share(anonymous, 'GET', link.token, '/meta');
      await query(anonymous, link.token);
      const links = new ShareLinksRepository(db);
      const scope = orgScope(org);
      // Nothing written per request.
      expect(await links.getById(scope, link.id)).toMatchObject({
        access_count: 0n,
        last_accessed_at: null,
      });
      expect(stats.pendingLinks).toBeGreaterThan(0);
      await stats.flush();
      const row = await links.getById(scope, link.id);
      expect(row?.access_count).toBe(2n);
      expect(row?.last_accessed_at).not.toBeNull();
      const day = new Date().toISOString().slice(0, 10);
      expect(await links.dailyStats(scope, link.id, day)).toEqual([{ day, access_count: 2n }]);
      const listed = await call(owner, 'GET', `/share-links/${link.id}`);
      expect(listed.json()).toMatchObject({ access_count: 2 });
    });
  });

  it('never logs a token', () => {
    const raw = t.logs.raw();
    expect(tokens.length).toBeGreaterThan(5);
    for (const token of tokens) expect(raw).not.toContain(token);
  });
});
