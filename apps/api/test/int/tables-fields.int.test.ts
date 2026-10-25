import {
  baseDetailSchema,
  fieldListSchema,
  fieldSchema,
  newId,
  tableListSchema,
  tableSchema,
  updateFieldResponseSchema,
  workspaceSchema,
  type FieldDto,
  type Id,
  type TableDto,
} from '@cellhive/contracts';
import { roleConfigSchema, type RoleConfigInput } from '@cellhive/permissions';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  orgScope,
  RecordMutationService,
  SchemaService,
  type Db,
  type JsonObject,
  type RecordAccessContext,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { captureLogger, problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/** Polls an async condition (jobs run in the worker). */
async function eventually(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('eventually: timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * T103: table and field API with the schema permission rules of SPEC §14.1
 * and CONTRACTS §5 (P05, P06), hidden tables/fields, select option deletion
 * through the worker, CSRF and tenant isolation.
 */
describe('tables and fields (T103)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let worker: WorkerHandle | undefined;
  let org: Id<'org'>;
  let otherOrg: Id<'org'>;
  /** Org owner: creates the workspace and the base (base owner). */
  let owner: SeededUser;
  /** Base `admin` system role (u_admin). */
  let admin: SeededUser;
  /** Base `editor` system role (u_editor). */
  let editor: SeededUser;
  /** Custom role `Sales`: Orders `edit` without `cost`; Customers absent (u_sales1). */
  let sales: SeededUser;
  /** Custom role: Orders `manage`, nothing else. */
  let manager: SeededUser;
  /** Org member without a base role (u_out). */
  let outsider: SeededUser;
  /** Owner of another organization. */
  let stranger: SeededUser;
  const browsers = new Map<string, Browser>();
  let baseId: Id<'bse'>;
  let orders: TableDto;
  let customers: TableDto;
  const f = {} as Record<'title' | 'amount' | 'cost' | 'status' | 'due', FieldDto>;

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
    sales = await seedUser(db, member('member'));
    manager = await seedUser(db, member('member'));
    outsider = await seedUser(db, member('member'));
    stranger = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] });

    const workspace = workspaceSchema.parse(
      (await call(owner, 'POST', `/orgs/${org}/workspaces`, { name: 'Main' })).json(),
    );
    const base = baseDetailSchema.parse(
      (await call(owner, 'POST', `/workspaces/${workspace.id}/bases`, { name: 'CRM' })).json(),
    );
    baseId = base.id;
    await assignSystemRole('system_admin', admin.id);
    await assignSystemRole('system_editor', editor.id);
  });

  afterAll(async () => {
    await worker?.close();
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
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ): Promise<LightMyRequestResponse> {
    const browser = await as(user);
    return browser.request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  function expectProblem(response: LightMyRequestResponse, status: number, code: string): void {
    expect({ status: response.statusCode, code: problemOf(response.body).code }).toEqual({
      status,
      code,
    });
  }

  async function assignSystemRole(
    kind: 'system_admin' | 'system_editor',
    userId: Id<'usr'>,
  ): Promise<void> {
    const scope = orgScope(org);
    const role = (await new BaseRolesRepository(db).listByBase(scope, baseId)).find(
      (row) => row.kind === kind,
    );
    if (role === undefined) throw new Error(`no ${kind} role`);
    await new BaseRoleMembersRepository(db).assign(scope, {
      baseId,
      roleId: role.id,
      principalType: 'user',
      principalId: userId,
    });
  }

  async function assignCustomRole(
    name: string,
    config: RoleConfigInput,
    userId: Id<'usr'>,
  ): Promise<void> {
    const scope = orgScope(org);
    const role = await new BaseRolesRepository(db).create(scope, {
      baseId,
      name,
      kind: 'custom',
      config: roleConfigSchema.parse(config) as unknown as JsonObject,
    });
    await new BaseRoleMembersRepository(db).assign(scope, {
      baseId,
      roleId: role.id,
      principalType: 'user',
      principalId: userId,
    });
  }

  async function permissionVersion(): Promise<bigint> {
    const row = await db.kysely
      .selectFrom('meta.bases')
      .select('permission_version')
      .where('id', '=', baseId)
      .executeTakeFirstOrThrow();
    return row.permission_version;
  }

  describe('tables', () => {
    it('lets the base owner create tables with a primary field; duplicate names are 409', async () => {
      const created = await call(owner, 'POST', `/bases/${baseId}/tables`, {
        name: 'Orders',
        description: 'Sales orders',
        primary_field_name: 'title',
      });
      expect(created.statusCode).toBe(201);
      orders = tableSchema.parse(created.json());
      expect(orders).toMatchObject({
        base_id: baseId,
        name: 'Orders',
        description: 'Sales orders',
        schema_state: 'ready',
      });
      const defaulted = await call(owner, 'POST', `/bases/${baseId}/tables`, { name: 'Customers' });
      expect(defaulted.statusCode).toBe(201);
      customers = tableSchema.parse(defaulted.json());

      const fields = fieldListSchema.parse(
        (await call(owner, 'GET', `/tables/${customers.id}/fields`)).json(),
      );
      expect(fields.items).toEqual([
        expect.objectContaining({
          id: customers.primary_field_id,
          name: 'Name',
          type: 'text',
          is_primary: true,
        }),
      ]);

      const dupe = await call(owner, 'POST', `/bases/${baseId}/tables`, { name: 'Orders' });
      expectProblem(dupe, 409, 'NAME_CONFLICT');
      const events = await db.kysely
        .selectFrom('meta.events')
        .select(['type', 'actor_id'])
        .where('entity_id', '=', orders.id)
        .execute();
      expect(events).toEqual([{ type: 'table.created', actor_id: owner.id }]);
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['action', 'actor_id', 'batch_id', 'request_id'])
        .where('entity_id', '=', orders.id)
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({ action: 'table.created', actor_id: owner.id });
      expect(audit.batch_id).toBe(audit.request_id);
    });

    it('lists, reads, renames, describes and reorders tables', async () => {
      const list = tableListSchema.parse(
        (await call(owner, 'GET', `/bases/${baseId}/tables`)).json(),
      );
      expect(list).toMatchObject({ total: 2, offset: 0, limit: 50 });
      expect(list.items.map((table) => table.name)).toEqual(['Orders', 'Customers']);

      const moved = await call(owner, 'PATCH', `/tables/${customers.id}`, {
        position: 0,
        description: 'People we sell to',
      });
      expect(moved.statusCode).toBe(200);
      expect(tableSchema.parse(moved.json())).toMatchObject({ description: 'People we sell to' });
      const reordered = tableListSchema.parse(
        (await call(owner, 'GET', `/bases/${baseId}/tables`)).json(),
      );
      expect(reordered.items.map((table) => table.name)).toEqual(['Customers', 'Orders']);

      expectProblem(
        await call(owner, 'PATCH', `/tables/${customers.id}`, { name: 'Orders' }),
        409,
        'NAME_CONFLICT',
      );
      expectProblem(
        await call(owner, 'PATCH', `/tables/${customers.id}`, {}),
        422,
        'VALIDATION_FAILED',
      );
      const one = await call(owner, 'GET', `/tables/${orders.id}`);
      expect(tableSchema.parse(one.json()).id).toBe(orders.id);
      expectProblem(await call(owner, 'GET', '/tables/not-an-id'), 422, 'VALIDATION_FAILED');
      expectProblem(await call(owner, 'GET', `/tables/${newId('tbl')}`), 404, 'NOT_FOUND');
    });

    it('moves a table to the trash and restores it (base admins only)', async () => {
      const temp = tableSchema.parse(
        (await call(owner, 'POST', `/bases/${baseId}/tables`, { name: 'Temp' })).json(),
      );
      const before = await permissionVersion();
      expect((await call(owner, 'DELETE', `/tables/${temp.id}`)).statusCode).toBe(204);
      expect(await permissionVersion()).toBe(before + 1n);
      expectProblem(await call(owner, 'GET', `/tables/${temp.id}`), 404, 'NOT_FOUND');
      // Editors do not see trashed tables.
      expectProblem(await call(editor, 'POST', `/tables/${temp.id}/restore`), 404, 'NOT_FOUND');
      const restored = await call(admin, 'POST', `/tables/${temp.id}/restore`);
      expect(restored.statusCode).toBe(200);
      expect(tableSchema.parse(restored.json()).id).toBe(temp.id);
      expect((await call(owner, 'GET', `/tables/${temp.id}`)).statusCode).toBe(200);
      expect((await call(owner, 'DELETE', `/tables/${temp.id}`)).statusCode).toBe(204);
    });
  });

  describe('fields', () => {
    it('creates fields of each kind with validated options (P06: base admin)', async () => {
      const before = await permissionVersion();
      const create = async (body: object) => {
        const response = await call(admin, 'POST', `/tables/${orders.id}/fields`, body);
        expect(response.statusCode).toBe(201);
        return fieldSchema.parse(response.json());
      };
      f.amount = await create({ name: 'amount', type: 'number' });
      f.cost = await create({
        name: 'cost',
        type: 'number',
        options: { style: { type: 'currency', precision: 0, currency_code: 'VND' } },
      });
      f.status = await create({
        name: 'status',
        type: 'select',
        options: { options: [{ name: 'Mới', color: 1 }, { name: 'Xong' }] },
      });
      f.due = await create({
        name: 'due',
        type: 'datetime',
        options: { style: { format: 'yyyy-MM-dd' } },
        description: 'Due date',
      });
      expect(await permissionVersion()).toBe(before + 4n);
      const optionList = f.status.options.options as { id: string; name: string }[];
      expect(optionList.map((option) => option.name)).toEqual(['Mới', 'Xong']);
      for (const option of optionList) expect(option.id).toMatch(/^opt_[0-9A-Za-z]{16}$/);
      expect(f.cost.options).toMatchObject({ style: { type: 'currency', currency_code: 'VND' } });

      const list = fieldListSchema.parse(
        (await call(admin, 'GET', `/tables/${orders.id}/fields`)).json(),
      );
      f.title = list.items[0] as FieldDto;
      expect(list.items.map((field) => field.name)).toEqual([
        'title',
        'amount',
        'cost',
        'status',
        'due',
      ]);
      expect((await call(admin, 'GET', `/fields/${f.due.id}`)).json()).toMatchObject({
        id: f.due.id,
        description: 'Due date',
      });

      // Invalid options, unsupported types and duplicate names.
      const badOptions = await call(admin, 'POST', `/tables/${orders.id}/fields`, {
        name: 'bad',
        type: 'number',
        options: { style: { type: 'rating', max: 99 } },
      });
      expectProblem(badOptions, 422, 'VALIDATION_FAILED');
      expect(String((problemOf(badOptions.body).errors as { path: string }[])[0]?.path)).toMatch(
        /^options\./,
      );
      expectProblem(
        await call(admin, 'POST', `/tables/${orders.id}/fields`, { name: 'f', type: 'formula' }),
        422,
        'VALIDATION_FAILED',
      );
      expectProblem(
        await call(admin, 'POST', `/tables/${orders.id}/fields`, { name: 'amount', type: 'text' }),
        409,
        'NAME_CONFLICT',
      );
    });

    it('P05: an editor sees the schema but cannot change it (403)', async () => {
      expectProblem(
        await call(editor, 'POST', `/tables/${orders.id}/fields`, { name: 'x', type: 'text' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(editor, 'PATCH', `/fields/${f.amount.id}`, { name: 'y' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(editor, 'DELETE', `/fields/${f.amount.id}`),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(editor, 'PATCH', `/tables/${orders.id}`, { name: 'z' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(await call(editor, 'DELETE', `/tables/${orders.id}`), 403, 'PERMISSION_DENIED');
      expectProblem(
        await call(editor, 'POST', `/bases/${baseId}/tables`, { name: 'Mine' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(editor, 'PUT', `/fields/${f.amount.id}`, { type: 'text' }),
        403,
        'PERMISSION_DENIED',
      );
      // Reading is fine.
      const list = fieldListSchema.parse(
        (await call(editor, 'GET', `/tables/${orders.id}/fields`)).json(),
      );
      expect(list.total).toBe(5);
    });

    it('renames fields, changes style and moves them; renaming an option keeps data', async () => {
      const renamed = await call(admin, 'PATCH', `/fields/${f.amount.id}`, {
        name: 'Amount',
        options: { style: { type: 'plain', precision: 2, thousands_separator: true } },
        position: 1,
      });
      expect(renamed.statusCode).toBe(200);
      f.amount = fieldSchema.parse(renamed.json());
      expect(f.amount).toMatchObject({ name: 'Amount', options: { style: { precision: 2 } } });
      expectProblem(
        await call(admin, 'PATCH', `/fields/${f.amount.id}`, { name: 'cost' }),
        409,
        'NAME_CONFLICT',
      );
      const [open, done] = f.status.options.options as { id: string; name: string }[];
      const recoloured = await call(admin, 'PATCH', `/fields/${f.status.id}`, {
        options: {
          options: [
            { id: done?.id, name: 'Hoàn thành', color: 5 },
            { id: open?.id, name: 'Mới' },
          ],
        },
      });
      expect(recoloured.statusCode).toBe(200);
      // Nothing removed: no job to follow.
      expect(updateFieldResponseSchema.parse(recoloured.json()).job_id).toBeNull();
      f.status = fieldSchema.parse(recoloured.json());
      expect(f.status.options.options).toEqual([
        { id: done?.id, name: 'Hoàn thành', color: 5 },
        { id: open?.id, name: 'Mới' },
      ]);
      const { rows: jobs } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM graphile_worker.jobs
         WHERE task_identifier = 'schema.remove_select_options'
      `.execute(db.kysely);
      expect(jobs).toEqual([{ n: 0 }]);
      // An option id the field does not have cannot be invented.
      const invented = await call(admin, 'PATCH', `/fields/${f.status.id}`, {
        options: { options: [{ id: newId('opt'), name: 'Ghost' }] },
      });
      expectProblem(invented, 422, 'VALIDATION_FAILED');
      expect(problemOf(invented.body).errors).toEqual([
        expect.objectContaining({ code: 'UNKNOWN_OPTION', path: 'options.options[0].id' }),
      ]);
      // PATCH never changes the type.
      expectProblem(
        await call(admin, 'PATCH', `/fields/${f.amount.id}`, { type: 'text' }),
        422,
        'VALIDATION_FAILED',
      );
    });

    it('refuses date ↔ date-time format changes through PATCH: they are conversions (PUT)', async () => {
      const toDateTime = await call(admin, 'PATCH', `/fields/${f.due.id}`, {
        options: { style: { format: 'dd/MM/yyyy HH:mm' } },
      });
      expectProblem(toDateTime, 422, 'CONVERSION_NOT_ALLOWED');
      const sameKind = await call(admin, 'PATCH', `/fields/${f.due.id}`, {
        options: { style: { format: 'dd/MM/yyyy' } },
      });
      expect(sameKind.statusCode).toBe(200);
      // A read-only target is never a conversion target (T403).
      expectProblem(
        await call(admin, 'PUT', `/fields/${f.amount.id}`, { type: 'created_at' }),
        422,
        'CONVERSION_NOT_ALLOWED',
      );
      expectProblem(
        await call(outsider, 'PUT', `/fields/${f.amount.id}`, { type: 'text' }),
        404,
        'NOT_FOUND',
      );
    });

    it('refuses to delete the primary field; deletes others softly', async () => {
      const primary = await call(admin, 'DELETE', `/fields/${orders.primary_field_id}`);
      expectProblem(primary, 422, 'VALIDATION_FAILED');
      expect(problemOf(primary.body).errors).toEqual([
        expect.objectContaining({ code: 'PRIMARY_FIELD_NOT_DELETABLE' }),
      ]);
      const extra = fieldSchema.parse(
        (
          await call(admin, 'POST', `/tables/${orders.id}/fields`, { name: 'extra', type: 'text' })
        ).json(),
      );
      const before = await permissionVersion();
      expect((await call(admin, 'DELETE', `/fields/${extra.id}`)).statusCode).toBe(204);
      expect(await permissionVersion()).toBe(before + 1n);
      expectProblem(await call(admin, 'GET', `/fields/${extra.id}`), 404, 'NOT_FOUND');
      const event = await db.kysely
        .selectFrom('meta.events')
        .select(['type', 'actor_id'])
        .where('entity_id', '=', extra.id)
        .where('type', '=', 'field.deleted')
        .executeTakeFirst();
      expect(event).toEqual({ type: 'field.deleted', actor_id: admin.id });
    });

    it('requires the CSRF token on schema mutations', async () => {
      const browser = await as(admin);
      const response = await browser.request({
        method: 'PATCH',
        url: `/api/v1/fields/${f.amount.id}`,
        payload: { name: 'No token' },
        csrf: false,
      });
      expectProblem(response, 403, 'CSRF_INVALID');
      const created = await browser.request({
        method: 'POST',
        url: `/api/v1/bases/${baseId}/tables`,
        payload: { name: 'No token' },
        csrf: false,
      });
      expectProblem(created, 403, 'CSRF_INVALID');
      expect(
        fieldSchema.parse((await call(admin, 'GET', `/fields/${f.amount.id}`)).json()).name,
      ).toBe('Amount');
    });
  });

  describe('custom roles', () => {
    beforeAll(async () => {
      await assignCustomRole(
        'Sales',
        {
          tables: {
            [orders.id]: {
              perm: 'edit',
              record_rule: {
                operations: ['add'],
                edit_filter: null,
                read_scope: 'all',
                read_filter: null,
              },
              field_rule: {
                mode: 'specify',
                fields: { [f.cost.id]: 'no_perm', [f.status.id]: 'read' },
                option_edit_fields: [],
                file_download_fields: [],
              },
            },
          },
        },
        sales.id,
      );
      await assignCustomRole(
        'Order managers',
        { tables: { [orders.id]: { perm: 'manage' } } },
        manager.id,
      );
    });

    it('hides no_perm tables and fields from lists and single reads', async () => {
      const tables = tableListSchema.parse(
        (await call(sales, 'GET', `/bases/${baseId}/tables`)).json(),
      );
      expect(tables.items.map((table) => table.id)).toEqual([orders.id]);
      expectProblem(await call(sales, 'GET', `/tables/${customers.id}`), 404, 'NOT_FOUND');
      expectProblem(await call(sales, 'GET', `/tables/${customers.id}/fields`), 404, 'NOT_FOUND');

      const fields = fieldListSchema.parse(
        (await call(sales, 'GET', `/tables/${orders.id}/fields`)).json(),
      );
      expect(fields.items.map((field) => field.name)).not.toContain('cost');
      expect(fields.total).toBe(4);
      expectProblem(await call(sales, 'GET', `/fields/${f.cost.id}`), 404, 'NOT_FOUND');
      // Hidden: 404 even for changes; visible without schema rights: 403.
      expectProblem(
        await call(sales, 'PATCH', `/fields/${f.cost.id}`, { name: 'c' }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call(sales, 'PATCH', `/fields/${f.amount.id}`, { name: 'c' }),
        403,
        'PERMISSION_DENIED',
      );
      const base = baseDetailSchema.parse((await call(sales, 'GET', `/bases/${baseId}`)).json());
      expect(Object.keys(base.access.tables)).toEqual([orders.id]);
      expect(Object.keys(base.access.tables[orders.id]?.fields ?? {})).not.toContain(f.cost.id);
    });

    it('lets a role with manage on a table change that table only', async () => {
      const created = await call(manager, 'POST', `/tables/${orders.id}/fields`, {
        name: 'note',
        type: 'text',
      });
      expect(created.statusCode).toBe(201);
      const note = fieldSchema.parse(created.json());
      expect(
        (await call(manager, 'PATCH', `/fields/${note.id}`, { description: 'Free text' }))
          .statusCode,
      ).toBe(200);
      expect((await call(manager, 'DELETE', `/fields/${note.id}`)).statusCode).toBe(204);
      expectProblem(
        await call(manager, 'POST', `/tables/${customers.id}/fields`, { name: 'x', type: 'text' }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call(manager, 'POST', `/bases/${baseId}/tables`, { name: 'Mine' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(manager, 'DELETE', `/tables/${orders.id}`),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('answers 404 to people without access to the base and to other organizations', async () => {
      for (const user of [outsider, stranger]) {
        expectProblem(await call(user, 'GET', `/bases/${baseId}/tables`), 404, 'NOT_FOUND');
        expectProblem(
          await call(user, 'POST', `/bases/${baseId}/tables`, { name: 'x' }),
          404,
          'NOT_FOUND',
        );
        expectProblem(await call(user, 'GET', `/tables/${orders.id}`), 404, 'NOT_FOUND');
        expectProblem(
          await call(user, 'PATCH', `/tables/${orders.id}`, { name: 'x' }),
          404,
          'NOT_FOUND',
        );
        expectProblem(await call(user, 'DELETE', `/tables/${orders.id}`), 404, 'NOT_FOUND');
        expectProblem(await call(user, 'GET', `/tables/${orders.id}/fields`), 404, 'NOT_FOUND');
        expectProblem(
          await call(user, 'POST', `/tables/${orders.id}/fields`, { name: 'x', type: 'text' }),
          404,
          'NOT_FOUND',
        );
        expectProblem(await call(user, 'GET', `/fields/${f.amount.id}`), 404, 'NOT_FOUND');
        expectProblem(
          await call(user, 'PATCH', `/fields/${f.amount.id}`, { name: 'x' }),
          404,
          'NOT_FOUND',
        );
        expectProblem(await call(user, 'DELETE', `/fields/${f.amount.id}`), 404, 'NOT_FOUND');
      }
    });
  });

  describe('deleting a select option', () => {
    it('removes the option from the records in a job, with record events and audit', async () => {
      const scope = orgScope(org);
      const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
      const records = new RecordMutationService(db, { schema });
      const [done, open] = f.status.options.options as { id: Id<'opt'>; name: string }[];
      const fields = fieldListSchema.parse(
        (await call(owner, 'GET', `/tables/${orders.id}/fields?limit=1000`)).json(),
      ).items;
      // Test fixture: full access, as the api resolves it for a base admin.
      const access: RecordAccessContext = {
        baseId,
        resolved: {
          access: {
            role: null,
            is_admin: true,
            base_rule: { copy: true, download: true, share_link: true },
            tables: {
              [orders.id]: {
                perm: 'manage',
                operations: ['add', 'delete'],
                view_rule: { allow_edit: true, visible_views: null },
                read_scope: 'all',
                fields: Object.fromEntries(fields.map((field) => [field.id, 'edit'])),
                option_edit_fields: [],
                file_download_fields: [],
              },
            },
            dashboards: {},
          },
          internal: { editFilters: { [orders.id]: null }, readFilters: { [orders.id]: null } },
        },
        userId: admin.id,
        groupMemberUserIds: [],
        timeZone: 'UTC',
        locale: 'en',
      };
      const requestId = newId('req');
      const created = await records.create(
        scope,
        orders.id,
        access,
        {
          field_key_type: 'id',
          records: [
            { fields: { [f.title.id]: 'r1', [f.status.id]: done?.name } },
            { fields: { [f.title.id]: 'r2', [f.status.id]: open?.name } },
            { fields: { [f.title.id]: 'r3' } },
          ],
        },
        {
          actor: { type: 'user', id: admin.id },
          via: null,
          batch_id: requestId,
          request_id: requestId,
          ip: null,
          user_agent: null,
        },
      );
      const [r1, r2] = created.records.map((record) => record.id);

      const patched = await call(admin, 'PATCH', `/fields/${f.status.id}`, {
        options: { options: [{ id: open?.id, name: open?.name }] },
      });
      expect(patched.statusCode).toBe(200);
      expect(fieldSchema.parse(patched.json()).options.options).toEqual([
        { id: open?.id, name: open?.name },
      ]);
      const { rows: queued } = await sql<{ payload: { batch_id: Id<'job'> } }>`
        SELECT payload
          FROM graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id)
         WHERE jobs.task_identifier = 'schema.remove_select_options'
      `.execute(db.kysely);
      expect(queued).toHaveLength(1);
      const batchId = queued[0]?.payload.batch_id as Id<'job'>;
      // The answer names the job, so the caller can follow it (CONTRACTS §13).
      expect(updateFieldResponseSchema.parse(patched.json()).job_id).toBe(batchId);

      const { logger } = captureLogger();
      worker = await createWorker(t.config, { logger, pollIntervalMs: 100 });
      await eventually(async () => {
        const { rows } = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM graphile_worker.jobs
           WHERE task_identifier = 'schema.remove_select_options'
        `.execute(db.kysely);
        return rows[0]?.n === 0;
      });
      // The caller follows the job with GET /jobs/:id (its meta.jobs row).
      await eventually(async () => {
        const followed = await call(admin, 'GET', `/jobs/${batchId}`);
        return (
          followed.statusCode === 200 && followed.json<{ status: string }>().status === 'succeeded'
        );
      });
      const followed = (await call(admin, 'GET', `/jobs/${batchId}`)).json<{
        type: string;
        result: unknown;
      }>();
      expect(followed).toMatchObject({
        type: 'schema.remove_select_options',
        result: { updated: expect.any(Number) as unknown },
      });

      const column = (
        await db.kysely
          .selectFrom('meta.fields')
          .select('db_column_name')
          .where('id', '=', f.status.id)
          .executeTakeFirstOrThrow()
      ).db_column_name as string;
      const table = await db.kysely
        .selectFrom('meta.tables')
        .select('db_table_name')
        .where('id', '=', orders.id)
        .executeTakeFirstOrThrow();
      // Test-only read of the physical table; identifiers come from meta.
      const { rows } = await sql<{ id: string; value: string[] | null; version: number }>`
        SELECT __id AS id, ${sql.id(column)} AS value, __version AS version
          FROM ${sql.id('data', table.db_table_name)} ORDER BY __auto
      `.execute(db.kysely);
      expect(rows.map((row) => [row.id, row.value, row.version])).toEqual([
        [r1, null, 2],
        [r2, [open?.id], 1],
        [created.records[2]?.id, null, 1],
      ]);
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .selectAll()
        .where('batch_id', '=', batchId)
        .execute();
      expect(audit).toEqual([
        expect.objectContaining({
          action: 'record.updated',
          entity_id: r1,
          actor_type: 'system',
          before: { [f.status.id]: [done?.id] },
          after: { [f.status.id]: null },
        }),
      ]);
      const events = await db.kysely
        .selectFrom('meta.events')
        .select(['type', 'actor_type', 'payload'])
        .where('entity_id', '=', r1 as string)
        .where('type', '=', 'record.updated')
        .execute();
      expect(events).toEqual([
        expect.objectContaining({
          actor_type: 'system',
          payload: expect.objectContaining({
            changes: { [f.status.id]: { from: [done?.id], to: null } },
          }) as unknown,
        }),
      ]);
    });
  });
});
