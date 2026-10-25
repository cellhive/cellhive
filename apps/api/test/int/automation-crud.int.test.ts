import {
  automationListSchema,
  automationSchema,
  baseDetailSchema,
  fieldSchema,
  problemDetailsSchema,
  roleListSchema,
  roleWithAdjustmentsSchema,
  tableSchema,
  viewListSchema,
  viewSchema,
  workspaceSchema,
  type AutomationDto,
  type FieldDto,
  type Id,
  type RoleDto,
  type TableDto,
} from '@cellhive/contracts';
import { GroupMembersRepository, GroupsRepository, orgScope, type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * T502: automation management (SPEC §11, CONTRACTS §21, ADR-25) — CRUD,
 * enable/disable, take over, `If-Match`/`version`, `404`/`403` by who sees
 * what, P31 and P32 (CONTRACTS §5, fixture variant: Sales has `manage` on
 * Orders), validation with the caller's own permissions, events + audit,
 * tenant isolation.
 */
describe('automations (T502)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let org: Id<'org'>;
  let otherOrg: Id<'org'>;
  let owner: SeededUser;
  let admin: SeededUser;
  let editor: SeededUser;
  let reader: SeededUser;
  let sales1: SeededUser;
  let outsider: SeededUser;
  let stranger: SeededUser;
  const browsers = new Map<string, Browser>();
  let baseId: Id<'bse'>;
  let otherBaseId: Id<'bse'>;
  let orders: TableDto;
  let customers: TableDto;
  const f = {} as Record<'title' | 'amount' | 'cost' | 'status' | 'owner' | 'name', FieldDto>;
  let viewSales: Id<'viw'>;
  let form: Id<'viw'>;

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
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    return (await as(user)).request({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
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

  function ok(response: LightMyRequestResponse, status = 200): AutomationDto {
    expect(response.statusCode, response.body).toBe(status);
    return automationSchema.parse(response.json());
  }

  const onOrders = () => ({ type: 'record.created', table_id: orders.id });
  const setAmount = (id = 'act_1', table = orders.id, field = f.amount.id) => ({
    id,
    type: 'update_record',
    config: { table_id: table, fields: { [field]: { literal: 1 } } },
  });

  async function createAs(user: SeededUser, body: object = {}): Promise<AutomationDto> {
    return ok(
      await call(user, 'POST', `/bases/${baseId}/automations`, {
        name: 'Set amount',
        definition: { trigger: onOrders(), actions: [setAmount()] },
        ...body,
      }),
      201,
    );
  }

  async function auditOf(id: Id<'aut'>) {
    const { rows } = await sql<{
      action: string;
      actor_id: string;
      before: unknown;
      after: unknown;
    }>`
      SELECT action, actor_id, before, after FROM meta.audit_logs
       WHERE entity_type = 'automation' AND entity_id = ${id}
       ORDER BY created_at, action
    `.execute(db.kysely);
    return rows;
  }

  async function eventsOf(id: Id<'aut'>): Promise<string[]> {
    const { rows } = await sql<{ type: string }>`
      SELECT type FROM meta.events WHERE entity_id = ${id} ORDER BY created_at, type
    `.execute(db.kysely);
    return rows.map((row) => row.type);
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    org = await seedOrg(db, 'Alpha');
    otherOrg = await seedOrg(db, 'Other');
    const member = (role: 'owner' | 'member') => ({ memberships: [{ orgId: org, role }] });
    owner = await seedUser(db, member('owner'));
    admin = await seedUser(db, { ...member('member'), displayName: 'Admin' });
    editor = await seedUser(db, member('member'));
    reader = await seedUser(db, member('member'));
    sales1 = await seedUser(db, { ...member('member'), displayName: 'Sales One' });
    outsider = await seedUser(db, member('member'));
    stranger = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] });
    const salesGroup = (await new GroupsRepository(db).create(orgScope(org), { name: 'Sales' })).id;
    await new GroupMembersRepository(db).add(orgScope(org), salesGroup, sales1.id);

    const workspace = workspaceSchema.parse(
      (await call(owner, 'POST', `/orgs/${org}/workspaces`, { name: 'Main' })).json(),
    );
    baseId = baseDetailSchema.parse(
      (await call(owner, 'POST', `/workspaces/${workspace.id}/bases`, { name: 'CRM' })).json(),
    ).id;
    otherBaseId = baseDetailSchema.parse(
      (await call(owner, 'POST', `/workspaces/${workspace.id}/bases`, { name: 'Ops' })).json(),
    ).id;
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
    const field = async (table: TableDto, body: object) => {
      const response = await call(owner, 'POST', `/tables/${table.id}/fields`, body);
      expect(response.statusCode).toBe(201);
      return fieldSchema.parse(response.json());
    };
    f.amount = await field(orders, { name: 'amount', type: 'number' });
    f.cost = await field(orders, { name: 'cost', type: 'number' });
    f.status = await field(orders, {
      name: 'status',
      type: 'select',
      options: { options: [{ name: 'Mới' }, { name: 'Xong' }] },
    });
    f.owner = await field(orders, { name: 'owner', type: 'user' });
    f.title = fieldSchema.parse(
      (await call(owner, 'GET', `/fields/${orders.primary_field_id}`)).json(),
    );
    f.name = fieldSchema.parse(
      (await call(owner, 'GET', `/fields/${customers.primary_field_id}`)).json(),
    );
    viewSales = viewSchema.parse(
      (
        await call(owner, 'POST', `/tables/${orders.id}/views`, { name: 'Sales', type: 'grid' })
      ).json(),
    ).id;
    form = viewSchema.parse(
      (
        await call(owner, 'POST', `/tables/${orders.id}/views`, {
          name: 'Order form',
          type: 'form',
        })
      ).json(),
    ).id;
    expect(
      viewListSchema.parse((await call(owner, 'GET', `/tables/${orders.id}/views`)).json()).total,
    ).toBe(3);

    const roles = roleListSchema.parse((await call(owner, 'GET', `/bases/${baseId}/roles`)).json());
    const system = Object.fromEntries(roles.items.map((role) => [role.kind, role])) as Record<
      string,
      RoleDto
    >;
    // CONTRACTS §5 role Sales, variant of P29/P32/P33: `manage` on Orders.
    const sales = roleWithAdjustmentsSchema.parse(
      (
        await call(owner, 'POST', `/bases/${baseId}/roles`, {
          name: 'Sales',
          config: {
            base_rule: { copy: false, download: false, share_link: false },
            tables: {
              [orders.id]: {
                perm: 'manage',
                view_rule: { allow_edit: false, visible_views: [viewSales] },
                record_rule: {
                  operations: ['add'],
                  edit_filter: {
                    op: 'and',
                    items: [
                      {
                        field: f.owner.id,
                        operator: 'has_any_of',
                        value: [{ $var: 'current_user' }],
                      },
                    ],
                  },
                  read_scope: 'editable',
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
            dashboards: {},
          },
        })
      ).json(),
    );
    for (const [principal_type, principal_id, role_id] of [
      ['user', admin.id, system['system_admin']?.id],
      ['user', editor.id, system['system_editor']?.id],
      ['user', reader.id, system['system_reader']?.id],
      ['group', salesGroup, sales.id],
    ] as const) {
      const assigned = await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
        principal_type,
        principal_id,
        role_id,
      });
      expect(assigned.statusCode).toBe(200);
    }
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('create and read', () => {
    it('creates off, with run_as = creator, events and audit', async () => {
      const created = await createAs(admin, { description: 'Demo' });
      expect(created).toMatchObject({
        base_id: baseId,
        name: 'Set amount',
        description: 'Demo',
        enabled: false,
        disabled_reason: null,
        version: 1,
        run_as: { id: admin.id, name: 'Admin' },
        created_by: { id: admin.id, name: 'Admin' },
        definition: {
          trigger: { type: 'record.created', table_id: orders.id, skip_bulk: false },
          condition: null,
          actions: [setAmount()],
        },
      });
      expect(await eventsOf(created.id)).toEqual([
        'automation.created',
        'automation.run_as_changed',
      ]);
      const audit = await auditOf(created.id);
      expect(audit.map((row) => row.action)).toEqual([
        'automation.created',
        'automation.run_as_changed',
      ]);
      expect(audit[1]).toMatchObject({
        actor_id: admin.id,
        before: null,
        after: { run_as_user_id: admin.id, reason: 'created' },
      });
      expect(ok(await call(admin, 'GET', `/automations/${created.id}`))).toEqual(created);
    });

    it('creates on when asked, which needs an action', async () => {
      const on = await createAs(admin, { enabled: true });
      expect(on.enabled).toBe(true);
      expect(await eventsOf(on.id)).toEqual([
        'automation.created',
        'automation.enabled',
        'automation.run_as_changed',
      ]);
      expectProblem(
        await call(admin, 'POST', `/bases/${baseId}/automations`, {
          name: 'Empty',
          enabled: true,
          definition: { trigger: onOrders() },
        }),
        422,
        'AUTOMATION_INVALID',
        { path: 'definition.actions', code: 'NO_ACTIONS' },
      );
    });

    it('rejects 21 actions, if branches included (TOO_MANY_ACTIONS)', async () => {
      const delays = (from: number, count: number) =>
        Array.from({ length: count }, (_, i) => ({
          id: `act_${String(from + i)}`,
          type: 'delay',
          config: { minutes: 1 },
        }));
      expectProblem(
        await call(admin, 'POST', `/bases/${baseId}/automations`, {
          name: 'Too many',
          definition: {
            trigger: onOrders(),
            actions: [
              ...delays(1, 10),
              {
                id: 'act_if',
                type: 'if',
                config: {
                  conditions: [{ filter: { field: f.title.id, operator: 'is_empty' } }],
                  then: delays(20, 10),
                },
              },
            ],
          },
        }),
        422,
        'AUTOMATION_INVALID',
        { path: 'definition.actions', code: 'TOO_MANY_ACTIONS' },
      );
    });

    it('answers VALIDATION_FAILED for a malformed definition', async () => {
      expectProblem(
        await call(admin, 'POST', `/bases/${baseId}/automations`, {
          name: 'Bad',
          definition: { trigger: { type: 'webhook.received' } },
        }),
        422,
        'VALIDATION_FAILED',
      );
    });

    it('honours Idempotency-Key on create', async () => {
      const body = { name: 'Once', definition: { trigger: onOrders(), actions: [setAmount()] } };
      const headers = { 'idempotency-key': 'create-automation-once' };
      const first = await call(admin, 'POST', `/bases/${baseId}/automations`, body, headers);
      const again = await call(admin, 'POST', `/bases/${baseId}/automations`, body, headers);
      expect(first.statusCode).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(automationSchema.parse(again.json()).id).toBe(automationSchema.parse(first.json()).id);
    });

    it('validates a form trigger against views the saver sees', async () => {
      const created = await createAs(admin, {
        definition: { trigger: { type: 'form.submitted', view_id: form }, actions: [] },
      });
      expect(created.definition.trigger).toEqual({ type: 'form.submitted', view_id: form });
      // The form is outside Sales' visible_views.
      expectProblem(
        await call(sales1, 'POST', `/bases/${baseId}/automations`, {
          name: 'Form',
          definition: { trigger: { type: 'form.submitted', view_id: form } },
        }),
        422,
        'AUTOMATION_INVALID',
        { path: 'definition.trigger.view_id', code: 'UNKNOWN_VIEW' },
      );
    });
  });

  describe('who manages automations (404 / 403, P31)', () => {
    it('P31: an editor neither reads, changes, enables nor creates automations', async () => {
      const automation = await createAs(admin);
      for (const [method, url, body] of [
        ['GET', `/automations/${automation.id}`, undefined],
        ['PATCH', `/automations/${automation.id}`, { name: 'x' }],
        ['POST', `/automations/${automation.id}/enable`, undefined],
        ['POST', `/automations/${automation.id}/disable`, undefined],
        ['POST', `/automations/${automation.id}/take-over`, { enable: true }],
        ['DELETE', `/automations/${automation.id}`, undefined],
        ['GET', `/bases/${baseId}/automations`, undefined],
        [
          'POST',
          `/bases/${baseId}/automations`,
          { name: 'x', definition: { trigger: onOrders() } },
        ],
      ] as const) {
        expectProblem(await call(editor, method, url, body), 403, 'PERMISSION_DENIED');
        expectProblem(await call(reader, method, url, body), 403, 'PERMISSION_DENIED');
        expectProblem(await call(outsider, method, url, body), 404, 'NOT_FOUND');
        expectProblem(await call(stranger, method, url, body), 404, 'NOT_FOUND');
      }
      expect(ok(await call(admin, 'GET', `/automations/${automation.id}`))).toMatchObject({
        version: 1,
        enabled: false,
      });
    });

    it('a manager of Orders sees only automations triggered on Orders', async () => {
      const onOrdersAutomation = await createAs(admin, { name: 'On orders' });
      const onCustomers = await createAs(admin, {
        name: 'On customers',
        definition: { trigger: { type: 'record.created', table_id: customers.id } },
      });
      const onSchedule = await createAs(admin, {
        name: 'Daily',
        definition: { trigger: { type: 'schedule', cron: '0 8 * * *' } },
      });
      const listed = await call(sales1, 'GET', `/bases/${baseId}/automations?limit=1000`);
      expect(listed.statusCode, listed.body).toBe(200);
      const list = automationListSchema.parse(listed.json());
      expect(list.items.map((item) => item.id)).toContain(onOrdersAutomation.id);
      expect(list.items.every((item) => item.definition.trigger.type !== 'schedule')).toBe(true);
      expect(list.items.map((item) => item.id)).not.toContain(onCustomers.id);
      const all = automationListSchema.parse(
        (await call(admin, 'GET', `/bases/${baseId}/automations?limit=1000`)).json(),
      );
      expect(all.total).toBe(list.total + 2);
      expect(
        automationListSchema
          .parse(
            (
              await call(admin, 'GET', `/bases/${baseId}/automations?table_id=${customers.id}`)
            ).json(),
          )
          .items.map((item) => item.id),
      ).toEqual([onCustomers.id]);
      // Hidden trigger table → 404; schedule (base admins only) → 403.
      expectProblem(await call(sales1, 'GET', `/automations/${onCustomers.id}`), 404, 'NOT_FOUND');
      expectProblem(
        await call(sales1, 'GET', `/automations/${onSchedule.id}`),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(sales1, 'POST', `/bases/${baseId}/automations`, {
          name: 'Daily',
          definition: { trigger: { type: 'schedule', cron: '0 8 * * *' } },
        }),
        403,
        'PERMISSION_DENIED',
      );
      // Another base of the organization lists none of them; admin of CRM only → 404 there.
      expectProblem(
        await call(admin, 'GET', `/bases/${otherBaseId}/automations`),
        404,
        'NOT_FOUND',
      );
      expect(
        automationListSchema.parse(
          (await call(owner, 'GET', `/bases/${otherBaseId}/automations`)).json(),
        ).total,
      ).toBe(0);
    });
  });

  describe('run_as (ADR-25, P32)', () => {
    it('P32: out of scope → 422 and run_as stays; in scope → run_as moves with audit', async () => {
      const automation = await createAs(admin);
      const edit = (definition: object, version?: number) =>
        call(sales1, 'PATCH', `/automations/${automation.id}`, {
          definition,
          ...(version === undefined ? {} : { version }),
        });
      const lookup = {
        id: 'act_0',
        type: 'find_records',
        config: { table_id: orders.id, fields: [f.title.id] },
      };
      expectProblem(
        await edit({
          trigger: onOrders(),
          actions: [
            lookup,
            {
              id: 'act_1',
              type: 'update_record',
              config: {
                table_id: customers.id,
                record_id: { step: 'act_0', path: 'records[0].id' },
                fields: { [f.name.id]: { literal: 'x' } },
              },
            },
          ],
        }),
        422,
        'AUTOMATION_INVALID',
        { path: 'definition.actions[1].config.table_id', code: 'UNKNOWN_TABLE' },
      );
      expectProblem(
        await edit({ trigger: onOrders(), actions: [setAmount('act_1', orders.id, f.cost.id)] }),
        422,
        'AUTOMATION_INVALID',
        { path: `definition.actions[0].config.fields.${f.cost.id}`, code: 'UNKNOWN_FIELD' },
      );
      expectProblem(
        await edit({ trigger: onOrders(), actions: [setAmount('act_1', orders.id, f.status.id)] }),
        422,
        'AUTOMATION_INVALID',
        { path: `definition.actions[0].config.fields.${f.status.id}`, code: 'PERMISSION_DENIED' },
      );
      // The problem never names the hidden table or field.
      const hidden = await edit({
        trigger: onOrders(),
        actions: [setAmount('act_1', orders.id, f.cost.id)],
      });
      expect(hidden.body).not.toContain('cost');
      expect(ok(await call(admin, 'GET', `/automations/${automation.id}`))).toMatchObject({
        version: 1,
        run_as: { id: admin.id },
      });

      // Renaming keeps run_as.
      const renamed = ok(
        await call(sales1, 'PATCH', `/automations/${automation.id}`, { name: 'Renamed' }),
      );
      expect(renamed).toMatchObject({ name: 'Renamed', version: 2, run_as: { id: admin.id } });
      // Sending the same definition again is no change either.
      const same = ok(
        await call(sales1, 'PATCH', `/automations/${automation.id}`, {
          definition: automation.definition,
          description: 'Same',
        }),
      );
      expect(same).toMatchObject({ version: 3, run_as: { id: admin.id } });

      const moved = ok(
        await edit(
          { trigger: onOrders(), actions: [setAmount('act_1', orders.id, f.title.id)] },
          3,
        ),
      );
      expect(moved).toMatchObject({ version: 4, run_as: { id: sales1.id, name: 'Sales One' } });
      expect(Date.parse(moved.run_as_since)).toBeGreaterThanOrEqual(
        Date.parse(renamed.run_as_since),
      );
      const audit = await auditOf(automation.id);
      expect(audit.at(-2)).toMatchObject({
        action: 'automation.run_as_changed',
        actor_id: sales1.id,
        before: { run_as_user_id: admin.id },
        after: { run_as_user_id: sales1.id, reason: 'edited' },
      });
      expect(audit.at(-1)).toMatchObject({ action: 'automation.updated', actor_id: sales1.id });
    });

    it('enable, disable and take over move run_as only as ADR-25 §2 says', async () => {
      const automation = await createAs(admin);
      const enabled = ok(await call(sales1, 'POST', `/automations/${automation.id}/enable`));
      expect(enabled).toMatchObject({ enabled: true, version: 2, run_as: { id: sales1.id } });
      // Already on with the same run_as: nothing changes.
      expect(ok(await call(sales1, 'POST', `/automations/${automation.id}/enable`)).version).toBe(
        2,
      );
      const disabled = ok(await call(admin, 'POST', `/automations/${automation.id}/disable`));
      expect(disabled).toMatchObject({
        enabled: false,
        disabled_reason: null,
        run_as: { id: sales1.id },
      });
      expect(ok(await call(admin, 'POST', `/automations/${automation.id}/disable`)).version).toBe(
        3,
      );

      const taken = ok(
        await call(admin, 'POST', `/automations/${automation.id}/take-over`, { enable: false }),
      );
      expect(taken).toMatchObject({ enabled: false, version: 4, run_as: { id: admin.id } });
      const back = ok(
        await call(sales1, 'POST', `/automations/${automation.id}/take-over`, { enable: true }),
      );
      expect(back).toMatchObject({ enabled: true, version: 5, run_as: { id: sales1.id } });
      // One transaction per call; inside one, rows share `created_at` (sorted by name).
      expect(await eventsOf(automation.id)).toEqual([
        'automation.created',
        'automation.run_as_changed',
        'automation.enabled',
        'automation.run_as_changed',
        'automation.disabled',
        'automation.run_as_changed',
        'automation.enabled',
        'automation.run_as_changed',
      ]);
      const reasons = (await auditOf(automation.id))
        .filter((row) => row.action === 'automation.run_as_changed')
        .map((row) => (row.after as { reason: string }).reason);
      expect(reasons).toEqual(['created', 'enabled', 'taken_over', 'taken_over']);
    });

    it('take over clears run_as_lost_access but keeps circuit_breaker', async () => {
      const lost = await createAs(admin);
      const breaker = await createAs(admin);
      await sql`
        UPDATE meta.automations
           SET disabled_reason = CASE id WHEN ${lost.id} THEN 'run_as_lost_access'
                                         ELSE 'circuit_breaker' END
         WHERE id IN (${lost.id}, ${breaker.id})
      `.execute(db.kysely);
      // Same run_as, not enabling: only the lost-access reason is cleared.
      expect(
        ok(await call(admin, 'POST', `/automations/${lost.id}/take-over`, { enable: false })),
      ).toMatchObject({ enabled: false, disabled_reason: null, version: 2 });
      expect(
        ok(await call(admin, 'POST', `/automations/${breaker.id}/take-over`, { enable: false })),
      ).toMatchObject({ enabled: false, disabled_reason: 'circuit_breaker', version: 1 });
      expect(
        ok(await call(sales1, 'POST', `/automations/${breaker.id}/take-over`, { enable: false })),
      ).toMatchObject({ disabled_reason: 'circuit_breaker', run_as: { id: sales1.id } });
      expect(
        ok(await call(sales1, 'POST', `/automations/${breaker.id}/take-over`, { enable: true })),
      ).toMatchObject({ enabled: true, disabled_reason: null });
    });

    it('enable and take over validate the stored definition with the caller’s access', async () => {
      const automation = await createAs(admin, {
        definition: {
          trigger: onOrders(),
          actions: [setAmount('act_1', orders.id, f.cost.id)],
        },
      });
      expectProblem(
        await call(sales1, 'POST', `/automations/${automation.id}/enable`),
        422,
        'AUTOMATION_INVALID',
        { code: 'UNKNOWN_FIELD' },
      );
      expectProblem(
        await call(sales1, 'POST', `/automations/${automation.id}/take-over`, { enable: false }),
        422,
        'AUTOMATION_INVALID',
        { code: 'UNKNOWN_FIELD' },
      );
      // Disabling needs no validation and keeps run_as.
      ok(await call(admin, 'POST', `/automations/${automation.id}/enable`));
      expect(ok(await call(sales1, 'POST', `/automations/${automation.id}/disable`))).toMatchObject(
        {
          enabled: false,
          run_as: { id: admin.id },
        },
      );
    });
  });

  describe('versions (409) and delete', () => {
    it('rejects a stale version from the body or If-Match', async () => {
      const automation = await createAs(admin);
      ok(await call(admin, 'PATCH', `/automations/${automation.id}`, { name: 'v2', version: 1 }));
      const stale = await call(admin, 'PATCH', `/automations/${automation.id}`, {
        name: 'v3',
        version: 1,
      });
      expectProblem(stale, 409, 'VERSION_CONFLICT', { path: 'version', code: 'VERSION_CONFLICT' });
      const [conflict] = problemDetailsSchema.parse(stale.json()).errors ?? [];
      expect(conflict?.params).toMatchObject({
        current_version: 2,
        version: 1,
        updated_by: { id: admin.id, name: 'Admin' },
      });
      for (const [method, url, body] of [
        ['PATCH', `/automations/${automation.id}`, { name: 'v3' }],
        ['POST', `/automations/${automation.id}/enable`, undefined],
        ['POST', `/automations/${automation.id}/disable`, undefined],
        ['POST', `/automations/${automation.id}/take-over`, { enable: true }],
        ['DELETE', `/automations/${automation.id}`, undefined],
      ] as const) {
        expectProblem(
          await call(admin, method, url, body, { 'if-match': '"1"' }),
          409,
          'VERSION_CONFLICT',
        );
      }
      expectProblem(
        await call(
          admin,
          'PATCH',
          `/automations/${automation.id}`,
          { name: 'x' },
          { 'if-match': '*' },
        ),
        422,
        'VALIDATION_FAILED',
      );
      expect(
        ok(
          await call(
            admin,
            'PATCH',
            `/automations/${automation.id}`,
            { name: 'v3' },
            { 'if-match': '"2"' },
          ),
        ).version,
      ).toBe(3);
    });

    it('soft-deletes: 204, then 404 everywhere, event and audit', async () => {
      const automation = await createAs(admin, { enabled: true });
      const deleted = await call(sales1, 'DELETE', `/automations/${automation.id}`);
      expect(deleted.statusCode).toBe(204);
      expectProblem(await call(admin, 'GET', `/automations/${automation.id}`), 404, 'NOT_FOUND');
      expectProblem(
        await call(admin, 'POST', `/automations/${automation.id}/enable`),
        404,
        'NOT_FOUND',
      );
      const { rows } = await sql<{ enabled: boolean; deleted: boolean }>`
        SELECT enabled, deleted_at IS NOT NULL AS deleted FROM meta.automations WHERE id = ${automation.id}
      `.execute(db.kysely);
      expect(rows).toEqual([{ enabled: false, deleted: true }]);
      expect((await eventsOf(automation.id)).at(-1)).toBe('automation.deleted');
      expect(
        automationListSchema
          .parse((await call(admin, 'GET', `/bases/${baseId}/automations?limit=1000`)).json())
          .items.map((item) => item.id),
      ).not.toContain(automation.id);
    });
  });
});
