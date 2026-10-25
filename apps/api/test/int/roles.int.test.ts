import {
  baseDetailSchema,
  dashboardSchema,
  fieldListSchema,
  fieldSchema,
  newId,
  recordGroupCountsResponseSchema,
  recordListResponseSchema,
  recordSchema,
  recordsResponseSchema,
  roleAssignmentSchema,
  roleListSchema,
  roleSchema,
  roleWithAdjustmentsSchema,
  tableSchema,
  viewListSchema,
  viewSchema,
  workspaceSchema,
  type FieldDto,
  type Id,
  type RoleDto,
  type TableDto,
} from '@cellhive/contracts';
import {
  GroupMembersRepository,
  GroupsRepository,
  orgScope,
  RecordMutationService,
  SchemaService,
  type Db,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * T109: base roles and role assignments (SPEC §14.1, CONTRACTS §5) — CRUD,
 * system role ceilings, `normalizeRoleConfig` adjustments (P26, P27),
 * direct role beats group (P25, over HTTP), a linked `customer` id with its
 * title locked for a table Sales cannot read (P20, BACKLOG T412), views,
 * record queries through views and group counts (P16, T302), P17, export
 * (P18), `permission_version`, events and audit, CSRF and tenant isolation;
 * computed fields by reader (P27, P34–P36 over HTTP, BACKLOG T464).
 */
describe('roles and role assignments (T109)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let org: Id<'org'>;
  let otherOrg: Id<'org'>;
  /** Org owner, base owner. */
  let owner: SeededUser;
  /** Base `admin` system role. */
  let admin: SeededUser;
  let editor: SeededUser;
  let reader: SeededUser;
  let sales1: SeededUser;
  let sales2: SeededUser;
  /** Org member without a role. */
  let outsider: SeededUser;
  /** Owner of another organization. */
  let stranger: SeededUser;
  let salesGroup: Id<'grp'>;
  let strangerGroup: Id<'grp'>;
  const browsers = new Map<string, Browser>();
  let baseId: Id<'bse'>;
  let otherBaseId: Id<'bse'>;
  let orders: TableDto;
  let customers: TableDto;
  const f = {} as Record<
    'title' | 'amount' | 'cost' | 'status' | 'owner' | 'number' | 'customer',
    FieldDto
  >;
  const system = {} as Record<'admin' | 'editor' | 'reader', RoleDto>;
  let sales: RoleDto;
  /** A shared view of Orders listed by the Sales role (CONTRACTS §5 fixture). */
  let viewSales: Id<'viw'>;
  /** The default view of Orders, outside the Sales role's `visible_views`. */
  let viewAll: Id<'viw'>;
  /** `r1` of P25 (owner u_sales1) and its linked customer, reused by P20. */
  let p20Order: Id<'rec'>;
  let p20Customer: Id<'rec'>;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    org = await seedOrg(db, 'Alpha');
    otherOrg = await seedOrg(db, 'Other');
    const member = (role: 'owner' | 'member') => ({ memberships: [{ orgId: org, role }] });
    owner = await seedUser(db, member('owner'));
    admin = await seedUser(db, member('member'));
    editor = await seedUser(db, member('member'));
    reader = await seedUser(db, member('member'));
    sales1 = await seedUser(db, member('member'));
    sales2 = await seedUser(db, member('member'));
    outsider = await seedUser(db, member('member'));
    stranger = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] });

    const groups = new GroupsRepository(db);
    const groupMembers = new GroupMembersRepository(db);
    salesGroup = (await groups.create(orgScope(org), { name: 'Sales' })).id;
    await groupMembers.add(orgScope(org), salesGroup, sales1.id);
    await groupMembers.add(orgScope(org), salesGroup, sales2.id);
    strangerGroup = (await groups.create(orgScope(otherOrg), { name: 'Sales' })).id;

    const workspace = workspaceSchema.parse(
      (await call(owner, 'POST', `/orgs/${org}/workspaces`, { name: 'Main' })).json(),
    );
    const base = await call(owner, 'POST', `/workspaces/${workspace.id}/bases`, { name: 'CRM' });
    baseId = baseDetailSchema.parse(base.json()).id;
    const other = await call(owner, 'POST', `/workspaces/${workspace.id}/bases`, { name: 'Ops' });
    otherBaseId = baseDetailSchema.parse(other.json()).id;

    orders = tableSchema.parse(
      (
        await call(owner, 'POST', `/bases/${baseId}/tables`, {
          name: 'Orders',
          primary_field_name: 'title',
        })
      ).json(),
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
      options: { options: [{ name: 'Mới' }, { name: 'Xong' }] },
    });
    f.owner = await field({ name: 'owner', type: 'user' });
    f.number = await field({ name: 'number', type: 'auto_number' });
    // CONTRACTS §5 fixture, P20 (BACKLOG T412): a link to Customers.
    f.customer = await field({
      name: 'customer',
      type: 'link',
      options: { link_table: customers.id },
    });
    f.title = fieldSchema.parse(
      (await call(owner, 'GET', `/fields/${orders.primary_field_id}`)).json(),
    );
    viewAll = viewListSchema.parse((await call(owner, 'GET', `/tables/${orders.id}/views`)).json())
      .items[0]?.id as Id<'viw'>;
    const salesView = await call(owner, 'POST', `/tables/${orders.id}/views`, {
      name: 'Sales',
      type: 'grid',
    });
    expect(salesView.statusCode).toBe(201);
    viewSales = viewSchema.parse(salesView.json()).id;

    const roles = roleListSchema.parse((await call(owner, 'GET', `/bases/${baseId}/roles`)).json());
    for (const role of roles.items) {
      if (role.kind === 'system_admin') system.admin = role;
      if (role.kind === 'system_editor') system.editor = role;
      if (role.kind === 'system_reader') system.reader = role;
    }
    for (const [user, role] of [
      [admin, system.admin],
      [editor, system.editor],
      [reader, system.reader],
    ] as const) {
      const assigned = await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: user.id,
        role_id: role.id,
      });
      expect(assigned.statusCode).toBe(200);
    }
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
    options: { csrf?: boolean } = {},
  ): Promise<LightMyRequestResponse> {
    const browser = await as(user);
    return browser.request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
      ...options,
    });
  }

  function expectProblem(
    response: LightMyRequestResponse,
    status: number,
    code: string,
    detail?: { path?: string; code: string },
  ): void {
    const problem = problemOf(response.body);
    expect({ status: response.statusCode, code: problem.code }).toEqual({ status, code });
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

  async function version(): Promise<number> {
    return baseDetailSchema.parse((await call(owner, 'GET', `/bases/${baseId}`)).json())
      .permission_version;
  }

  async function accessOf(user: SeededUser) {
    return baseDetailSchema.parse((await call(user, 'GET', `/bases/${baseId}`)).json()).access;
  }

  /** The Sales role of CONTRACTS §5 (by IDs). */
  function salesConfig(
    overrides: { status?: string; operations?: string[]; conditions?: object[] } = {},
  ) {
    return {
      base_rule: { copy: false, download: false, share_link: false },
      tables: {
        [orders.id]: {
          perm: 'edit',
          view_rule: { allow_edit: false, visible_views: [viewSales] },
          record_rule: {
            operations: overrides.operations ?? ['add'],
            edit_filter: {
              op: 'and',
              items: [
                { field: f.owner.id, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
                ...(overrides.conditions ?? []),
              ],
            },
            read_scope: 'editable',
            read_filter: null,
          },
          field_rule: {
            mode: 'specify',
            fields: { [f.cost.id]: 'no_perm', [f.status.id]: overrides.status ?? 'read' },
            option_edit_fields: [],
            file_download_fields: [],
          },
        },
      },
      dashboards: {},
    };
  }

  describe('who may manage roles', () => {
    it('lists roles for base admins only: others who see the base 403, everyone else 404', async () => {
      const listed = await call(admin, 'GET', `/bases/${baseId}/roles`);
      expect(listed.statusCode).toBe(200);
      const list = roleListSchema.parse(listed.json());
      expect(list).toMatchObject({ total: 3, offset: 0, limit: 50 });
      expect(list.items.map((role) => [role.kind, role.position])).toEqual([
        ['system_admin', 0],
        ['system_editor', 1],
        ['system_reader', 2],
      ]);
      expect(list.items[0]?.assignments).toEqual([
        {
          principal_type: 'user',
          principal_id: admin.id,
          name: admin.email.split('@')[0],
          email: admin.email,
        },
      ]);
      expect(
        (await call(owner, 'GET', `/bases/${baseId}/roles?limit=1&offset=1`)).json(),
      ).toMatchObject({ total: 3, items: [{ id: system.editor.id }] });

      expectProblem(await call(editor, 'GET', `/bases/${baseId}/roles`), 403, 'PERMISSION_DENIED');
      expectProblem(await call(reader, 'GET', `/bases/${baseId}/roles`), 403, 'PERMISSION_DENIED');
      expectProblem(await call(outsider, 'GET', `/bases/${baseId}/roles`), 404, 'NOT_FOUND');
      expectProblem(await call(stranger, 'GET', `/bases/${baseId}/roles`), 404, 'NOT_FOUND');
      expectProblem(
        await call(stranger, 'GET', `/bases/${baseId}/roles/${system.admin.id}`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call(editor, 'PUT', `/bases/${baseId}/role-assignments`, {
          principal_type: 'user',
          principal_id: outsider.id,
          role_id: system.reader.id,
        }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(stranger, 'POST', `/bases/${baseId}/roles`, { name: 'X' }),
        404,
        'NOT_FOUND',
      );
    });

    it('a role of another base is not found (tenant and base isolation)', async () => {
      const otherRoles = roleListSchema.parse(
        (await call(owner, 'GET', `/bases/${otherBaseId}/roles`)).json(),
      );
      const foreign = otherRoles.items[0];
      if (foreign === undefined) throw new Error('no role');
      expectProblem(
        await call(owner, 'GET', `/bases/${baseId}/roles/${foreign.id}`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call(owner, 'PATCH', `/bases/${baseId}/roles/${foreign.id}`, { name: 'x' }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call(owner, 'DELETE', `/bases/${baseId}/roles/${foreign.id}`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
          principal_type: 'user',
          principal_id: outsider.id,
          role_id: foreign.id,
        }),
        422,
        'VALIDATION_FAILED',
        { path: 'role_id', code: 'UNKNOWN_ROLE' },
      );
      expectProblem(
        await call(owner, 'GET', `/bases/${baseId}/roles/not-a-role`),
        422,
        'VALIDATION_FAILED',
      );
    });

    it('rejects mutations without the CSRF token', async () => {
      const response = await call(
        owner,
        'POST',
        `/bases/${baseId}/roles`,
        { name: 'NoCsrf' },
        {
          csrf: false,
        },
      );
      expectProblem(response, 403, 'CSRF_INVALID');
    });
  });

  describe('custom roles', () => {
    it('creates the Sales role: 201, normalised config, version bump, events and audit', async () => {
      const before = await version();
      const created = await call(owner, 'POST', `/bases/${baseId}/roles`, {
        name: 'Sales',
        config: salesConfig(),
      });
      expect(created.statusCode).toBe(201);
      const role = roleWithAdjustmentsSchema.parse(created.json());
      expect(role).toMatchObject({
        base_id: baseId,
        name: 'Sales',
        kind: 'custom',
        position: 3,
        assignments: [],
        adjustments: [],
      });
      expect(role.config).toEqual(salesConfig());
      sales = role;
      expect(await version()).toBe(before + 1);

      const events = await db.kysely
        .selectFrom('meta.events')
        .select(['type', 'entity_type', 'entity_id', 'actor_id', 'payload'])
        .where('organization_id', '=', org)
        .where('type', 'in', ['role.created', 'permission.changed'])
        .where('actor_id', '=', owner.id)
        .orderBy('created_at')
        .execute();
      expect(events.filter((event) => event.entity_id === role.id)).toEqual([
        expect.objectContaining({ type: 'role.created', entity_type: 'role' }),
      ]);
      expect(events.at(-1)).toMatchObject({
        type: 'permission.changed',
        entity_type: 'base',
        entity_id: baseId,
      });
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['action', 'before', 'after', 'batch_id', 'request_id'])
        .where('entity_id', '=', role.id)
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({
        action: 'role.created',
        before: null,
        after: { name: 'Sales', kind: 'custom', config: salesConfig() },
      });
      const permissionAudit = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['after'])
        .where('action', '=', 'permission.changed')
        .where('batch_id', '=', audit.batch_id)
        .executeTakeFirstOrThrow();
      expect(permissionAudit.after).toEqual({ permission_version: before + 1 });
    });

    it('rejects duplicate names (case-insensitive, system roles included) with 409', async () => {
      const before = await version();
      expectProblem(
        await call(owner, 'POST', `/bases/${baseId}/roles`, { name: 'sales' }),
        409,
        'NAME_CONFLICT',
      );
      expectProblem(
        await call(owner, 'POST', `/bases/${baseId}/roles`, { name: 'EDITOR' }),
        409,
        'NAME_CONFLICT',
      );
      expectProblem(
        await call(owner, 'PATCH', `/bases/${baseId}/roles/${system.reader.id}`, {
          name: 'Sales',
        }),
        409,
        'NAME_CONFLICT',
      );
      expect(await version()).toBe(before);
    });

    it('validates the config against the base: shape, tables, fields and filters', async () => {
      const post = (config: object) =>
        call(owner, 'POST', `/bases/${baseId}/roles`, { name: 'Broken', config });
      expectProblem(await post({ tables: {}, extra: 1 }), 422, 'VALIDATION_FAILED');
      expectProblem(
        await post({ tables: { [orders.id]: { perm: 'owner' } } }),
        422,
        'VALIDATION_FAILED',
        { path: `config.tables.${orders.id}.perm`, code: 'INVALID_VALUE' },
      );
      expectProblem(
        await post({ tables: { [newId('tbl')]: { perm: 'read_only' } } }),
        422,
        'VALIDATION_FAILED',
        { code: 'UNKNOWN_TABLE' },
      );
      expectProblem(
        await post({
          tables: {
            [orders.id]: {
              perm: 'edit',
              field_rule: { fields: { [customers.primary_field_id]: 'read' } },
            },
          },
        }),
        422,
        'VALIDATION_FAILED',
        {
          path: `config.tables.${orders.id}.field_rule.fields.${customers.primary_field_id}`,
          code: 'UNKNOWN_FIELD',
        },
      );
      // A filter on a field of another table: unknown field.
      expectProblem(
        await post({
          tables: {
            [orders.id]: {
              perm: 'edit',
              record_rule: {
                edit_filter: { field: customers.primary_field_id, operator: 'is', value: 'x' },
              },
            },
          },
        }),
        422,
        'INVALID_FILTER',
        { path: `config.tables.${orders.id}.record_rule.edit_filter.field`, code: 'UNKNOWN_FIELD' },
      );
      expectProblem(
        await post({
          tables: {
            [orders.id]: {
              perm: 'read_only',
              record_rule: {
                read_scope: 'filter',
                read_filter: { field: f.amount.id, operator: 'is', value: 'not a number' },
              },
            },
          },
        }),
        422,
        'INVALID_FILTER',
      );
      const list = roleListSchema.parse(
        (await call(owner, 'GET', `/bases/${baseId}/roles`)).json(),
      );
      expect(list.items.map((role) => role.name)).not.toContain('Broken');
    });

    it('P26: a field used by edit_filter is raised to create (with add) or read (without)', async () => {
      const statusCondition = { field: f.status.id, operator: 'is_any_of', value: ['Mới', 'Xong'] };
      const before = await version();
      const response = await call(admin, 'PATCH', `/bases/${baseId}/roles/${sales.id}`, {
        config: salesConfig({ status: 'no_perm', conditions: [statusCondition] }),
      });
      expect(response.statusCode).toBe(200);
      const role = roleWithAdjustmentsSchema.parse(response.json());
      expect(role.adjustments).toEqual([
        {
          table_id: orders.id,
          field_id: f.status.id,
          from: 'no_perm',
          to: 'create',
          reason: 'filter_field_min_create',
        },
      ]);
      // Option names in the filter are stored as option ids.
      const options = f.status.options.options as { id: Id<'opt'> }[];
      expect(role.config.tables).toMatchObject({
        [orders.id]: {
          field_rule: { fields: { [f.status.id]: 'create' } },
          record_rule: {
            edit_filter: {
              items: [
                expect.anything(),
                {
                  field: f.status.id,
                  operator: 'is_any_of',
                  value: options.map((option) => option.id),
                },
              ],
            },
          },
        },
      });
      expect(await version()).toBe(before + 1);

      const readOnly = roleWithAdjustmentsSchema.parse(
        (
          await call(admin, 'PATCH', `/bases/${baseId}/roles/${sales.id}`, {
            config: salesConfig({
              status: 'no_perm',
              operations: [],
              conditions: [statusCondition],
            }),
          })
        ).json(),
      );
      expect(readOnly.adjustments).toEqual([
        expect.objectContaining({
          field_id: f.status.id,
          to: 'read',
          reason: 'filter_field_min_read',
        }),
      ]);

      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['before', 'after'])
        .where('action', '=', 'role.updated')
        .where('entity_id', '=', sales.id)
        .orderBy('created_at', 'desc')
        .executeTakeFirstOrThrow();
      expect(audit.before).toHaveProperty('config');
      expect(audit.after).toHaveProperty('config');
      expect(audit.before).not.toHaveProperty('name');

      // Back to the CONTRACTS §5 Sales role for the next tests.
      const restored = await call(admin, 'PATCH', `/bases/${baseId}/roles/${sales.id}`, {
        config: salesConfig(),
      });
      expect(roleWithAdjustmentsSchema.parse(restored.json()).adjustments).toEqual([]);
    });

    it('P27: computed fields (auto_number) are capped at read', async () => {
      const response = await call(owner, 'POST', `/bases/${baseId}/roles`, {
        name: 'Computed',
        config: {
          tables: {
            [orders.id]: {
              perm: 'edit',
              field_rule: { mode: 'specify', fields: { [f.number.id]: 'edit' } },
            },
          },
        },
      });
      expect(response.statusCode).toBe(201);
      const role = roleWithAdjustmentsSchema.parse(response.json());
      expect(role.adjustments).toEqual([
        {
          table_id: orders.id,
          field_id: f.number.id,
          from: 'edit',
          to: 'read',
          reason: 'computed_field_max_read',
        },
      ]);
      const tables = role.config.tables as Record<
        string,
        { field_rule: { fields: Record<string, string> } }
      >;
      expect(tables[orders.id]?.field_rule.fields[f.number.id]).toBe('read');
      expect((await call(owner, 'DELETE', `/bases/${baseId}/roles/${role.id}`)).statusCode).toBe(
        204,
      );
    });

    it('a PATCH that changes nothing writes nothing', async () => {
      const before = await version();
      const response = await call(owner, 'PATCH', `/bases/${baseId}/roles/${sales.id}`, {
        name: 'Sales',
        config: salesConfig(),
      });
      expect(response.statusCode).toBe(200);
      expect(await version()).toBe(before);
      expectProblem(
        await call(owner, 'PATCH', `/bases/${baseId}/roles/${sales.id}`, {}),
        422,
        'VALIDATION_FAILED',
      );
    });

    it('T815: dashboards.<id> must be a dashboard of the base (active or in the trash)', async () => {
      const dashboard = async (base: Id<'bse'>, name: string) =>
        dashboardSchema.parse(
          (await call(owner, 'POST', `/bases/${base}/dashboards`, { name })).json(),
        ).id;
      const active = await dashboard(baseId, 'T815 active');
      const trashed = await dashboard(baseId, 'T815 trashed');
      const purged = await dashboard(baseId, 'T815 purged');
      const elsewhere = await dashboard(otherBaseId, 'T815 other base');
      const config = (dashboards: Record<string, string>) => ({ tables: {}, dashboards });
      const post = (dashboards: Record<string, string>) =>
        call(owner, 'POST', `/bases/${baseId}/roles`, {
          name: 'Dashboards T815',
          config: config(dashboards),
        });

      const unknown = newId('dsh');
      expectProblem(await post({ [unknown]: 'read_only' }), 422, 'VALIDATION_FAILED', {
        path: `config.dashboards.${unknown}`,
        code: 'UNKNOWN_DASHBOARD',
      });
      // Another base's dashboard is unknown here (no hint that it exists).
      expectProblem(await post({ [elsewhere]: 'read_only' }), 422, 'VALIDATION_FAILED', {
        path: `config.dashboards.${elsewhere}`,
        code: 'UNKNOWN_DASHBOARD',
      });

      const created = await post({
        [active]: 'read_only',
        [trashed]: 'read_only',
        [purged]: 'read_only',
      });
      expect(created.statusCode).toBe(201);
      const role = roleWithAdjustmentsSchema.parse(created.json());
      expect((await call(owner, 'DELETE', `/dashboards/${trashed}`)).statusCode).toBe(204);
      // `maintenance.cleanup` purges a dashboard after 30 days in the trash.
      await db.kysely.deleteFrom('meta.dashboards').where('id', '=', purged).execute();

      // Saving the stored config again: the trashed grant stays (restore keeps it),
      // the purged one is dropped silently.
      const saved = await call(owner, 'PATCH', `/bases/${baseId}/roles/${role.id}`, {
        config: config({ [active]: 'read_only', [trashed]: 'read_only', [purged]: 'read_only' }),
      });
      expect(saved.statusCode).toBe(200);
      expect(roleSchema.parse(saved.json()).config['dashboards']).toEqual({
        [active]: 'read_only',
        [trashed]: 'read_only',
      });
      // An id the stored config never listed is still refused.
      expectProblem(
        await call(owner, 'PATCH', `/bases/${baseId}/roles/${role.id}`, {
          config: config({ [active]: 'read_only', [unknown]: 'read_only' }),
        }),
        422,
        'VALIDATION_FAILED',
        { path: `config.dashboards.${unknown}`, code: 'UNKNOWN_DASHBOARD' },
      );
      expect((await call(owner, 'DELETE', `/bases/${baseId}/roles/${role.id}`)).statusCode).toBe(
        204,
      );
    });
  });

  describe('system roles', () => {
    it('reader never gets edit/add/delete; editor never schema', async () => {
      const readerRole = roleWithAdjustmentsSchema.parse(
        (
          await call(owner, 'PATCH', `/bases/${baseId}/roles/${system.reader.id}`, {
            config: {
              base_rule: { copy: true, download: true, share_link: false },
              tables: {
                [orders.id]: { perm: 'manage', record_rule: { operations: ['add', 'delete'] } },
              },
            },
          })
        ).json(),
      );
      expect(readerRole.adjustments.map((item) => item.reason)).toEqual([
        'reader_ceiling',
        'operations_require_edit',
      ]);
      expect(readerRole.config.tables).toMatchObject({
        [orders.id]: { perm: 'read_only', record_rule: { operations: [] } },
      });
      const readerAccess = await accessOf(reader);
      expect(readerAccess.tables[orders.id]).toMatchObject({ perm: 'read_only', operations: [] });

      const editorRole = roleWithAdjustmentsSchema.parse(
        (
          await call(owner, 'PATCH', `/bases/${baseId}/roles/${system.editor.id}`, {
            config: {
              base_rule: { copy: true, download: true, share_link: true },
              tables: { [orders.id]: { perm: 'manage', view_rule: { allow_edit: true } } },
            },
          })
        ).json(),
      );
      expect(editorRole.adjustments).toEqual([
        {
          table_id: orders.id,
          field_id: null,
          from: 'manage',
          to: 'edit',
          reason: 'editor_ceiling',
        },
      ]);
      expect((await accessOf(editor)).tables[orders.id]?.perm).toBe('edit');
    });

    it('can be renamed; the admin config cannot change; system roles cannot be deleted', async () => {
      const renamed = await call(owner, 'PATCH', `/bases/${baseId}/roles/${system.admin.id}`, {
        name: 'Administrators',
      });
      expect(renamed.statusCode).toBe(200);
      expect(roleSchema.parse(renamed.json()).name).toBe('Administrators');
      expectProblem(
        await call(owner, 'PATCH', `/bases/${baseId}/roles/${system.admin.id}`, { config: {} }),
        422,
        'VALIDATION_FAILED',
        { path: 'config', code: 'SYSTEM_ROLE' },
      );
      for (const role of Object.values(system)) {
        expectProblem(
          await call(owner, 'DELETE', `/bases/${baseId}/roles/${role.id}`),
          422,
          'VALIDATION_FAILED',
          { code: 'SYSTEM_ROLE' },
        );
      }
    });
  });

  describe('assignments', () => {
    it('assigns a group, replaces a role, removes it; principals must belong to the org', async () => {
      const before = await version();
      const toGroup = await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
        principal_type: 'group',
        principal_id: salesGroup,
        role_id: sales.id,
      });
      expect(toGroup.statusCode).toBe(200);
      expect(roleAssignmentSchema.parse(toGroup.json())).toEqual({
        base_id: baseId,
        role_id: sales.id,
        principal_type: 'group',
        principal_id: salesGroup,
        previous_role_id: null,
      });
      expect(await version()).toBe(before + 1);
      expect((await accessOf(sales1)).role).toEqual({
        id: sales.id,
        kind: 'custom',
        name: 'Sales',
      });

      const first = await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: outsider.id,
        role_id: sales.id,
      });
      expect(roleAssignmentSchema.parse(first.json()).previous_role_id).toBeNull();
      const replaced = await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: outsider.id,
        role_id: system.reader.id,
      });
      expect(roleAssignmentSchema.parse(replaced.json()).previous_role_id).toBe(sales.id);
      const list = roleListSchema.parse(
        (await call(owner, 'GET', `/bases/${baseId}/roles`)).json(),
      );
      const holders = (id: Id<'rol'>) =>
        list.items.find((role) => role.id === id)?.assignments.map((item) => item.principal_id);
      expect(holders(sales.id)).toEqual([salesGroup]);
      expect(holders(system.reader.id)).toEqual(expect.arrayContaining([reader.id, outsider.id]));

      // Assignees carry their names (users: display name + email; groups: name, no email).
      const salesRole = roleSchema.parse(
        (await call(owner, 'GET', `/bases/${baseId}/roles/${sales.id}`)).json(),
      );
      expect(salesRole.assignments).toEqual([
        { principal_type: 'group', principal_id: salesGroup, name: 'Sales', email: null },
      ]);
      expect(
        list.items
          .find((role) => role.id === system.reader.id)
          ?.assignments.find((item) => item.principal_id === outsider.id),
      ).toEqual({
        principal_type: 'user',
        principal_id: outsider.id,
        name: outsider.email.split('@')[0],
        email: outsider.email,
      });

      // Same role again: nothing changes.
      const unchanged = await version();
      await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: outsider.id,
        role_id: system.reader.id,
      });
      expect(await version()).toBe(unchanged);

      const events = await db.kysely
        .selectFrom('meta.events')
        .select(['type', 'payload'])
        .where('type', '=', 'role_assignment.changed')
        .where('entity_id', '=', outsider.id)
        .orderBy('created_at')
        .execute();
      expect(events).toHaveLength(2);
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['before', 'after'])
        .where('action', '=', 'role_assignment.changed')
        .where('entity_id', '=', outsider.id)
        .orderBy('created_at')
        .execute();
      expect(audit).toEqual([
        { before: null, after: { role_id: sales.id } },
        { before: { role_id: sales.id }, after: { role_id: system.reader.id } },
      ]);

      const removed = await call(owner, 'DELETE', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: outsider.id,
      });
      expect(removed.statusCode).toBe(204);
      expectProblem(await call(outsider, 'GET', `/bases/${baseId}`), 404, 'NOT_FOUND');
      expectProblem(
        await call(owner, 'DELETE', `/bases/${baseId}/role-assignments`, {
          principal_type: 'user',
          principal_id: outsider.id,
        }),
        404,
        'NOT_FOUND',
      );

      const assign = (body: object) =>
        call(owner, 'PUT', `/bases/${baseId}/role-assignments`, { role_id: sales.id, ...body });
      expectProblem(
        await assign({ principal_type: 'user', principal_id: stranger.id }),
        422,
        'VALIDATION_FAILED',
        { path: 'principal_id', code: 'UNKNOWN_PRINCIPAL' },
      );
      expectProblem(
        await assign({ principal_type: 'group', principal_id: strangerGroup }),
        422,
        'VALIDATION_FAILED',
        { path: 'principal_id', code: 'UNKNOWN_PRINCIPAL' },
      );
      expectProblem(
        await assign({ principal_type: 'group', principal_id: outsider.id }),
        422,
        'VALIDATION_FAILED',
      );
    });

    it('a role in use cannot be deleted; an unused one can', async () => {
      expectProblem(
        await call(owner, 'DELETE', `/bases/${baseId}/roles/${sales.id}`),
        422,
        'VALIDATION_FAILED',
        { code: 'ROLE_IN_USE' },
      );
      const temp = roleWithAdjustmentsSchema.parse(
        (await call(owner, 'POST', `/bases/${baseId}/roles`, { name: 'Temp' })).json(),
      );
      const before = await version();
      expect((await call(owner, 'DELETE', `/bases/${baseId}/roles/${temp.id}`)).statusCode).toBe(
        204,
      );
      expect(await version()).toBe(before + 1);
      expectProblem(
        await call(owner, 'GET', `/bases/${baseId}/roles/${temp.id}`),
        404,
        'NOT_FOUND',
      );
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['before'])
        .where('action', '=', 'role.deleted')
        .where('entity_id', '=', temp.id)
        .executeTakeFirstOrThrow();
      expect(audit.before).toMatchObject({ name: 'Temp', kind: 'custom' });
    });

    it('P25: a direct role beats the group role (over HTTP)', async () => {
      // A Customers record only the owner can read (P20, BACKLOG T412): no
      // config at all for Customers in the Sales role.
      p20Customer = recordsResponseSchema.parse(
        (
          await call(owner, 'POST', `/tables/${customers.id}/records?field_key_type=id`, {
            records: [{ fields: { [customers.primary_field_id]: 'Khách hàng Long' } }],
          })
        ).json(),
      ).records[0]?.id as Id<'rec'>;
      const created = await call(owner, 'POST', `/tables/${orders.id}/records?field_key_type=id`, {
        records: [
          {
            fields: {
              [f.title.id]: 'r1',
              [f.amount.id]: 100,
              [f.status.id]: 'Mới',
              [f.owner.id]: [{ id: sales1.id }],
              [f.customer.id]: [p20Customer],
            },
          },
          {
            fields: {
              [f.title.id]: 'r2',
              [f.amount.id]: 200,
              [f.status.id]: 'Xong',
              [f.owner.id]: [{ id: sales2.id }],
            },
          },
          { fields: { [f.title.id]: 'r3' } },
        ],
      });
      expect(created.statusCode, created.body).toBe(201);
      const r1 = recordsResponseSchema.parse(created.json()).records[0]?.id as Id<'rec'>;
      p20Order = r1;
      const titles = async (user: SeededUser) => {
        const response = await call(user, 'POST', `/tables/${orders.id}/records/query`, {});
        expect(response.statusCode, response.body).toBe(200);
        return recordListResponseSchema
          .parse(response.json())
          .records.map((record) => record.fields['title'])
          .sort();
      };

      expect(await titles(sales1)).toEqual(['r1']);
      const groupAccess = await accessOf(sales1);
      expect(groupAccess.tables[orders.id]?.fields).not.toHaveProperty(f.cost.id);
      expect(
        (
          await call(sales1, 'PATCH', `/tables/${orders.id}/records/${r1}`, {
            fields: { amount: 5 },
          })
        ).statusCode,
      ).toBe(200);

      const assigned = await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: sales1.id,
        role_id: system.reader.id,
      });
      expect(assigned.statusCode).toBe(200);
      const direct = await accessOf(sales1);
      expect(direct.role).toMatchObject({ id: system.reader.id, kind: 'system_reader' });
      expect(direct.tables[orders.id]).toMatchObject({
        perm: 'read_only',
        operations: [],
        read_scope: 'all',
      });
      expect(Object.values(direct.tables[orders.id]?.fields ?? {})).not.toContain('edit');
      expect(await titles(sales1)).toEqual(['r1', 'r2', 'r3']);
      expectProblem(
        await call(sales1, 'PATCH', `/tables/${orders.id}/records/${r1}`, {
          fields: { amount: 6 },
        }),
        403,
        'PERMISSION_DENIED',
      );
      // sales2 keeps the group role.
      expect(await titles(sales2)).toEqual(['r2']);

      await call(owner, 'DELETE', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: sales1.id,
      });
      expect((await accessOf(sales1)).role?.id).toBe(sales.id);
    });

    it('P20: u_sales1 reads the id of a linked customer, title null (BACKLOG T412)', async () => {
      const asSales1 = await call(sales1, 'GET', `/tables/${orders.id}/records/${p20Order}`);
      expect(asSales1.statusCode, asSales1.body).toBe(200);
      expect(recordSchema.parse(asSales1.json()).fields['customer']).toEqual([
        { id: p20Customer, title: null },
      ]);

      // The owner reads Customers, so the title comes through.
      const asOwner = await call(owner, 'GET', `/tables/${orders.id}/records/${p20Order}`);
      expect(recordSchema.parse(asOwner.json()).fields['customer']).toEqual([
        { id: p20Customer, title: 'Khách hàng Long' },
      ]);

      // P19: u_sales1 has no config at all for Customers → 404, not 403.
      expectProblem(
        await call(sales1, 'POST', `/tables/${customers.id}/records/query`, {}),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('P16–P18: views and export by permission', () => {
    it('P16: u_sales1 queries through viw_all → 404, through the Sales view → only r1', async () => {
      const url = `/tables/${orders.id}/records/query`;
      const titles = (response: LightMyRequestResponse) =>
        recordListResponseSchema
          .parse(response.json())
          .records.map((record) => record.fields['title'])
          .sort();
      expect(titles(await call(sales1, 'POST', url, {}))).toEqual(['r1']);
      const hidden = await call(sales1, 'POST', url, { view_id: viewAll });
      expectProblem(hidden, 404, 'NOT_FOUND');
      const visible = await call(sales1, 'POST', url, { view_id: viewSales });
      expect(visible.statusCode).toBe(200);
      expect(titles(visible)).toEqual(['r1']);
      expect(recordListResponseSchema.parse(visible.json()).records[0]?.fields).not.toHaveProperty(
        'cost',
      );
      // GET …/records?view_id= goes the same way.
      expectProblem(
        await call(sales1, 'GET', `/tables/${orders.id}/records?view_id=${viewAll}`),
        404,
        'NOT_FOUND',
      );
      expect(
        titles(await call(sales1, 'GET', `/tables/${orders.id}/records?view_id=${viewSales}`)),
      ).toEqual(['r1']);

      // Someone else's personal view and a view of another table: 404 alike.
      const personal = await call(editor, 'POST', `/tables/${orders.id}/views`, {
        name: 'Editor only',
        type: 'grid',
        is_personal: true,
      });
      expect(personal.statusCode).toBe(201);
      const personalId = viewSchema.parse(personal.json()).id;
      const customersView = viewListSchema.parse(
        (await call(owner, 'GET', `/tables/${customers.id}/views`)).json(),
      ).items[0]?.id as Id<'viw'>;
      for (const [user, viewId] of [
        [owner, personalId],
        [sales1, personalId],
        [owner, customersView],
        [owner, 'viw_0000000000000000'],
      ] as const) {
        const response = await call(user, 'POST', url, { view_id: viewId });
        expectProblem(response, 404, 'NOT_FOUND');
        expect({ ...problemOf(response.body), request_id: null }).toEqual({
          ...problemOf(hidden.body),
          request_id: null,
        });
      }
      expect(titles(await call(editor, 'POST', url, { view_id: personalId }))).toEqual([
        'r1',
        'r2',
        'r3',
      ]);
      expect((await call(editor, 'DELETE', `/views/${personalId}`)).statusCode).toBe(204);
    });

    it('a request filter cannot widen the view: the opposite condition returns nothing', async () => {
      const created = await call(owner, 'POST', `/tables/${orders.id}/views`, {
        name: 'Only new',
        type: 'grid',
        config: {
          filter: { logic: 'and', conditions: [[f.status.id, '==', 'Mới']] },
          sort: [{ field: f.amount.id, direction: 'desc' }],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const onlyNew = viewSchema.parse(created.json()).id;
      const url = `/tables/${orders.id}/records/query`;
      const titles = async (body: object) => {
        const response = await call(reader, 'POST', url, { view_id: onlyNew, ...body });
        expect(response.statusCode, response.body).toBe(200);
        return recordListResponseSchema
          .parse(response.json())
          .records.map((r) => r.fields['title']);
      };
      expect(await titles({})).toEqual(['r1']);
      expect(
        await titles({ filter: { logic: 'and', conditions: [['status', '!=', 'Mới']] } }),
      ).toEqual([]);
      expect(
        await titles({ filter: { logic: 'and', conditions: [['title', '==', 'r1']] } }),
      ).toEqual(['r1']);

      // Group counts: same WHERE, grouped by the request's group.
      const counts = await call(reader, 'POST', `/tables/${orders.id}/records/group-counts`, {
        view_id: onlyNew,
        group: [{ field: 'status' }],
      });
      expect(counts.statusCode, counts.body).toBe(200);
      expect(recordGroupCountsResponseSchema.parse(counts.json())).toEqual({
        group: [{ field: 'status', direction: 'asc' }],
        groups: [{ values: ['Mới'], count: 1 }],
        truncated: false,
      });
      expect((await call(owner, 'DELETE', `/views/${onlyNew}`)).statusCode).toBe(204);
    });

    it('group counts: 404 for what the caller cannot read, 422 on hidden fields, CSRF', async () => {
      const url = (tableId: Id<'tbl'>) => `/tables/${tableId}/records/group-counts`;
      const all = await call(sales1, 'POST', url(orders.id), { group: [{ field: 'status' }] });
      expect(all.statusCode, all.body).toBe(200);
      expect(recordGroupCountsResponseSchema.parse(all.json()).groups).toEqual([
        { values: ['Mới'], count: 1 },
      ]);
      expectProblem(
        await call(sales1, 'POST', url(orders.id), { view_id: viewAll }),
        404,
        'NOT_FOUND',
      );
      expectProblem(await call(sales1, 'POST', url(customers.id), {}), 404, 'NOT_FOUND');
      expectProblem(await call(outsider, 'POST', url(orders.id), {}), 404, 'NOT_FOUND');
      expectProblem(await call(stranger, 'POST', url(orders.id), {}), 404, 'NOT_FOUND');
      expectProblem(
        await call(sales1, 'POST', url(orders.id), { group: [{ field: 'cost' }] }),
        422,
        'INVALID_SORT',
        { path: 'group[0].field', code: 'UNKNOWN_FIELD' },
      );
      expectProblem(
        await call(sales1, 'POST', url(orders.id), {
          group: [{ field: 'status' }, { field: 'amount' }, { field: 'title' }, { field: 'owner' }],
        }),
        422,
        'VALIDATION_FAILED',
      );
      expectProblem(
        await call(reader, 'POST', url(orders.id), {}, { csrf: false }),
        403,
        'CSRF_INVALID',
      );
    });

    it('P17: shared views need view_rule.allow_edit; hidden views are 404', async () => {
      const create = (user: SeededUser, tableId: Id<'tbl'>, body: object = {}) =>
        call(user, 'POST', `/tables/${tableId}/views`, { name: 'Mine', type: 'grid', ...body });
      expectProblem(await create(sales1, orders.id), 403, 'PERMISSION_DENIED');
      expectProblem(await create(sales1, customers.id), 404, 'NOT_FOUND');
      expectProblem(await create(outsider, orders.id), 404, 'NOT_FOUND');
      expectProblem(await create(stranger, orders.id), 404, 'NOT_FOUND');
      expectProblem(await create(reader, orders.id), 403, 'PERMISSION_DENIED');
      for (const body of [{ name: 'x' }, { config: { row_height: 'tall' } }, { position: 0 }]) {
        expectProblem(
          await call(sales1, 'PATCH', `/views/${viewSales}`, body),
          403,
          'PERMISSION_DENIED',
        );
        expectProblem(await call(sales1, 'PATCH', `/views/${viewAll}`, body), 404, 'NOT_FOUND');
      }
      expectProblem(await call(sales1, 'DELETE', `/views/${viewSales}`), 403, 'PERMISSION_DENIED');
      expectProblem(await call(sales1, 'DELETE', `/views/${viewAll}`), 404, 'NOT_FOUND');
      // Personal views are open to every reader of the table (BACKLOG S3 decision 4).
      const personal = await create(sales1, orders.id, { is_personal: true });
      expect(personal.statusCode).toBe(201);
      const created = await create(editor, orders.id, { name: 'Editor view' });
      expect(created.statusCode).toBe(201);
      for (const response of [personal, created]) {
        const id = viewSchema.parse(response.json()).id;
        const by = response === personal ? sales1 : editor;
        expect((await call(by, 'DELETE', `/views/${id}`)).statusCode).toBe(204);
      }
      expectProblem(
        await call(editor, 'POST', `/tables/${orders.id}/views`, {}, { csrf: false }),
        403,
        'CSRF_INVALID',
      );
    });

    it('P18: export needs base_rule.download', async () => {
      const exportAs = (user: SeededUser, tableId: Id<'tbl'>) =>
        call(user, 'GET', `/tables/${tableId}/export?format=csv`);
      expectProblem(await exportAs(sales1, orders.id), 403, 'PERMISSION_DENIED');
      expectProblem(await exportAs(sales1, customers.id), 404, 'NOT_FOUND');
      expectProblem(await exportAs(outsider, orders.id), 404, 'NOT_FOUND');
      expectProblem(await exportAs(stranger, orders.id), 404, 'NOT_FOUND');
      for (const user of [reader, editor, owner]) {
        const response = await exportAs(user, orders.id);
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      }
    });
  });

  /**
   * BACKLOG T464, CONTRACTS §5: the computed rows of the matrix over HTTP
   * (T457 covers them at the service level): P27 on a real formula, P34
   * (lookup of a table Sales cannot read), P35 (a read_filter on the source
   * table), P36 (`strict_computed_permissions`).
   */
  describe('P27, P34–P36: computed fields by reader (T464)', () => {
    const c = {} as Record<'phone' | 'total' | 'customerPhone' | 'ordersTotal', FieldDto>;

    /** What the `computed.backfill` job does for one stored field (no worker in tests). */
    async function backfill(fieldId: Id<'fld'>): Promise<void> {
      const scope = orgScope(org);
      let cursor = 0n;
      for (;;) {
        const result = await t.app.get(RecordMutationService).backfillComputedBatch(scope, {
          fieldId,
          afterAuto: cursor,
          limit: 1_000,
          statementTimeoutMs: 30_000,
        });
        if (result.status !== 'more') break;
        cursor = result.cursor;
      }
      await t.app.get(SchemaService).finishComputedBackfill(scope, fieldId, { status: 'ready' });
    }

    async function addField(tableId: Id<'tbl'>, body: object): Promise<FieldDto> {
      const response = await call(owner, 'POST', `/tables/${tableId}/fields`, body);
      expect(response.statusCode, response.body).toBe(201);
      const field = fieldSchema.parse(response.json());
      if (field.compute_state === 'backfilling') await backfill(field.id);
      return field;
    }

    async function fieldsOf(user: SeededUser, tableId: Id<'tbl'>) {
      const response = await call(user, 'GET', `/tables/${tableId}/fields?limit=100`);
      expect(response.statusCode, response.body).toBe(200);
      return new Map(
        fieldListSchema.parse(response.json()).items.map((field) => [field.name, field]),
      );
    }

    async function recordOf(user: SeededUser, tableId: Id<'tbl'>, recordId: Id<'rec'>) {
      const response = await call(user, 'GET', `/tables/${tableId}/records/${recordId}`);
      expect(response.statusCode, response.body).toBe(200);
      return recordSchema.parse(response.json()).fields;
    }

    beforeAll(async () => {
      // CONTRACTS §5 fixture (P34–P36): Customers.phone, r1 with a cost.
      c.phone = await addField(customers.id, { name: 'phone', type: 'text' });
      for (const [tableId, recordId, fields] of [
        [customers.id, p20Customer, { phone: '0901' }],
        [orders.id, p20Order, { cost: 10 }],
      ] as const) {
        const patched = await call(owner, 'PATCH', `/tables/${tableId}/records/${recordId}`, {
          fields,
        });
        expect(patched.statusCode, patched.body).toBe(200);
      }
      c.total = await addField(orders.id, {
        name: 'total_formula',
        type: 'formula',
        options: { expression: '[amount] + [cost]' },
      });
      c.customerPhone = await addField(orders.id, {
        name: 'customer_phone',
        type: 'lookup',
        options: {
          from: customers.id,
          select: c.phone.id,
          where: { field: '__id', operator: 'is_any_of', value: { field_ref: f.customer.id } },
        },
      });
      c.ordersTotal = await addField(customers.id, {
        name: 'orders_total',
        type: 'lookup',
        options: {
          from: orders.id,
          select: f.amount.id,
          where: { field: f.customer.id, operator: 'intersects', value: { field_ref: '__id' } },
          aggregate: 'sum',
          style: { type: 'currency', currency_code: 'VND' },
        },
      });
    });

    it('P27: a role giving edit on total_formula is capped at read', async () => {
      const response = await call(owner, 'POST', `/bases/${baseId}/roles`, {
        name: 'Formula editors',
        config: {
          tables: {
            [orders.id]: {
              perm: 'edit',
              field_rule: { mode: 'specify', fields: { [c.total.id]: 'edit' } },
            },
          },
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      const role = roleWithAdjustmentsSchema.parse(response.json());
      expect(role.adjustments).toEqual([
        {
          table_id: orders.id,
          field_id: c.total.id,
          from: 'edit',
          to: 'read',
          reason: 'computed_field_max_read',
        },
      ]);
      expect((await call(owner, 'DELETE', `/bases/${baseId}/roles/${role.id}`)).statusCode).toBe(
        204,
      );
    });

    it('P34: u_sales1 reads the lookup customer → phone as null, locked; filter/sort 422', async () => {
      expect(await recordOf(owner, orders.id, p20Order)).toMatchObject({
        customer_phone: ['0901'],
      });
      const fields = await fieldsOf(sales1, orders.id);
      expect(fields.get('customer_phone')).toMatchObject({ locked: true });
      // No definition for a reader without schema rights (nor the source ids).
      expect(fields.get('customer_phone')?.options).not.toHaveProperty('from');
      expect(fields.get('customer_phone')?.options).not.toHaveProperty('where');
      expect(await recordOf(sales1, orders.id, p20Order)).toMatchObject({ customer_phone: null });
      const url = `/tables/${orders.id}/records/query`;
      expectProblem(
        await call(sales1, 'POST', url, {
          filter: { field: c.customerPhone.id, operator: 'is_not_empty' },
        }),
        422,
        'INVALID_FILTER',
      );
      expectProblem(
        await call(sales1, 'POST', url, {
          sort: [{ field: 'customer_phone', direction: 'asc' }],
        }),
        422,
        'INVALID_SORT',
        { code: 'UNKNOWN_FIELD' },
      );
      // The same field read by the owner filters fine.
      const filtered = await call(owner, 'POST', url, {
        filter: { field: c.customerPhone.id, operator: 'is_not_empty' },
      });
      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(recordListResponseSchema.parse(filtered.json()).records.map((r) => r.id)).toEqual([
        p20Order,
      ]);
    });

    it('P35: a read_filter on Orders scopes the lookup sum on Customers to readable orders', async () => {
      const analyst = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
      const customer = recordsResponseSchema.parse(
        (
          await call(owner, 'POST', `/tables/${customers.id}/records?field_key_type=id`, {
            records: [{ fields: { [customers.primary_field_id]: 'Khách P35' } }],
          })
        ).json(),
      ).records[0]?.id as Id<'rec'>;
      const created = await call(owner, 'POST', `/tables/${orders.id}/records?field_key_type=id`, {
        records: [500_000, 700_000, 900_000].map((amount, index) => ({
          fields: {
            [f.title.id]: `p35-${String(index)}`,
            [f.amount.id]: amount,
            [f.customer.id]: [customer],
          },
        })),
      });
      expect(created.statusCode, created.body).toBe(201);
      const role = await call(owner, 'POST', `/bases/${baseId}/roles`, {
        name: 'P35 analysts',
        config: {
          tables: {
            [orders.id]: {
              perm: 'read_only',
              record_rule: {
                read_scope: 'filter',
                read_filter: { field: f.amount.id, operator: 'gte', value: 600_000 },
              },
              field_rule: { mode: 'all_read' },
            },
            [customers.id]: { perm: 'read_only', field_rule: { mode: 'all_read' } },
          },
        },
      });
      expect(role.statusCode, role.body).toBe(201);
      const assigned = await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: analyst.id,
        role_id: roleSchema.parse(role.json()).id,
      });
      expect(assigned.statusCode, assigned.body).toBe(200);

      // Stored value (every order) for the owner; the analyst's own orders only.
      expect(await recordOf(owner, customers.id, customer)).toMatchObject({
        orders_total: 2_100_000,
      });
      expect(await recordOf(analyst, customers.id, customer)).toMatchObject({
        orders_total: 1_600_000,
      });
      expect((await fieldsOf(analyst, customers.id)).get('orders_total')).toMatchObject({
        locked: false,
      });
      // Filters use the reader's values, never the stored ones.
      const url = `/tables/${customers.id}/records/query`;
      const ids = async (user: SeededUser, body: object) => {
        const response = await call(user, 'POST', url, body);
        expect(response.statusCode, response.body).toBe(200);
        return recordListResponseSchema.parse(response.json()).records.map((r) => r.id);
      };
      const over = { filter: { field: c.ordersTotal.id, operator: 'gte', value: 2_000_000 } };
      expect(await ids(owner, over)).toEqual([customer]);
      expect(await ids(analyst, over)).toEqual([]);
      const mine = { filter: { field: c.ordersTotal.id, operator: 'eq', value: 1_600_000 } };
      expect(await ids(analyst, mine)).toEqual([customer]);
      expect(await ids(owner, mine)).toEqual([]);
    });

    it('P36: total_formula over a no_perm field, strict_computed_permissions off and on', async () => {
      const read = async (user: SeededUser) =>
        (await recordOf(user, orders.id, p20Order))['total_formula'];
      // r1: amount 5 (P25) + cost 10.
      expect(await read(owner)).toBe(15);
      expect(await read(sales1)).toBe(15);
      expect((await fieldsOf(sales1, orders.id)).get('total_formula')).toMatchObject({
        locked: false,
      });
      const setStrict = async (on: boolean) => {
        const response = await call(owner, 'PATCH', `/bases/${baseId}`, {
          settings: { strict_computed_permissions: on },
        });
        expect(response.statusCode, response.body).toBe(200);
      };
      await setStrict(true);
      try {
        expect(await read(sales1)).toBeNull();
        expect((await fieldsOf(sales1, orders.id)).get('total_formula')).toMatchObject({
          locked: true,
        });
        expectProblem(
          await call(sales1, 'POST', `/tables/${orders.id}/records/query`, {
            filter: { field: c.total.id, operator: 'gt', value: 0 },
          }),
          422,
          'INVALID_FILTER',
        );
        // Readers of `cost` (admins included) always see it.
        expect(await read(owner)).toBe(15);
        expect(await read(admin)).toBe(15);
        expect(await read(reader)).toBe(15);
      } finally {
        await setStrict(false);
      }
      expect(await read(sales1)).toBe(15);
    });
  });
});
