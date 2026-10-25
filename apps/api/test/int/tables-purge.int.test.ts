import {
  createdShareLinkSchema,
  fieldListSchema,
  purgedTableResponseSchema,
  fieldSchema,
  recordsResponseSchema,
  trashedTableListSchema,
  type Id,
} from '@cellhive/contracts';
import {
  orgScope,
  SchemaService,
  systemAuditContext,
  ViewsRepository,
  type Db,
  type FieldRow,
  type TableRow,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

/**
 * T461: permanent delete of a table from the trash over HTTP (CONTRACTS
 * §13): base admins only (403 for who sees the live table, 404 otherwise),
 * only a trashed table (422), confirmed by name (422), other organizations
 * 404; the data table and junctions are dropped, link fields of other tables
 * (one-way and the reverse field of a two-way link) go to the trash for good
 * (`LINK_TABLE_PURGED`), share links of its views answer 410, one
 * `table.purged` audit entry; a second call is 404.
 */
describe('permanent delete of a table (T461)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let lines: TableRow;
  /** Orders → Customers, one-way. */
  let orderCustomer: FieldRow;
  /** Chi tiết đơn hàng ↔ Customers, two-way (this side points at Customers). */
  let lineCustomer: FieldRow;
  let shareToken: string;
  let order: Id<'rec'>;
  /** Orders: a formula reading Customers through `customer` (T469 trash listing). */
  let customerNames: Id<'fld'>;

  const purge = (user: Parameters<RecordFixture['call']>[0], body: unknown) =>
    fx.call(user, 'POST', `/tables/${fx.customers.id}/purge`, body);
  const trash = (user: Parameters<RecordFixture['call']>[0]) =>
    fx.call(user, 'GET', `/bases/${fx.baseId}/tables/trash`);

  async function exists(name: string): Promise<boolean> {
    const { rows } = await sql<{ oid: string | null }>`
      SELECT to_regclass(${`data.${name}`})::text AS oid
    `.execute(db.kysely);
    return rows[0]?.oid != null;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    const schema = t.app.get(SchemaService);
    const scope = orgScope(fx.orgId);
    const context = systemAuditContext();
    orderCustomer = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'customer', type: 'link', options: { link_table: fx.customers.id } },
      context,
    );
    ({ table: lines } = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Chi tiết đơn hàng', primaryFieldName: 'Tên' },
      context,
    ));
    lineCustomer = await schema.addField(
      scope,
      lines.id,
      {
        name: 'Khách hàng',
        type: 'link',
        options: {
          link_table: fx.customers.id,
          bidirectional: true,
          bidirectional_link_field_name: 'Chi tiết',
        },
      },
      context,
    );

    const formula = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'Tên khách',
      type: 'formula',
      options: { expression: '[customer].[Tên].ARRAYJOIN()' },
    });
    expect(formula.statusCode, formula.body).toBe(201);
    customerNames = fieldSchema.parse(formula.json()).id;

    const created = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.customers.id}/records?field_key_type=id`,
      { records: [{ fields: { [fx.fld.customerName?.id ?? '']: 'ACME' } }] },
    );
    expect(created.statusCode, created.body).toBe(201);
    const [customer] = recordsResponseSchema.parse(created.json()).records;
    const ordered = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: [
          {
            fields: {
              [fx.fld.title?.id ?? '']: 'Order 1',
              [orderCustomer.id]: [customer?.id],
            },
          },
        ],
      },
    );
    expect(ordered.statusCode, ordered.body).toBe(201);
    order = recordsResponseSchema.parse(ordered.json()).records[0]?.id as Id<'rec'>;

    const [view] = await new ViewsRepository(db).listByTable(scope, fx.customers.id, null);
    const link = await fx.call('owner', 'POST', `/views/${view?.id ?? ''}/share-links`, {});
    expect(link.statusCode, link.body).toBe(201);
    shareToken = createdShareLinkSchema.parse(link.json()).token;
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('checks the caller, the trash and the confirmation first', async () => {
    const confirm = { confirm_name: 'Customers' };
    // Live table: who sees it without being base admin gets 403, admins 422.
    expectProblem(await purge('u_editor', confirm), 403, 'PERMISSION_DENIED');
    const live = await purge('u_admin', confirm);
    expectProblem(live, 422, 'VALIDATION_FAILED');
    expect(problemOf(live.body)).toMatchObject({ errors: [{ code: 'TABLE_NOT_IN_TRASH' }] });

    expect((await fx.call('owner', 'DELETE', `/tables/${fx.customers.id}`)).statusCode).toBe(204);
    // Trashed tables are visible to base admins only.
    expectProblem(await purge('u_editor', confirm), 404, 'NOT_FOUND');
    expectProblem(await purge('u_sales1', confirm), 404, 'NOT_FOUND');
    expectProblem(await purge('stranger', confirm), 404, 'NOT_FOUND');
    const wrong = await purge('u_admin', { confirm_name: 'customers' });
    expectProblem(wrong, 422, 'VALIDATION_FAILED');
    expect(problemOf(wrong.body)).toMatchObject({
      errors: [{ path: 'confirm_name', code: 'CONFIRM_NAME_MISMATCH' }],
    });
    expectProblem(await purge('u_admin', {}), 422, 'VALIDATION_FAILED');
    expectProblem(
      await fx.call('u_admin', 'POST', '/tables/not-an-id/purge', confirm),
      422,
      'VALIDATION_FAILED',
    );
    // Nothing was dropped by the refused calls.
    expect(await exists(fx.customers.db_table_name)).toBe(true);
  });

  it('lists the base trash for base admins with what a purge takes along (T469)', async () => {
    // The first test moved Customers to the trash.
    expectProblem(await trash('u_editor'), 403, 'PERMISSION_DENIED');
    expectProblem(await trash('u_sales1'), 403, 'PERMISSION_DENIED');
    expectProblem(await trash('stranger'), 404, 'NOT_FOUND');
    const response = await trash('u_admin');
    expect(response.statusCode, response.body).toBe(200);
    const { items } = trashedTableListSchema.parse(response.json());
    expect(items.map((item) => item.id)).toEqual([fx.customers.id]);
    const [item] = items;
    expect(item).toMatchObject({
      name: 'Customers',
      deleted_by: { id: fx.users.owner.id },
      computed_fields: [
        { id: customerNames, table_id: fx.orders.id, name: 'Tên khách', type: 'formula' },
      ],
    });
    expect(item?.field_count).toBeGreaterThanOrEqual(2);
    expect(Date.parse(item?.purge_after ?? '') - Date.parse(item?.deleted_at ?? '')).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
    expect([...(item?.partner_fields ?? [])].sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual(
      [
        {
          id: orderCustomer.id,
          table_id: fx.orders.id,
          name: 'customer',
          kind: 'one_way',
          in_trash: false,
        },
        {
          id: lineCustomer.id,
          table_id: lines.id,
          name: 'Khách hàng',
          kind: 'two_way',
          in_trash: false,
        },
      ].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
  });

  it('purges the table and the link fields of other tables pointing at it', async () => {
    const response = await purge('owner', { confirm_name: 'Customers' });
    expect(response.statusCode, response.body).toBe(200);
    const body = purgedTableResponseSchema.parse(response.json());
    expect(body).toMatchObject({ id: fx.customers.id, name: 'Customers', record_count: 1 });
    expect([...body.partner_field_ids].sort()).toEqual([orderCustomer.id, lineCustomer.id].sort());

    expect(await exists(fx.customers.db_table_name)).toBe(false);
    expect(await exists(orderCustomer.link_junction ?? '')).toBe(false);
    expect(await exists(lineCustomer.link_junction ?? '')).toBe(false);

    // Gone for good: no restore, no second purge.
    expectProblem(
      await fx.call('owner', 'POST', `/tables/${fx.customers.id}/restore`),
      404,
      'NOT_FOUND',
    );
    expectProblem(await purge('owner', { confirm_name: 'Customers' }), 404, 'NOT_FOUND');
    expect(trashedTableListSchema.parse((await trash('u_admin')).json()).items).toEqual([]);

    // Link fields of Orders and Chi tiết đơn hàng: in the trash, not restorable.
    for (const [table, field] of [
      [fx.orders.id, orderCustomer.id],
      [lines.id, lineCustomer.id],
    ] as const) {
      const listed = fieldListSchema.parse(
        (await fx.call('u_admin', 'GET', `/tables/${table}/fields?include_deleted=true`)).json(),
      );
      expect(listed.items.find((item) => item.id === field)).toMatchObject({
        link_table_purged: true,
        deleted_at: expect.any(String) as unknown,
      });
      const restore = await fx.call('u_admin', 'POST', `/fields/${field}/restore`);
      expectProblem(restore, 422, 'VALIDATION_FAILED');
      expect(problemOf(restore.body)).toMatchObject({ errors: [{ code: 'LINK_TABLE_PURGED' }] });
      const live = fieldListSchema.parse(
        (await fx.call('u_admin', 'GET', `/tables/${table}/fields`)).json(),
      );
      expect(live.items.map((item) => item.id)).not.toContain(field);
    }

    // Orders keep their records; the share link of a Customers view is gone.
    const got = await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/records/${order}`);
    expect(got.statusCode, got.body).toBe(200);
    const shared = await new Browser(t.app).request({
      method: 'GET',
      url: `/api/v1/shares/${shareToken}/meta`,
    });
    expectProblem(shared, 410, 'SHARE_LINK_GONE');

    const audit = await db.kysely
      .selectFrom('meta.audit_logs')
      .select(['entity_id', 'actor_id', 'after'])
      .where('organization_id', '=', fx.orgId)
      .where('action', '=', 'table.purged')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entity_id: fx.customers.id,
      actor_id: fx.users.owner.id,
      after: { name: 'Customers', record_count: 1 },
    });
  });
});
