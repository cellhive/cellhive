import {
  fieldSchema,
  recordSchema,
  recordsResponseSchema,
  type FieldDto,
  type Id,
  type RealtimeServerMessage,
  type RecordDto,
} from '@cellhive/contracts';
import { roleConfigSchema } from '@cellhive/permissions';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  orgScope,
  type Db,
  type JsonObject,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/**
 * T401: link fields over HTTP — creating one-way and two-way links with the
 * schema rights of both tables, P20 (`title: null` for u_sales1), writes to
 * unreadable records, the trash flag of the field, and realtime patches on
 * both tables of a two-way link.
 */
describe('link fields (T401)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let url: string;
  let fx: RecordFixture;
  let customer: FieldDto;
  let r1: Id<'rec'>;
  let c1: Id<'rec'>, c2: Id<'rec'>;
  const sockets: TestSocket[] = [];

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  function field(response: LightMyRequestResponse): FieldDto {
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  /** A custom role of the fixture base assigned directly to `user`. */
  async function giveRole(user: 'u_out' | 'u_sales2', tables: Record<string, unknown>) {
    const scope = orgScope(fx.orgId);
    const role = await new BaseRolesRepository(db).create(scope, {
      baseId: fx.baseId,
      name: `Role ${user}`,
      kind: 'custom',
      config: roleConfigSchema.parse({ tables }) as unknown as JsonObject,
    });
    await new BaseRoleMembersRepository(db).assign(scope, {
      baseId: fx.baseId,
      roleId: role.id,
      principalType: 'user',
      principalId: fx.users[user].id,
    });
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    customer = field(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'customer',
        type: 'link',
        options: { link_table: fx.customers.id },
      }),
    );
    [c1, c2] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
        records: [{ fields: { Tên: 'An Phát' } }, { fields: { Tên: 'Bình Minh' } }],
      }),
    ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>];
    [r1] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: [
          {
            fields: {
              title: 'r1',
              owner: [{ id: fx.users.u_sales1.id }],
              customer: [c1],
            },
          },
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>];
    // Managers of Orders: u_out also reads Customers, u_sales2 does not see it.
    await giveRole('u_out', {
      [fx.orders.id]: { perm: 'manage' },
      [fx.customers.id]: { perm: 'read_only' },
    });
    await giveRole('u_sales2', { [fx.orders.id]: { perm: 'manage' } });
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('creates a one-way link (options echo, read-only symmetric_field_id)', () => {
    expect(customer).toMatchObject({
      type: 'link',
      options: {
        link_table: fx.customers.id,
        bidirectional: false,
        allow_multiple: true,
        record_filter: null,
        symmetric_field_id: null,
      },
    });
    expect(customer).not.toHaveProperty('link_target_deleted');
  });

  it('P20: u_sales1 reads the id of r1.customer, title null', async () => {
    const response = await fx.call('u_sales1', 'GET', `/tables/${fx.orders.id}/records/${r1}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(recordSchema.parse(response.json()).fields.customer).toEqual([{ id: c1, title: null }]);
    const adminView = await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/records/${r1}`);
    expect(recordSchema.parse(adminView.json()).fields.customer).toEqual([
      { id: c1, title: 'An Phát' },
    ]);
  });

  it('u_sales1 linking a Customers record → 422 LINK_TARGET_NOT_FOUND, like a missing id', async () => {
    for (const target of [c2, 'rec_0000000000000000']) {
      const response = await fx.call('u_sales1', 'PATCH', `/tables/${fx.orders.id}/records`, {
        records: [{ id: r1, fields: { customer: [c1, target] } }],
      });
      expectProblem(response, 422, 'LINK_TARGET_NOT_FOUND');
    }
    // Resending the cell keeps the link to the unreadable record.
    const kept = records(
      await fx.call('u_sales1', 'PATCH', `/tables/${fx.orders.id}/records`, {
        records: [{ id: r1, fields: { customer: [{ id: c1 }] } }],
      }),
    );
    expect(kept[0]?.fields.customer).toEqual([{ id: c1, title: null }]);
  });

  it('sorting on a link field → 422 INVALID_SORT (FIELD_NOT_SORTABLE)', async () => {
    const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records/query`, {
      sort: [{ field: 'customer' }],
    });
    expectProblem(response, 422, 'INVALID_SORT');
  });

  it('a two-way link needs schema rights on both tables: 403 when readable, 404 when not', async () => {
    const body = {
      name: 'buyer 2',
      type: 'link',
      options: { link_table: fx.customers.id, bidirectional: true },
    };
    expectProblem(
      await fx.call('u_out', 'POST', `/tables/${fx.orders.id}/fields`, body),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_sales2', 'POST', `/tables/${fx.orders.id}/fields`, body),
      404,
      'NOT_FOUND',
    );
    // A one-way link to a readable table is enough with `manage` on Orders.
    const oneWay = field(
      await fx.call('u_out', 'POST', `/tables/${fx.orders.id}/fields`, {
        ...body,
        options: { link_table: fx.customers.id },
      }),
    );
    expect(oneWay.options).toMatchObject({ bidirectional: false });
    await fx.call('u_admin', 'DELETE', `/fields/${oneWay.id}`);
  });

  it('two clients (Orders, Customers) both get the patch of a two-way link write', async () => {
    const buyers = field(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/fields`, {
        name: 'orders',
        type: 'link',
        options: {
          link_table: fx.orders.id,
          bidirectional: true,
          bidirectional_link_field_name: 'buyer',
        },
      }),
    );
    const reverseId = buyers.options.symmetric_field_id as Id<'fld'>;
    const reverse = await fx.call('u_admin', 'GET', `/fields/${reverseId}`);
    expect(fieldSchema.parse(reverse.json())).toMatchObject({
      table_id: fx.orders.id,
      name: 'buyer',
      options: { symmetric_field_id: buyers.id, bidirectional: true },
    });

    const connect = async (user: 'u_admin' | 'u_sales1', tableId: Id<'tbl'>) => {
      const socket = await TestSocket.connect(url, {
        origin: TEST_PUBLIC_URL,
        cookie: await fx.cookie(user),
      });
      sockets.push(socket);
      expect(await socket.subscribe(`table:${tableId}`)).toMatchObject({ type: 'subscribed' });
      return socket;
    };
    const onOrders = await connect('u_admin', fx.orders.id);
    const onCustomers = await connect('u_admin', fx.customers.id);
    const salesOnOrders = await connect('u_sales1', fx.orders.id);

    const updated = records(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.customers.id}/records?field_key_type=id`, {
        records: [{ id: c2, fields: { [buyers.id]: [r1] } }],
      }),
    );
    expect(updated[0]?.fields[buyers.id]).toEqual([{ id: r1, title: 'r1' }]);

    const isUpdate = (id: string) => (message: RealtimeServerMessage) =>
      message.type === 'record.updated' && message.record_id === id;
    expect(await onCustomers.next(isUpdate(c2))).toMatchObject({
      fields: { [buyers.id]: [{ id: r1, title: 'r1' }] },
    });
    expect(await onOrders.next(isUpdate(r1))).toMatchObject({
      fields: { [reverseId]: [{ id: c2, title: 'Bình Minh' }] },
    });
    // u_sales1 reads r1 but not Customers: the id without its title (P20).
    expect(await salesOnOrders.next(isUpdate(r1))).toMatchObject({
      fields: { [reverseId]: [{ id: c2, title: null }] },
    });
  });

  it('T423: a mixed batch on both sides keeps one audit row + event + dispatch job per changed record, and P20 in realtime', async () => {
    const deals = field(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/fields`, {
        name: 'deals',
        type: 'link',
        options: {
          link_table: fx.orders.id,
          bidirectional: true,
          bidirectional_link_field_name: 'dealer',
        },
      }),
    );
    const dealer = deals.options.symmetric_field_id as Id<'fld'>;
    const [r2, r3] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: [
          { fields: { title: 'r2', owner: [{ id: fx.users.u_sales1.id }] } },
          { fields: { title: 'r3', owner: [{ id: fx.users.u_sales2.id }] } },
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>];
    records(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.customers.id}/records?field_key_type=id`, {
        records: [{ id: c1, fields: { [deals.id]: [r1, r3] } }],
      }),
    );

    const connect = async (user: 'u_admin' | 'u_sales1', tableId: Id<'tbl'>) => {
      const socket = await TestSocket.connect(url, {
        origin: TEST_PUBLIC_URL,
        cookie: await fx.cookie(user),
      });
      sockets.push(socket);
      expect(await socket.subscribe(`table:${tableId}`)).toMatchObject({ type: 'subscribed' });
      return socket;
    };
    const onOrders = await connect('u_admin', fx.orders.id);
    const onCustomers = await connect('u_admin', fx.customers.id);
    const salesOnOrders = await connect('u_sales1', fx.orders.id);
    const isUpdate = (id: string) => (message: RealtimeServerMessage) =>
      message.type === 'record.updated' && message.record_id === id;

    /** The audit rows, events and dispatch jobs of `fieldIds` written since `since`. */
    async function outputs(since: Date, fieldIds: readonly string[]) {
      const { rows: audits } = await sql<{
        entity_id: string;
        batch_id: string;
        after: JsonObject;
      }>`
        SELECT entity_id, batch_id, after FROM meta.audit_logs
         WHERE organization_id = ${fx.orgId} AND action = 'record.updated'
           AND created_at >= ${since} AND after ?| ${fieldIds}::text[]
         ORDER BY entity_id
      `.execute(db.kysely);
      const { rows: events } = await sql<{ id: string; entity_id: string }>`
        SELECT id, entity_id FROM meta.events
         WHERE organization_id = ${fx.orgId} AND type = 'record.updated'
           AND created_at >= ${since} AND entity_id = ANY(${audits.map((row) => row.entity_id)}::text[])
         ORDER BY entity_id
      `.execute(db.kysely);
      const { rows: jobs } = await sql<{ event_id: string; organization_id: string }>`
        SELECT p.payload->>'event_id' AS event_id,
               p.payload->>'organization_id' AS organization_id
          FROM graphile_worker._private_jobs AS p
          JOIN graphile_worker._private_tasks AS k ON k.id = p.task_id
         WHERE k.identifier = 'events.dispatch'
           AND p.payload->>'event_id' = ANY(${events.map((row) => row.id)}::text[])
      `.execute(db.kysely);
      return { audits, events, jobs };
    }
    const startOf = async () =>
      (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db.kysely)).rows[0]
        ?.now as Date;

    // 1. From the Customers side: c1 [r1, r3] → [r1, r2]; c2 [] → [r2, r3].
    const first = await startOf();
    records(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.customers.id}/records?field_key_type=id`, {
        records: [
          { id: c1, fields: { [deals.id]: [r1, r2] } },
          { id: c2, fields: { [deals.id]: [r2, r3] } },
        ],
      }),
    );
    let out = await outputs(first, [deals.id, dealer]);
    // r1 kept c1: unchanged, no row. One row per changed record per side, one batch.
    expect(out.audits.map((row) => row.entity_id).sort()).toEqual([c1, c2, r2, r3].sort());
    expect(new Set(out.audits.map((row) => row.batch_id)).size).toBe(1);
    const afterOf = (id: string) => out.audits.find((row) => row.entity_id === id)?.after;
    expect(afterOf(c1)).toEqual({ [deals.id]: [r1, r2] });
    expect(afterOf(c2)).toEqual({ [deals.id]: [r2, r3] });
    expect(afterOf(r2)).toEqual({ [dealer]: [c1, c2] });
    expect(afterOf(r3)).toEqual({ [dealer]: [c2] });
    expect(out.events.map((row) => row.entity_id).sort()).toEqual([c1, c2, r2, r3].sort());
    expect(out.jobs.map((job) => job.event_id).sort()).toEqual(
      out.events.map((row) => row.id).sort(),
    );
    expect(new Set(out.jobs.map((job) => job.organization_id))).toEqual(new Set([fx.orgId]));

    expect(await onCustomers.next(isUpdate(c1))).toMatchObject({
      fields: {
        [deals.id]: [
          { id: r1, title: 'r1' },
          { id: r2, title: 'r2' },
        ],
      },
    });
    expect(await onCustomers.next(isUpdate(c2))).toMatchObject({
      fields: {
        [deals.id]: [
          { id: r2, title: 'r2' },
          { id: r3, title: 'r3' },
        ],
      },
    });
    expect(await onOrders.next(isUpdate(r2))).toMatchObject({
      fields: {
        [dealer]: [
          { id: c1, title: 'An Phát' },
          { id: c2, title: 'Bình Minh' },
        ],
      },
    });
    expect(await onOrders.next(isUpdate(r3))).toMatchObject({
      fields: { [dealer]: [{ id: c2, title: 'Bình Minh' }] },
    });
    // u_sales1 reads r2 (its owner) but not Customers: ids, titles null (P20); never r3.
    expect(await salesOnOrders.next(isUpdate(r2))).toMatchObject({
      fields: {
        [dealer]: [
          { id: c1, title: null },
          { id: c2, title: null },
        ],
      },
    });
    await salesOnOrders.expectNone(isUpdate(r3));
    await onOrders.expectNone(isUpdate(r1));

    // 2. From the Orders side: r1 [c1] → [c1, c2]; r2 [c1, c2] → [c1].
    const second = await startOf();
    records(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records?field_key_type=id`, {
        records: [
          { id: r1, fields: { [dealer]: [c1, c2] } },
          { id: r2, fields: { [dealer]: [c1] } },
        ],
      }),
    );
    out = await outputs(second, [deals.id, dealer]);
    // c1 keeps r1 and r2: unchanged. c2 loses r2 and gets r1 at the end of its cell.
    expect(out.audits.map((row) => row.entity_id).sort()).toEqual([c2, r1, r2].sort());
    expect(new Set(out.audits.map((row) => row.batch_id)).size).toBe(1);
    expect(afterOf(c2)).toEqual({ [deals.id]: [r3, r1] });
    expect(afterOf(r1)).toEqual({ [dealer]: [c1, c2] });
    expect(afterOf(r2)).toEqual({ [dealer]: [c1] });
    expect(out.jobs.map((job) => job.event_id).sort()).toEqual(
      out.events.map((row) => row.id).sort(),
    );
    expect(out.events).toHaveLength(3);
    expect(await onCustomers.next(isUpdate(c2))).toMatchObject({
      fields: {
        [deals.id]: [
          { id: r3, title: 'r3' },
          { id: r1, title: 'r1' },
        ],
      },
    });
    expect(await salesOnOrders.next(isUpdate(r2))).toMatchObject({
      fields: { [dealer]: [{ id: c1, title: null }] },
    });
    await onCustomers.expectNone(isUpdate(c1));
    await fx.call('u_admin', 'DELETE', `/fields/${deals.id}`);
  });

  it('a linked table in the trash flags the field; its cells read empty', async () => {
    expect((await fx.call('owner', 'DELETE', `/tables/${fx.customers.id}`)).statusCode).toBe(204);
    try {
      const listed = await fx.call('u_admin', 'GET', `/fields/${customer.id}`);
      expect(fieldSchema.parse(listed.json()).link_target_deleted).toBe(true);
      const record = await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/records/${r1}`);
      expect(recordSchema.parse(record.json()).fields.customer).toBeNull();
    } finally {
      await fx.call('owner', 'POST', `/tables/${fx.customers.id}/restore`);
    }
    const restored = await fx.call('u_admin', 'GET', `/fields/${customer.id}`);
    expect(fieldSchema.parse(restored.json())).not.toHaveProperty('link_target_deleted');
  });

  it('T421a: the source table of a two-way link in the trash makes the partner read-only', async () => {
    const dealer = field(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'T421a dealer',
        type: 'link',
        options: {
          link_table: fx.customers.id,
          bidirectional: true,
          bidirectional_link_field_name: 'T421a deals',
        },
      }),
    );
    const partner = dealer.options as { symmetric_field_id: Id<'fld'> };
    const deals = partner.symmetric_field_id;
    records(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records?field_key_type=id`, {
        records: [{ id: r1, fields: { [dealer.id]: [c1] } }],
      }),
    );
    expect((await fx.call('owner', 'DELETE', `/tables/${fx.orders.id}`)).statusCode).toBe(204);
    try {
      // The partner on Customers is flagged in the table's field list.
      const listed = await fx.call('u_admin', 'GET', `/tables/${fx.customers.id}/fields`);
      const flagged = fieldSchema
        .array()
        .parse(listed.json<{ items: unknown }>().items)
        .find((item) => item.id === deals);
      expect(flagged?.link_target_deleted).toBe(true);
      const record = await fx.call(
        'u_admin',
        'GET',
        `/tables/${fx.customers.id}/records/${c1}?field_key_type=id`,
      );
      expect(recordSchema.parse(record.json()).fields[deals]).toBeNull();
      // No new links, no picker.
      const write = await fx.call(
        'u_admin',
        'PATCH',
        `/tables/${fx.customers.id}/records?field_key_type=id`,
        { records: [{ id: c2, fields: { [deals]: [r1] } }] },
      );
      expectProblem(write, 422, 'LINK_TARGET_NOT_FOUND');
      const candidates = await fx.call('u_admin', 'POST', `/fields/${deals}/link-candidates`, {});
      expect(candidates.statusCode, candidates.body).toBe(404);
      // Writing other fields of the record still works (the empty cell is not sent back).
      records(
        await fx.call('u_admin', 'PATCH', `/tables/${fx.customers.id}/records`, {
          records: [{ id: c1, fields: { Tên: 'An Phát' } }],
        }),
      );
    } finally {
      await fx.call('owner', 'POST', `/tables/${fx.orders.id}/restore`);
    }
    // Restoring the table restores the partner: the link is back, the picker too.
    const record = await fx.call(
      'u_admin',
      'GET',
      `/tables/${fx.customers.id}/records/${c1}?field_key_type=id`,
    );
    expect(recordSchema.parse(record.json()).fields[deals]).toEqual([{ id: r1, title: 'r1' }]);
    const candidates = await fx.call('u_admin', 'POST', `/fields/${deals}/link-candidates`, {});
    expect(candidates.statusCode, candidates.body).toBe(200);
    await fx.call('u_admin', 'DELETE', `/fields/${dealer.id}`);
  });
});
