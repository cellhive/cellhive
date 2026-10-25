import { fieldSchema, recordsResponseSchema, type FieldDto, type Id } from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/**
 * T458 over HTTP: record writes recompute stored lookups/formulas in their
 * own transaction (whatever the writer may read: values are for every
 * record), writes refused by permissions recompute nothing, and a change of
 * the organization's zone queues the date formulas for the job.
 */
describe('incremental recompute over HTTP (T458)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let total: FieldDto;
  let commission: FieldDto;
  let dueDay: FieldDto;
  let c1: Id<'rec'>;
  let o1: Id<'rec'>;

  function created(response: LightMyRequestResponse): FieldDto {
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  /** TEST ONLY: the stored column of a computed field. */
  async function stored(table: { db_table_name: string }, field: FieldDto, id: string) {
    const row = await db.kysely
      .selectFrom('meta.fields')
      .select('db_column_name')
      .where('id', '=', field.id)
      .executeTakeFirstOrThrow();
    const { rows } = await sql<{ v: string | null }>`
      SELECT ${sql.ref(row.db_column_name ?? '')}::text AS v
        FROM ${sql.table(`data.${table.db_table_name}`)} WHERE __id = ${id}
    `.execute(db.kysely);
    return rows[0]?.v ?? null;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    const customer = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'customer',
        type: 'link',
        options: { link_table: fx.customers.id },
      }),
    );
    const due = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'due',
        type: 'datetime',
        options: {},
      }),
    );
    const customers = recordsResponseSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
          records: [{ fields: { Tên: 'An Phát' } }],
        })
      ).json(),
    ).records;
    c1 = customers[0]?.id as Id<'rec'>;
    const orders = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        {
          fields: {
            title: 'o1',
            amount: 1000,
            owner: [{ id: fx.users.u_sales1.id }],
            customer: [c1],
            due: '2026-09-23',
          },
        },
        { fields: { title: 'o2', amount: 500, customer: [c1] } },
      ],
    });
    expect(orders.statusCode, orders.body).toBe(201);
    o1 = recordsResponseSchema.parse(orders.json()).records[0]?.id as Id<'rec'>;
    total = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/fields`, {
        name: 'total',
        type: 'lookup',
        options: {
          from: fx.orders.id,
          select: fx.fld.amount?.id,
          where: { field: customer.id, operator: 'intersects', value: { field_ref: '__id' } },
          aggregate: 'sum',
        },
      }),
    );
    commission = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'commission',
        type: 'formula',
        options: { expression: '[amount] * 0.1' },
      }),
    );
    dueDay = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'dueDay',
        type: 'formula',
        options: { expression: 'DAY([due])' },
      }),
    );
    expect(due.type).toBe('datetime');
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('PATCH of a cell recomputes the lookup of the other table and the formula of the row', async () => {
    const response = await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records`, {
      records: [{ id: o1, fields: { amount: 2000 } }],
    });
    expect(response.statusCode, response.body).toBe(200);
    // The response already has the recomputed value of its own row (T457 reads).
    const [record] = recordsResponseSchema.parse(response.json()).records;
    expect(record?.fields['commission']).toBe(200);
    expect(Number(await stored(fx.customers, total, c1))).toBe(2500);
    expect(Number(await stored(fx.orders, commission, o1))).toBe(200);
    const customer = await fx.call('u_admin', 'GET', `/tables/${fx.customers.id}/records/${c1}`);
    expect(customer.statusCode, customer.body).toBe(200);
    const body: unknown = customer.json();
    expect(body).toMatchObject({ fields: { total: 2500 } });
  });

  it("u_sales1 edits its order: the lookup sums every order, not only the writer's", async () => {
    const response = await fx.call('u_sales1', 'PATCH', `/tables/${fx.orders.id}/records`, {
      records: [{ id: o1, fields: { amount: 3000 } }],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(Number(await stored(fx.customers, total, c1))).toBe(3500);
  });

  it('a refused write recomputes nothing (403 read-only, 404 other org)', async () => {
    expectProblem(
      await fx.call('u_reader', 'PATCH', `/tables/${fx.orders.id}/records`, {
        records: [{ id: o1, fields: { amount: 1 } }],
      }),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('stranger', 'PATCH', `/tables/${fx.orders.id}/records`, {
        records: [{ id: o1, fields: { amount: 1 } }],
      }),
      404,
      'NOT_FOUND',
    );
    expect(Number(await stored(fx.customers, total, c1))).toBe(3500);
  });

  it('a new zone of the organization queues the date formulas (ADR-21), not the others', async () => {
    const response = await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
      settings: { timezone: 'Asia/Tokyo' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const queued = await db.kysely
      .selectFrom('meta.computed_recompute_queue')
      .select(['field_id', 'record_id'])
      .where('organization_id', '=', fx.orgId)
      .execute();
    expect(queued).toContainEqual({ field_id: dueDay.id, record_id: '*' });
    expect(queued.map((row) => row.field_id)).not.toContain(commission.id);
  });
});
