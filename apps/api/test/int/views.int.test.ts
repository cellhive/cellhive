import {
  baseDetailSchema,
  fieldListSchema,
  fieldSchema,
  roleListSchema,
  roleSchema,
  tableSchema,
  viewListSchema,
  viewSchema,
  workspaceSchema,
  type FieldDto,
  type Id,
  type RealtimeServerMessage,
  type RoleDto,
  type TableDto,
  type ViewDto,
} from '@cellhive/contracts';
import { orgScope, ViewsRepository, type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * T301: saved views (SPEC §8, CONTRACTS §15) — default view of new tables,
 * CRUD, personal views, `visible_views` (P16/P17), config validation
 * against the schema and the saver's permissions, locked views, role
 * cleanup when a shared view goes, events + audit, realtime and tenant
 * isolation.
 */
describe('views (T301)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let wsUrl: string;
  let org: Id<'org'>;
  let owner: SeededUser;
  let editor: SeededUser;
  let reader: SeededUser;
  let sales1: SeededUser;
  let sales2: SeededUser;
  let outsider: SeededUser;
  let stranger: SeededUser;
  let baseId: Id<'bse'>;
  let orders: TableDto;
  let customers: TableDto;
  const f = {} as Record<'amount' | 'cost' | 'status' | 'owner' | 'number', FieldDto>;
  let sales: RoleDto;
  /** The default grid view of Orders. */
  let viewAll: ViewDto;
  /** The only view the Sales role sees. */
  let viewSales: ViewDto;
  const browsers = new Map<string, Browser>();
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    wsUrl = await listen(t.app);
    org = await seedOrg(db, 'Views');
    const otherOrg = await seedOrg(db, 'Elsewhere');
    const member = (role: 'owner' | 'member') => ({ memberships: [{ orgId: org, role }] });
    owner = await seedUser(db, member('owner'));
    editor = await seedUser(db, member('member'));
    reader = await seedUser(db, member('member'));
    sales1 = await seedUser(db, member('member'));
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
    customers = tableSchema.parse(
      (await call(owner, 'POST', `/bases/${baseId}/tables`, { name: 'Customers' })).json(),
    );
    const field = async (body: object) => {
      const response = await call(owner, 'POST', `/tables/${orders.id}/fields`, body);
      expect(response.statusCode).toBe(201);
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
    f.number = await field({ name: 'number', type: 'auto_number' });

    const roles = roleListSchema.parse((await call(owner, 'GET', `/bases/${baseId}/roles`)).json());
    const roleOf = (kind: string) => {
      const role = roles.items.find((item) => item.kind === kind);
      if (role === undefined) throw new Error(`no ${kind}`);
      return role;
    };
    await assign(editor, roleOf('system_editor').id);
    await assign(reader, roleOf('system_reader').id);

    viewAll = viewListSchema.parse((await call(owner, 'GET', `/tables/${orders.id}/views`)).json())
      .items[0] as ViewDto;
    viewSales = await createView(owner, orders.id, {
      name: 'Sales',
      type: 'grid',
      config: {
        filter: { op: 'and', items: [{ field: f.cost.id, operator: 'gt', value: 0 }] },
        sort: [
          { field: f.cost.id, direction: 'desc' },
          { field: f.amount.id, direction: 'asc' },
        ],
        hidden_fields: [f.cost.id, f.number.id],
      },
    });
    const created = await call(owner, 'POST', `/bases/${baseId}/roles`, {
      name: 'Sales',
      config: salesConfig([viewSales.id]),
    });
    expect(created.statusCode).toBe(201);
    sales = roleSchema.parse(created.json());
    for (const user of [sales1, sales2]) await assign(user, sales.id);
  });

  afterAll(async () => {
    await closeSockets(sockets);
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

  async function assign(user: SeededUser, roleId: Id<'rol'>): Promise<void> {
    const response = await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: user.id,
      role_id: roleId,
    });
    expect(response.statusCode).toBe(200);
  }

  async function createView(
    user: SeededUser,
    tableId: Id<'tbl'>,
    body: Record<string, unknown>,
  ): Promise<ViewDto> {
    const response = await call(user, 'POST', `/tables/${tableId}/views`, body);
    expect(response.statusCode, response.body).toBe(201);
    return viewSchema.parse(response.json());
  }

  function expectProblem(
    response: LightMyRequestResponse,
    status: number,
    code: string,
    detail?: { path?: string; code: string },
  ): void {
    const problem = problemOf(response.body);
    expect({ status: response.statusCode, code: problem.code }, response.body).toEqual({
      status,
      code,
    });
    if (detail !== undefined) {
      expect(problem.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: detail.code,
            ...(detail.path === undefined ? {} : { path: detail.path }),
          }),
        ]),
      );
    }
  }

  function salesConfig(visibleViews: Id<'viw'>[] | null) {
    return {
      base_rule: { copy: false, download: false, share_link: false },
      tables: {
        [orders.id]: {
          perm: 'edit',
          view_rule: { allow_edit: false, visible_views: visibleViews },
          record_rule: { operations: ['add'], read_scope: 'all' },
          field_rule: {
            mode: 'specify',
            fields: { [f.cost.id]: 'no_perm', [f.status.id]: 'read' },
          },
        },
      },
      dashboards: {},
    };
  }

  async function listNames(user: SeededUser, tableId: Id<'tbl'> = orders.id): Promise<string[]> {
    const response = await call(user, 'GET', `/tables/${tableId}/views`);
    expect(response.statusCode).toBe(200);
    return viewListSchema.parse(response.json()).items.map((view) => view.name);
  }

  async function version(): Promise<number> {
    return baseDetailSchema.parse((await call(owner, 'GET', `/bases/${baseId}`)).json())
      .permission_version;
  }

  describe('default view', () => {
    it('gives every new table one shared grid view, with its event and audit entry', async () => {
      const list = viewListSchema.parse(
        (await call(owner, 'GET', `/tables/${customers.id}/views`)).json(),
      );
      expect(list.total).toBe(1);
      expect(list.items[0]).toMatchObject({
        table_id: customers.id,
        type: 'grid',
        name: 'Grid view',
        is_personal: false,
        owner_id: null,
        position: 0,
        locked: false,
        config: { filter: null, sort: [], group: [], hidden_fields: [], row_height: 'short' },
      });
      const viewId = list.items[0]?.id ?? '';
      const { rows } = await sql<{ type: string }>`
        SELECT type FROM meta.events WHERE entity_id = ${viewId}
      `.execute(db.kysely);
      expect(rows.map((row) => row.type)).toEqual(['view.created']);
      const audit = await sql<{ action: string; table_id: string }>`
        SELECT action, table_id FROM meta.audit_logs WHERE entity_id = ${viewId}
      `.execute(db.kysely);
      expect(audit.rows).toEqual([{ action: 'view.created', table_id: customers.id }]);
    });
  });

  describe('P16/P17: who sees and changes views', () => {
    it('lists only visible_views (plus own personal views) for u_sales1', async () => {
      expect(await listNames(owner)).toEqual(['Grid view', 'Sales']);
      expect(await listNames(sales1)).toEqual(['Sales']);
      expect(await listNames(reader)).toEqual(['Grid view', 'Sales']);
      expectProblem(await call(sales1, 'GET', `/tables/${customers.id}/views`), 404, 'NOT_FOUND');
      expectProblem(await call(outsider, 'GET', `/tables/${orders.id}/views`), 404, 'NOT_FOUND');
      expectProblem(await call(stranger, 'GET', `/tables/${orders.id}/views`), 404, 'NOT_FOUND');
    });

    it('P17: u_sales1 gets 403 on shared views it sees and 404 on viw_all', async () => {
      expectProblem(
        await call(sales1, 'POST', `/tables/${orders.id}/views`, { name: 'Mine', type: 'grid' }),
        403,
        'PERMISSION_DENIED',
      );
      const sharedUrl = `/views/${viewSales.id}`;
      for (const body of [
        { name: 'Renamed' },
        { config: { row_height: 'tall' } },
        { position: 0 },
      ]) {
        expectProblem(await call(sales1, 'PATCH', sharedUrl, body), 403, 'PERMISSION_DENIED');
      }
      expectProblem(await call(sales1, 'DELETE', sharedUrl), 403, 'PERMISSION_DENIED');
      expectProblem(
        await call(sales1, 'POST', `${sharedUrl}/duplicate`, { is_personal: false }),
        403,
        'PERMISSION_DENIED',
      );
      expect((await call(sales1, 'GET', sharedUrl)).statusCode).toBe(200);

      const hidden = `/views/${viewAll.id}`;
      for (const [method, body] of [
        ['GET', undefined],
        ['PATCH', { name: 'x' }],
        ['DELETE', undefined],
        ['POST', {}],
      ] as const) {
        const url = method === 'POST' ? `${hidden}/duplicate` : hidden;
        expectProblem(await call(sales1, method, url, body), 404, 'NOT_FOUND');
      }
      // Same answer as a view that does not exist, and across organizations.
      expectProblem(await call(sales1, 'GET', '/views/viw_0000000000000000'), 404, 'NOT_FOUND');
      expectProblem(await call(stranger, 'GET', hidden), 404, 'NOT_FOUND');
      expectProblem(await call(outsider, 'GET', hidden), 404, 'NOT_FOUND');
      // Nothing changed.
      expect(await listNames(owner)).toEqual(['Grid view', 'Sales']);
    });

    it('u_editor creates, renames, reorders and deletes shared views; the reader cannot', async () => {
      const board = await createView(editor, orders.id, {
        name: 'Board',
        type: 'kanban',
        config: { kanban: { group_field: f.status.id } },
      });
      expect(board).toMatchObject({ type: 'kanban', is_personal: false, position: 2 });
      expect(board.config.kanban).toEqual({
        group_field: f.status.id,
        card_fields: [],
        cover_field: null,
        hide_empty_columns: false,
      });
      expectProblem(
        await call(reader, 'PATCH', `/views/${board.id}`, { name: 'x' }),
        403,
        'PERMISSION_DENIED',
      );
      const moved = await call(editor, 'PATCH', `/views/${board.id}`, {
        name: 'Pipeline',
        position: 0,
      });
      expect(moved.statusCode).toBe(200);
      expect(viewSchema.parse(moved.json())).toMatchObject({ name: 'Pipeline', position: 0 });
      expect(await listNames(owner)).toEqual(['Pipeline', 'Grid view', 'Sales']);
      expect((await call(editor, 'DELETE', `/views/${board.id}`)).statusCode).toBe(204);
      expect(await listNames(owner)).toEqual(['Grid view', 'Sales']);
    });

    it('personal views: any reader creates them, only the owner sees them', async () => {
      const mine = await createView(sales1, orders.id, {
        name: 'My orders',
        type: 'grid',
        is_personal: true,
        config: { sort: [{ field: f.amount.id, direction: 'desc' }] },
      });
      expect(mine).toMatchObject({ is_personal: true, owner_id: sales1.id, position: 0 });
      expect(await listNames(sales1)).toEqual(['Sales', 'My orders']);
      expect(await listNames(sales2)).toEqual(['Sales']);
      expect(await listNames(owner)).toEqual(['Grid view', 'Sales']);
      for (const user of [sales2, owner, editor]) {
        expectProblem(await call(user, 'GET', `/views/${mine.id}`), 404, 'NOT_FOUND');
        expectProblem(
          await call(user, 'PATCH', `/views/${mine.id}`, { name: 'x' }),
          404,
          'NOT_FOUND',
        );
      }
      const renamed = await call(sales1, 'PATCH', `/views/${mine.id}`, {
        config: { row_height: 'tall' },
      });
      expect(viewSchema.parse(renamed.json()).config.row_height).toBe('tall');
      // A personal view may reuse a shared name; its owner cannot reuse their own.
      await createView(reader, orders.id, { name: 'Sales', type: 'grid', is_personal: true });
      expectProblem(
        await call(sales1, 'POST', `/tables/${orders.id}/views`, {
          name: 'MY ORDERS',
          type: 'grid',
          is_personal: true,
        }),
        409,
        'NAME_CONFLICT',
      );
      // Personal views cannot be locked.
      expectProblem(
        await call(sales1, 'PATCH', `/views/${mine.id}`, { locked: true }),
        422,
        'VALIDATION_FAILED',
        { path: 'locked', code: 'NOT_ALLOWED' },
      );
      expect((await call(sales1, 'DELETE', `/views/${mine.id}`)).statusCode).toBe(204);
    });

    it('caps personal views at 50 per user and table', async () => {
      const views = new ViewsRepository(db);
      for (let index = 0; index < 50; index += 1) {
        await views.insert(orgScope(org), {
          id: `viw_Cap${String(index).padStart(13, '0')}`,
          tableId: orders.id,
          type: 'grid',
          name: `Mine ${String(index)}`,
          config: {},
          position: index,
          ownerId: sales2.id,
        });
      }
      expectProblem(
        await call(sales2, 'POST', `/tables/${orders.id}/views`, {
          name: 'One more',
          type: 'grid',
          is_personal: true,
        }),
        422,
        'VALIDATION_FAILED',
        { code: 'VIEW_LIMIT_EXCEEDED' },
      );
      await sql`DELETE FROM meta.views WHERE owner_id = ${sales2.id}`.execute(db.kysely);
    });
  });

  describe('config validation and redaction', () => {
    it('rejects fields of another table, hidden fields and bad kanban/form settings', async () => {
      const foreign =
        fieldListSchema.parse((await call(owner, 'GET', `/tables/${customers.id}/fields`)).json())
          .items[0]?.id ?? '';
      const post = (user: SeededUser, body: object) =>
        call(user, 'POST', `/tables/${orders.id}/views`, { name: 'Bad', type: 'grid', ...body });
      expectProblem(
        await post(owner, { config: { hidden_fields: [foreign] } }),
        422,
        'VALIDATION_FAILED',
        {
          path: 'config.hidden_fields[0]',
          code: 'UNKNOWN_FIELD',
        },
      );
      expectProblem(
        await post(owner, {
          config: { filter: { op: 'and', items: [{ field: foreign, operator: 'is_empty' }] } },
        }),
        422,
        'INVALID_FILTER',
        { path: 'config.filter.items[0].field', code: 'UNKNOWN_FIELD' },
      );
      // P08 for saved views: a field the saver cannot read is a missing field.
      expectProblem(
        await post(sales1, {
          is_personal: true,
          config: {
            filter: { op: 'and', items: [{ field: f.cost.id, operator: 'gt', value: 1 }] },
          },
        }),
        422,
        'INVALID_FILTER',
        { code: 'UNKNOWN_FIELD' },
      );
      expectProblem(
        await post(sales1, { is_personal: true, config: { sort: [{ field: f.cost.id }] } }),
        422,
        'INVALID_SORT',
        { path: 'config.sort[0].field', code: 'UNKNOWN_FIELD' },
      );
      expectProblem(
        await call(owner, 'POST', `/tables/${orders.id}/views`, {
          name: 'Bad board',
          type: 'kanban',
          config: { kanban: { group_field: f.amount.id } },
        }),
        422,
        'VALIDATION_FAILED',
        { path: 'config.kanban.group_field', code: 'INVALID_FIELD_TYPE' },
      );
      expectProblem(
        await call(owner, 'POST', `/tables/${orders.id}/views`, {
          name: 'Bad form',
          type: 'form',
          config: { form: { fields: [{ field: f.number.id }] } },
        }),
        422,
        'VALIDATION_FAILED',
        { path: 'config.form.fields[0].field', code: 'FIELD_READ_ONLY' },
      );
      expectProblem(await post(owner, { name: 'grid VIEW' }), 409, 'NAME_CONFLICT');
    });

    it('creates a form with every writable field by default', async () => {
      const form = await createView(owner, orders.id, { name: 'Order form', type: 'form' });
      expect(form.config.form?.fields.map((item) => item.field)).toEqual([
        orders.primary_field_id,
        f.amount.id,
        f.cost.id,
        f.status.id,
        f.owner.id,
      ]);
      expect((await call(owner, 'DELETE', `/views/${form.id}`)).statusCode).toBe(204);
    });

    it('leaves out filter/sort items and list entries on fields the reader cannot read', async () => {
      const asOwner = viewSchema.parse((await call(owner, 'GET', `/views/${viewSales.id}`)).json());
      expect(asOwner.config.filter).toEqual({
        op: 'and',
        items: [{ field: f.cost.id, operator: 'gt', value: 0 }],
      });
      const asSales = viewSchema.parse(
        (await call(sales1, 'GET', `/views/${viewSales.id}`)).json(),
      );
      expect(asSales.config.filter).toBeNull();
      expect(asSales.config.sort).toEqual([{ field: f.amount.id, direction: 'asc' }]);
      expect(asSales.config.hidden_fields).toEqual([f.number.id]);
      expect(JSON.stringify(asSales)).not.toContain(f.cost.id);
    });

    it('T311: saving a filter keeps the conditions the saver cannot read', async () => {
      // A role that may edit shared views but cannot read `cost`.
      const curator = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
      const config = salesConfig(null);
      const rule = config.tables[orders.id];
      if (rule === undefined) throw new Error('no Orders rule');
      rule.view_rule.allow_edit = true;
      const role = await call(owner, 'POST', `/bases/${baseId}/roles`, {
        name: 'Curators',
        config,
      });
      expect(role.statusCode, role.body).toBe(201);
      await assign(curator, roleSchema.parse(role.json()).id);
      const costOver = { field: f.cost.id, operator: 'gt', value: 0 };
      const amountOver = { field: f.amount.id, operator: 'gt', value: 5 };
      const view = await createView(owner, orders.id, {
        name: 'Costly',
        type: 'grid',
        config: { filter: { op: 'and', items: [costOver, amountOver] } },
      });
      const url = `/views/${view.id}`;
      const seen = viewSchema.parse((await call(curator, 'GET', url)).json());
      expect(seen.config.filter).toEqual({ op: 'and', items: [amountOver] });

      const numberSet = { field: f.number.id, operator: 'is_not_empty' };
      const saved = await call(curator, 'PATCH', url, {
        config: { filter: { op: 'and', items: [numberSet] } },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(viewSchema.parse(saved.json()).config.filter).toEqual({
        op: 'and',
        items: [numberSet],
      });
      const stored = async () => viewSchema.parse((await call(owner, 'GET', url)).json());
      expect((await stored()).config.filter).toEqual({ op: 'and', items: [numberSet, costOver] });
      // Clearing the filter clears only what the curator sees.
      expect((await call(curator, 'PATCH', url, { config: { filter: null } })).statusCode).toBe(
        200,
      );
      expect((await stored()).config.filter).toEqual({ op: 'and', items: [costOver] });
      // Reading records with a temporary filter/sort replacing the view's.
      const query = await call(curator, 'POST', `/tables/${orders.id}/records/query`, {
        view_id: view.id,
        filter: { op: 'and', items: [amountOver] },
        filter_mode: 'replace',
        sort: [{ field: 'amount', direction: 'desc' }],
        sort_mode: 'replace',
      });
      expect(query.statusCode, query.body).toBe(200);
      const bad = await call(curator, 'POST', `/tables/${orders.id}/records/query`, {
        view_id: view.id,
        filter_mode: 'widen',
      });
      expectProblem(bad, 422, 'VALIDATION_FAILED', { path: 'filter_mode', code: 'INVALID_VALUE' });
    });

    it('keeps references to a deleted field in storage, never in responses', async () => {
      const temp = fieldSchema.parse(
        (
          await call(owner, 'POST', `/tables/${orders.id}/fields`, { name: 'temp', type: 'number' })
        ).json(),
      );
      const view = await createView(owner, orders.id, {
        name: 'Temp',
        type: 'grid',
        config: {
          filter: { op: 'and', items: [{ field: temp.id, operator: 'is_not_empty' }] },
          sort: [{ field: temp.id }],
          column_widths: { [temp.id]: 120 },
        },
      });
      expect((await call(owner, 'DELETE', `/fields/${temp.id}`)).statusCode).toBe(204);
      const read = viewSchema.parse((await call(owner, 'GET', `/views/${view.id}`)).json());
      expect(read.config).toMatchObject({ filter: null, sort: [], column_widths: {} });
      // Saving other keys keeps the stored references.
      expect(
        (await call(owner, 'PATCH', `/views/${view.id}`, { config: { row_height: 'medium' } }))
          .statusCode,
      ).toBe(200);
      expect((await call(owner, 'POST', `/fields/${temp.id}/restore`)).statusCode).toBe(200);
      const restored = viewSchema.parse((await call(owner, 'GET', `/views/${view.id}`)).json());
      expect(restored.config).toMatchObject({
        filter: { op: 'and', items: [{ field: temp.id, operator: 'is_not_empty' }] },
        sort: [{ field: temp.id, direction: 'asc' }],
        column_widths: { [temp.id]: 120 },
        row_height: 'medium',
      });
      expect((await call(owner, 'DELETE', `/views/${view.id}`)).statusCode).toBe(204);
    });
  });

  describe('locked views, last view, conversion and duplicates', () => {
    it('only schema rights lock; a locked config cannot change until unlocked', async () => {
      const url = `/views/${viewAll.id}`;
      expectProblem(await call(editor, 'PATCH', url, { locked: true }), 403, 'PERMISSION_DENIED');
      const locked = await call(owner, 'PATCH', url, { locked: true });
      expect(viewSchema.parse(locked.json()).locked).toBe(true);
      expectProblem(
        await call(editor, 'PATCH', url, { config: { row_height: 'tall' } }),
        422,
        'VALIDATION_FAILED',
        { path: 'config', code: 'VIEW_LOCKED' },
      );
      expectProblem(await call(owner, 'DELETE', url), 422, 'VALIDATION_FAILED', {
        code: 'VIEW_LOCKED',
      });
      // Renaming stays possible.
      expect((await call(editor, 'PATCH', url, { name: 'All orders' })).statusCode).toBe(200);
      const unlocked = await call(owner, 'PATCH', url, {
        locked: false,
        config: { row_height: 'tall' },
      });
      expect(viewSchema.parse(unlocked.json())).toMatchObject({
        locked: false,
        name: 'All orders',
        config: { row_height: 'tall' },
      });
    });

    it('keeps at least one shared view per table', async () => {
      const [only] = viewListSchema.parse(
        (await call(owner, 'GET', `/tables/${customers.id}/views`)).json(),
      ).items;
      const url = `/views/${only?.id ?? ''}`;
      expectProblem(await call(owner, 'DELETE', url), 422, 'VALIDATION_FAILED', {
        code: 'LAST_VIEW',
      });
      expectProblem(
        await call(owner, 'PATCH', url, { is_personal: true }),
        422,
        'VALIDATION_FAILED',
        {
          code: 'LAST_VIEW',
        },
      );
    });

    it('duplicates into a personal copy without what the caller cannot read', async () => {
      const response = await call(sales1, 'POST', `/views/${viewSales.id}/duplicate`, {
        is_personal: true,
      });
      expect(response.statusCode).toBe(201);
      const copy = viewSchema.parse(response.json());
      expect(copy).toMatchObject({ name: 'Sales copy', is_personal: true, owner_id: sales1.id });
      const stored = await new ViewsRepository(db).getById(orgScope(org), copy.id);
      expect(JSON.stringify(stored?.config)).not.toContain(f.cost.id);
      // Without a body: a shared copy (like the source), named after the free slot.
      const shared = await call(owner, 'POST', `/views/${viewSales.id}/duplicate`);
      expect(shared.statusCode).toBe(201);
      expect(viewSchema.parse(shared.json())).toMatchObject({
        name: 'Sales copy',
        is_personal: false,
        locked: false,
      });
      const again = await call(owner, 'POST', `/views/${viewSales.id}/duplicate`, {});
      expect(viewSchema.parse(again.json()).name).toBe('Sales copy 2');
    }, 30_000);
  });

  describe('roles and visible_views', () => {
    it('accepts only shared views of the same table in visible_views', async () => {
      const customersView = viewListSchema.parse(
        (await call(owner, 'GET', `/tables/${customers.id}/views`)).json(),
      ).items[0]?.id as Id<'viw'>;
      const personal = await createView(owner, orders.id, {
        name: 'Owner only',
        type: 'grid',
        is_personal: true,
      });
      // A view of another table, a personal view.
      for (const viewId of [customersView, personal.id]) {
        expectProblem(
          await call(owner, 'PATCH', `/bases/${baseId}/roles/${sales.id}`, {
            config: salesConfig([viewSales.id, viewId]),
          }),
          422,
          'VALIDATION_FAILED',
          {
            path: `config.tables.${orders.id}.view_rule.visible_views[1]`,
            code: 'UNKNOWN_VIEW',
          },
        );
      }
    });

    it('drops ids of deleted or never existing views when a role is saved', async () => {
      const gone = await createView(owner, orders.id, { name: 'Gone soon', type: 'grid' });
      expect((await call(owner, 'DELETE', `/views/${gone.id}`)).statusCode).toBe(204);
      // A role saved before T301 (or while the view existed) may still name them.
      const saved = await call(owner, 'PATCH', `/bases/${baseId}/roles/${sales.id}`, {
        config: salesConfig([gone.id, viewSales.id, 'viw_0000000000000000']),
      });
      expect(saved.statusCode).toBe(200);
      const tables = roleSchema.parse(saved.json()).config.tables as Record<
        string,
        { view_rule: { visible_views: string[] } }
      >;
      expect(tables[orders.id]?.view_rule.visible_views).toEqual([viewSales.id]);
    });

    it('deleting a shared view removes it from every role and bumps permission_version', async () => {
      const extra = await createView(owner, orders.id, { name: 'Extra', type: 'grid' });
      const updated = await call(owner, 'PATCH', `/bases/${baseId}/roles/${sales.id}`, {
        config: salesConfig([viewSales.id, extra.id]),
      });
      expect(updated.statusCode).toBe(200);
      expect(await listNames(sales1)).toEqual(['Sales', 'Extra', 'Sales copy']);
      const before = await version();
      const since = new Date();

      expect((await call(owner, 'DELETE', `/views/${extra.id}`)).statusCode).toBe(204);

      const role = roleSchema.parse(
        (await call(owner, 'GET', `/bases/${baseId}/roles/${sales.id}`)).json(),
      );
      const tables = role.config.tables as Record<
        string,
        { view_rule: { visible_views: string[] } }
      >;
      expect(tables[orders.id]?.view_rule.visible_views).toEqual([viewSales.id]);
      expect(await version()).toBe(before + 1);
      const { rows } = await sql<{ type: string; entity_id: string }>`
        SELECT type, entity_id FROM meta.events
         WHERE organization_id = ${org} AND created_at >= ${since}
         ORDER BY created_at, id
      `.execute(db.kysely);
      expect(rows.map((row) => row.type).sort()).toEqual(
        ['permission.changed', 'role.updated', 'view.deleted'].sort(),
      );
    });

    it('making a shared view personal removes it from roles too', async () => {
      const extra = await createView(editor, orders.id, { name: 'Handover', type: 'grid' });
      await call(owner, 'PATCH', `/bases/${baseId}/roles/${sales.id}`, {
        config: salesConfig([viewSales.id, extra.id]),
      });
      const converted = await call(editor, 'PATCH', `/views/${extra.id}`, { is_personal: true });
      expect(converted.statusCode).toBe(200);
      expect(viewSchema.parse(converted.json())).toMatchObject({
        is_personal: true,
        owner_id: editor.id,
      });
      expect(await listNames(sales1)).not.toContain('Handover');
      expectProblem(await call(owner, 'GET', `/views/${extra.id}`), 404, 'NOT_FOUND');
      // And back: shared again, but no role lists it any more.
      const shared = await call(editor, 'PATCH', `/views/${extra.id}`, { is_personal: false });
      expect(viewSchema.parse(shared.json())).toMatchObject({ is_personal: false, owner_id: null });
      expect(await listNames(sales1)).not.toContain('Handover');
      expect(await listNames(owner)).toContain('Handover');
    });
  });

  describe('realtime', () => {
    const isView = (viewId: string) => (message: RealtimeServerMessage) =>
      message.type === 'schema.changed' &&
      message.entity === 'view' &&
      message.entity_id === viewId;

    async function connect(user: SeededUser): Promise<TestSocket> {
      const socket = await TestSocket.connect(wsUrl, {
        origin: TEST_PUBLIC_URL,
        cookie: (await as(user)).cookieHeader(),
      });
      sockets.push(socket);
      expect(await socket.subscribe(`table:${orders.id}`)).toMatchObject({ type: 'subscribed' });
      return socket;
    }

    it('tells only the subscribers who see the view', async () => {
      const editorSocket = await connect(editor);
      const salesSocket = await connect(sales1);

      expect(
        (await call(owner, 'PATCH', `/views/${viewAll.id}`, { config: { frozen_count: 2 } }))
          .statusCode,
      ).toBe(200);
      expect(await editorSocket.next(isView(viewAll.id))).toEqual({
        type: 'schema.changed',
        channel: `table:${orders.id}`,
        entity: 'view',
        entity_id: viewAll.id,
        action: 'updated',
      });
      await salesSocket.expectNone(isView(viewAll.id));

      expect(
        (await call(owner, 'PATCH', `/views/${viewSales.id}`, { name: 'Sales team' })).statusCode,
      ).toBe(200);
      expect(await salesSocket.next(isView(viewSales.id))).toMatchObject({ action: 'updated' });
      expect(await editorSocket.next(isView(viewSales.id))).toMatchObject({ action: 'updated' });

      // A personal view: its owner only.
      const mine = await createView(sales1, orders.id, {
        name: 'Realtime mine',
        type: 'grid',
        is_personal: true,
      });
      expect(await salesSocket.next(isView(mine.id))).toMatchObject({ action: 'created' });
      await editorSocket.expectNone(isView(mine.id));
    }, 30_000);
  });
});
