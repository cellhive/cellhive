import {
  fieldSchema,
  linkCandidatesResponseSchema,
  newId,
  recordsResponseSchema,
  type FieldDto,
  type Id,
  type RealtimeServerMessage,
  viewListSchema,
  viewSchema,
} from '@cellhive/contracts';
import { FieldsRepository, orgScope, type Db } from '@cellhive/server-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/** Linking orders of the "renamed with 10 000 orders" case (BACKLOG T402). */
const MANY = 10_000;
const RUNS = 5;

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? 0;
}

/**
 * T402 over HTTP: the link picker's candidate list (`POST
 * /fields/:fieldId/link-candidates`) and cross-table realtime — renaming or
 * trashing a customer refreshes the `customer` cells of its orders for each
 * subscriber, as patches (few orders) or one `record.batch` (10 000).
 */
describe('link candidates and cross-table realtime (T402)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let t: TestApp;
  let url: string;
  let fx: RecordFixture;
  let customer: FieldDto;
  let gold: FieldDto;
  let tier: FieldDto;
  let few: Id<'rec'>, many: Id<'rec'>, silver: Id<'rec'>;
  let fewOrders: Id<'rec'>[] = [];
  const sockets: TestSocket[] = [];

  function field(response: LightMyRequestResponse): FieldDto {
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  const candidates = (user: 'u_admin' | 'u_sales1' | 'u_reader', fieldId: Id<'fld'>, body = {}) =>
    fx.call(user, 'POST', `/fields/${fieldId}/link-candidates`, body);

  async function connect(user: 'u_admin' | 'u_sales1'): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    expect(await socket.subscribe(`table:${fx.orders.id}`)).toMatchObject({ type: 'subscribed' });
    return socket;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    pool = new pg.Pool({ connectionString: database.url, max: 2 });
    t = await startTestApp({ DATABASE_URL: database.url });
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    tier = field(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/fields`, {
        name: 'Hạng',
        type: 'select',
        options: {
          options: [
            { id: newId('opt'), name: 'Vàng' },
            { id: newId('opt'), name: 'Bạc' },
          ],
        },
      }),
    );
    const goldOption = (tier.options as { options: { id: string; name: string }[] }).options[0];
    customer = field(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'customer',
        type: 'link',
        options: { link_table: fx.customers.id },
      }),
    );
    gold = field(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'gold customer',
        type: 'link',
        options: {
          link_table: fx.customers.id,
          record_filter: {
            op: 'and',
            items: [{ field: tier.id, operator: 'is', value: goldOption?.id }],
          },
        },
      }),
    );
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
      records: [
        { fields: { Tên: 'Khách ít đơn', Hạng: 'Vàng' } },
        { fields: { Tên: 'Khách nhiều đơn', Hạng: 'Vàng' } },
        { fields: { Tên: 'Khách bạc', Hạng: 'Bạc' } },
      ],
    });
    [few, many, silver] = recordsResponseSchema
      .parse(created.json())
      .records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
    const orders = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        { fields: { title: 'f1', owner: [{ id: fx.users.u_sales1.id }], customer: [few] } },
        { fields: { title: 'f2', owner: [{ id: fx.users.u_sales2.id }], customer: [few] } },
        { fields: { title: 'f3', customer: [few] } },
      ],
    });
    fewOrders = recordsResponseSchema.parse(orders.json()).records.map((record) => record.id);

    // 10 000 orders of one customer, straight into the tables (fixture data).
    const junction = (await new FieldsRepository(db).getById(orgScope(fx.orgId), customer.id))
      ?.link_junction as string;
    const ids = Array.from({ length: MANY }, () => newId('rec'));
    await pool.query(
      `INSERT INTO data.${pg.escapeIdentifier(fx.orders.db_table_name)} (__id, ${pg.escapeIdentifier(
        (fx.fld.title as { db_column_name: string }).db_column_name,
      )}) SELECT u.id, 'bulk ' || u.n FROM unnest($1::text[]) WITH ORDINALITY AS u(id, n)`,
      [ids],
    );
    await pool.query(
      `INSERT INTO data.${pg.escapeIdentifier(junction)} (a_id, b_id, position)
       SELECT u.id, $2, 0 FROM unnest($1::text[]) AS u(id)`,
      [ids, many],
    );
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await t.close();
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  describe('POST /fields/:fieldId/link-candidates', () => {
    it('u_sales1 cannot read Customers: 404, like a missing field', async () => {
      expectProblem(await candidates('u_sales1', customer.id), 404, 'NOT_FOUND');
      expectProblem(await candidates('u_admin', 'fld_0000000000000000'), 404, 'NOT_FOUND');
    });

    it('a reader who cannot write the link field: 403', async () => {
      expectProblem(await candidates('u_reader', customer.id), 403, 'PERMISSION_DENIED');
    });

    it('record_filter "Hạng = Vàng" offers gold customers only', async () => {
      const response = await candidates('u_admin', gold.id, { search: 'khach' });
      expect(response.statusCode, response.body).toBe(200);
      const body = linkCandidatesResponseSchema.parse(response.json());
      expect(body.items.map((item) => item.id)).toEqual([few, many]);
      expect(body.items.map((item) => item.title)).toEqual(['Khách ít đơn', 'Khách nhiều đơn']);
      const all = linkCandidatesResponseSchema.parse(
        (await candidates('u_admin', customer.id, { record_id: fewOrders[0] })).json(),
      );
      expect(all.items.map((item) => [item.id, item.linked])).toContainEqual([silver, false]);
      expect(all.items.map((item) => [item.id, item.linked])).toContainEqual([few, true]);
      expect(all.cell).toEqual({ count: 1, limit: 500 });
    });

    it('rejects an invalid body with 422', async () => {
      expectProblem(
        await candidates('u_admin', customer.id, { limit: 0 }),
        422,
        'VALIDATION_FAILED',
      );
    });
  });

  describe('embedded sub-table columns (view config record_detail)', () => {
    it('stores columns of the linked table per link field; readers see what they read', async () => {
      const views = viewListSchema.parse(
        (await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/views`)).json(),
      );
      const view = views.items[0];
      if (view === undefined) throw new Error('no view');
      const columns = [tier.id, (fx.fld.customerName as { id: Id<'fld'> }).id];
      const saved = await fx.call('u_admin', 'PATCH', `/views/${view.id}`, {
        config: { record_detail: { link_columns: { [customer.id]: columns } } },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(viewSchema.parse(saved.json()).config.record_detail).toEqual({
        link_columns: { [customer.id]: columns },
      });
      // u_sales1 cannot read Customers: no entry for them.
      const sales = await fx.call('u_sales1', 'GET', `/views/${view.id}`);
      expect(viewSchema.parse(sales.json()).config.record_detail).toEqual({ link_columns: {} });
      // A column of another table is unknown.
      expectProblem(
        await fx.call('u_admin', 'PATCH', `/views/${view.id}`, {
          config: {
            record_detail: {
              link_columns: { [customer.id]: [(fx.fld.title as { id: Id<'fld'> }).id] },
            },
          },
        }),
        422,
        'VALIDATION_FAILED',
      );
    });
  });

  describe('cross-table realtime', () => {
    const isFanout = (id: string) => (message: RealtimeServerMessage) =>
      message.type === 'record.updated' && message.record_id === id && message.event_id === null;

    it('renaming a customer of 3 orders patches each order; u_sales1 gets no title', async () => {
      const admin = await connect('u_admin');
      const sales = await connect('u_sales1');
      const renamed = await fx.call('u_admin', 'PATCH', `/tables/${fx.customers.id}/records`, {
        records: [{ id: few, fields: { Tên: 'Khách ít đơn (mới)' } }],
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      for (const id of fewOrders) {
        expect(await admin.next(isFanout(id))).toMatchObject({
          fields: { [customer.id]: [{ id: few, title: 'Khách ít đơn (mới)' }] },
        });
      }
      await sales.expectNone((message) => message.type.startsWith('record.'));

      // Trash: the ids change, so every reader of the orders is told (title or not).
      const trashed = await fx.call('u_admin', 'DELETE', `/tables/${fx.customers.id}/records`, {
        ids: [few],
      });
      expect(trashed.statusCode, trashed.body).toBe(200);
      expect(await admin.next(isFanout(fewOrders[0] as string))).toMatchObject({
        fields: { [customer.id]: null },
      });
      expect(await sales.next(isFanout(fewOrders[0] as string))).toMatchObject({
        fields: { [customer.id]: null },
      });
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records/restore`, {
        ids: [few],
      });
      expect(await sales.next(isFanout(fewOrders[0] as string))).toMatchObject({
        fields: { [customer.id]: [{ id: few, title: null }] },
      });
      admin.close();
      sales.close();
    });

    it(`renaming a customer of ${String(MANY)} orders: one record.batch per group, < 1 s p95`, async () => {
      const admin = await connect('u_admin');
      const sales = await connect('u_sales1');
      const latencies: number[] = [];
      const totals: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const started = Date.now();
        const response = await fx.call('u_admin', 'PATCH', `/tables/${fx.customers.id}/records`, {
          records: [{ id: many, fields: { Tên: `Khách nhiều đơn ${String(run)}` } }],
        });
        expect(response.statusCode, response.body).toBe(200);
        const answered = Date.now();
        const batch = await admin.next((message) => message.type === 'record.batch');
        latencies.push(Date.now() - answered);
        totals.push(Date.now() - started);
        expect(batch).toMatchObject({ count: MANY, ops: { updated: MANY } });
      }
      await admin.expectNone((message) => message.type.startsWith('record.'));
      await sales.expectNone((message) => message.type.startsWith('record.'));
      process.stdout.write(
        `[T402] rename with ${String(MANY)} linked orders → record.batch after the HTTP answer: ` +
          `p95 ${String(p95(latencies))} ms; from the request: p95 ${String(p95(totals))} ms ` +
          `(${totals.join(', ')})\n`,
      );
      // Like T303: from the HTTP answer to the message (the fan-out is planned in the write
      // and published after commit). The whole round trip is reported (≈ 150 ms on an idle
      // machine, up to ≈ 1.4 s with every integration suite running).
      expect(p95(latencies)).toBeLessThan(1_000);
    });
  });
});
