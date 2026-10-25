import {
  fieldSchema,
  recordHistoryResponseSchema,
  recordSchema,
  recordsResponseSchema,
  revertedRecordSchema,
  type FieldDto,
  type Id,
  type RecordDto,
  type RecordHistoryEntry,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/**
 * T465: record history and revert of link and `parent` fields (CONTRACTS
 * §11.1–11.2, BACKLOG S4b open question #3): entries on both sides of a
 * two-way link with one `batch_id`, titles under the viewer's current
 * access (P20), records deleted since, reverts through the normal write
 * path (`skipped`, `LINK_TARGET_NOT_FOUND`), permissions and tenants.
 */
describe('record history of links and parent (T465)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let orders: string;
  let customers: string;
  let customer: FieldDto;
  let reverseId: Id<'fld'>;
  let r1: Id<'rec'>;
  let c1: Id<'rec'>, c2: Id<'rec'>, c3: Id<'rec'>;

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  async function patch(
    user: FixtureUser,
    path: string,
    id: string,
    fields: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<RecordDto> {
    const response = await fx.call(user, 'PATCH', `${path}/${id}`, { fields, ...extra });
    expect(response.statusCode, response.body).toBe(200);
    return recordSchema.parse(response.json());
  }

  async function historyOf(
    user: FixtureUser,
    path: string,
    id: string,
    query = '',
  ): Promise<RecordHistoryEntry[]> {
    const response = await fx.call(user, 'GET', `${path}/${id}/history${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return recordHistoryResponseSchema.parse(response.json()).items;
  }

  const revert = (user: FixtureUser, path: string, id: string, auditId: string) =>
    fx.call(user, 'POST', `${path}/${id}/revert`, { audit_id: auditId });

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    orders = `/tables/${fx.orders.id}/records`;
    customers = `/tables/${fx.customers.id}/records`;
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'customer',
      type: 'link',
      options: {
        link_table: fx.customers.id,
        bidirectional: true,
        bidirectional_link_field_name: 'orders',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    customer = fieldSchema.parse(created.json());
    reverseId = customer.options.symmetric_field_id as Id<'fld'>;
    [c1, c2, c3] = records(
      await fx.call('u_admin', 'POST', customers, {
        records: [
          { fields: { Tên: 'An Phát' } },
          { fields: { Tên: 'Bình Minh' } },
          { fields: { Tên: 'Cửu Long' } },
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
    [r1] = records(
      await fx.call('u_admin', 'POST', orders, {
        records: [{ fields: { title: 'r1', owner: [{ id: fx.users.u_sales1.id }] } }],
      }),
    ).map((record) => record.id) as [Id<'rec'>];
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('linking a customer: an entry on the order and on the customer, same batch_id', async () => {
    await patch('u_admin', orders, r1, { customer: [c1] });

    const [order] = await historyOf('u_admin', orders, r1);
    expect(order).toMatchObject({
      action: 'record.updated',
      changes: { customer: { from: null, to: [{ id: c1, title: 'An Phát' }] } },
    });
    const [side] = await historyOf('u_admin', customers, c1);
    expect(side).toMatchObject({
      action: 'record.updated',
      changes: { orders: { from: null, to: [{ id: r1, title: 'r1' }] } },
    });
    expect(order?.batch).toMatchObject({ size: 2 });
    expect(side?.batch?.id).toBe(order?.batch?.id);

    // Unlinking is recorded on both sides as well.
    await patch('u_admin', orders, r1, { customer: [] });
    const [removed] = await historyOf('u_admin', orders, r1);
    expect(removed?.changes).toEqual({
      customer: { from: [{ id: c1, title: 'An Phát' }], to: null },
    });
    const [removedSide] = await historyOf('u_admin', customers, c1);
    expect(removedSide?.changes).toEqual({
      orders: { from: [{ id: r1, title: 'r1' }], to: null },
    });
    expect(removedSide?.batch?.id).toBe(removed?.batch?.id);
  });

  it('`?field=` keeps the entries of a link field (by name or id)', async () => {
    const byName = await historyOf('u_admin', orders, r1, '?field=customer');
    expect(byName.length).toBeGreaterThanOrEqual(2);
    for (const entry of byName) expect(Object.keys(entry.changes)).toEqual(['customer']);
    const byId = await historyOf('u_admin', orders, r1, `?field_key_type=id&field=${customer.id}`);
    expect(byId.map((entry) => entry.id)).toEqual(byName.map((entry) => entry.id));
  });

  it('P20: u_sales1 sees the customer entries of r1 with title null', async () => {
    const entries = await historyOf('u_sales1', orders, r1, '?field=customer');
    expect(entries[0]?.changes).toEqual({
      customer: { from: [{ id: c1, title: null }], to: null },
    });
    expect(entries[1]?.changes).toEqual({
      customer: { from: null, to: [{ id: c1, title: null }] },
    });
  });

  it('revert of an unlink restores the link on both sides', async () => {
    const [removed] = await historyOf('u_admin', orders, r1, '?field=customer');
    const response = await revert('u_admin', orders, r1, removed?.id ?? '');
    expect(response.statusCode, response.body).toBe(200);
    const record = revertedRecordSchema.parse(response.json());
    expect(record.fields.customer).toEqual([{ id: c1, title: 'An Phát' }]);
    expect(record).not.toHaveProperty('skipped');
    const [side] = await historyOf('u_admin', customers, c1);
    expect(side).toMatchObject({
      via: { reverted_from: removed?.id },
      changes: { orders: { from: null, to: [{ id: r1, title: 'r1' }] } },
    });
  });

  it('u_sales1: a revert keeps unreadable links, but linking one again is 422', async () => {
    // r1: [c1] → [c1, c2] by the admin.
    await patch('u_admin', orders, r1, { customer: [c1, c2] });
    const [added] = await historyOf('u_sales1', orders, r1, '?field=customer');
    expect(added?.changes).toEqual({
      customer: {
        from: [{ id: c1, title: null }],
        to: [
          { id: c1, title: null },
          { id: c2, title: null },
        ],
      },
    });
    // Back to [c1]: removing needs no read access, c1 is kept (P20).
    const back = await revert('u_sales1', orders, r1, added?.id ?? '');
    expect(back.statusCode, back.body).toBe(200);
    expect(revertedRecordSchema.parse(back.json()).fields.customer).toEqual([
      { id: c1, title: null },
    ]);
    // Reverting the revert would link c2 again, which u_sales1 cannot read.
    const [reverted] = await historyOf('u_sales1', orders, r1, '?field=customer');
    expectProblem(
      await revert('u_sales1', orders, r1, reverted?.id ?? ''),
      422,
      'LINK_TARGET_NOT_FOUND',
    );
  });

  it('records deleted since: `deleted: true` for readers, skipped on revert', async () => {
    await patch('u_admin', orders, r1, { customer: [c1, c3] });
    await patch('u_admin', orders, r1, { customer: [c1] });
    const [dropped] = await historyOf('u_admin', orders, r1, '?field=customer');
    const trashed = await fx.call('u_admin', 'DELETE', customers, { ids: [c3] });
    expect(trashed.statusCode, trashed.body).toBe(200);

    const [entry] = await historyOf('u_admin', orders, r1, '?field=customer');
    expect(entry?.id).toBe(dropped?.id);
    expect(entry?.changes).toEqual({
      customer: {
        from: [
          { id: c1, title: 'An Phát' },
          { id: c3, title: null, deleted: true },
        ],
        to: [{ id: c1, title: 'An Phát' }],
      },
    });
    // u_sales1 cannot read Customers: nothing tells it c3 was deleted.
    const [sales] = await historyOf('u_sales1', orders, r1, '?field=customer');
    expect(sales?.changes).toEqual({
      customer: {
        from: [
          { id: c1, title: null },
          { id: c3, title: null },
        ],
        to: [{ id: c1, title: null }],
      },
    });

    // Purged: still deleted.
    const purged = await fx.call('u_admin', 'POST', `${customers}/trash/purge`, { ids: [c3] });
    expect(purged.statusCode, purged.body).toBe(200);
    const [after] = await historyOf('u_admin', orders, r1, '?field=customer');
    expect(after?.changes.customer?.from).toEqual([
      { id: c1, title: 'An Phát' },
      { id: c3, title: null, deleted: true },
    ]);

    const response = await revert('u_admin', orders, r1, dropped?.id ?? '');
    expect(response.statusCode, response.body).toBe(200);
    const record = revertedRecordSchema.parse(response.json());
    expect(record.skipped).toBe(1);
    expect(record.fields.customer).toEqual([{ id: c1, title: 'An Phát' }]);
  });

  it('permissions: u_reader cannot revert (403), u_out and another org see nothing (404)', async () => {
    const [entry] = await historyOf('u_reader', orders, r1, '?field=customer');
    expect(entry?.changes.customer).toBeDefined();
    const denied = await revert('u_reader', orders, r1, entry?.id ?? '');
    expect(denied.statusCode, denied.body).toBe(403);
    expectProblem(await fx.call('u_out', 'GET', `${orders}/${r1}/history`), 404, 'NOT_FOUND');
    expectProblem(await fx.call('stranger', 'GET', `${orders}/${r1}/history`), 404, 'NOT_FOUND');
    expectProblem(await revert('stranger', orders, r1, entry?.id ?? ''), 404, 'NOT_FOUND');
  });

  it('the customer side: readable by readers of Customers only', async () => {
    // u_editor (system editor) reads Customers and its reverse link field.
    const entries = await historyOf('u_editor', customers, c1, `?field_key_type=id`);
    expect(entries.some((item) => Object.hasOwn(item.changes, reverseId))).toBe(true);
    // u_sales1 cannot read Customers at all.
    expectProblem(await fx.call('u_sales1', 'GET', `${customers}/${c1}/history`), 404, 'NOT_FOUND');
  });

  describe('parent (sub-records)', () => {
    let parentField: FieldDto;
    let a: Id<'rec'>, b: Id<'rec'>, x: Id<'rec'>;

    beforeAll(async () => {
      const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'Parent',
        type: 'parent',
      });
      expect(created.statusCode, created.body).toBe(201);
      parentField = fieldSchema.parse(created.json());
      [a, b, x] = records(
        await fx.call('u_admin', 'POST', orders, {
          records: [
            { fields: { title: 'A' } },
            { fields: { title: 'B' } },
            { fields: { title: 'X' } },
          ],
        }),
      ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
    });

    it('parent changes read { id, title } and revert sets the parent back', async () => {
      await patch('u_admin', orders, b, {}, { parent_id: a });
      await patch('u_admin', orders, b, {}, { parent_id: null });
      const [cleared, set] = await historyOf('u_admin', orders, b, '?field=Parent');
      expect(set?.changes).toEqual({ Parent: { from: null, to: { id: a, title: 'A' } } });
      expect(cleared?.changes).toEqual({ Parent: { from: { id: a, title: 'A' }, to: null } });

      const response = await revert('u_admin', orders, b, cleared?.id ?? '');
      expect(response.statusCode, response.body).toBe(200);
      expect(revertedRecordSchema.parse(response.json()).fields.Parent).toEqual({
        id: a,
        title: 'A',
      });
      expect(parentField.type).toBe('parent');
    });

    it('a parent deleted since reads deleted and is skipped by a revert', async () => {
      await patch('u_admin', orders, b, {}, { parent_id: x });
      await patch('u_admin', orders, b, {}, { parent_id: null });
      const [cleared] = await historyOf('u_admin', orders, b, '?field=Parent');
      const trashed = await fx.call('u_admin', 'DELETE', orders, { ids: [x] });
      expect(trashed.statusCode, trashed.body).toBe(200);

      const [entry] = await historyOf('u_admin', orders, b, '?field=Parent');
      expect(entry?.changes).toEqual({
        Parent: { from: { id: x, title: null, deleted: true }, to: null },
      });
      const response = await revert('u_admin', orders, b, cleared?.id ?? '');
      expect(response.statusCode, response.body).toBe(200);
      const record = revertedRecordSchema.parse(response.json());
      expect(record.skipped).toBe(1);
      expect(record.fields.Parent).toBeNull();
      // Nothing was written: no new entry.
      const [latest] = await historyOf('u_admin', orders, b, '?field=Parent');
      expect(latest?.id).toBe(cleared?.id);
    });
  });
});
