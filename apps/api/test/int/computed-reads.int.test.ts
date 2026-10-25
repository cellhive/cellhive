import {
  baseDetailSchema,
  fieldListSchema,
  fieldSchema,
  recordListResponseSchema,
  recordsResponseSchema,
  type FieldDto,
  type Id,
} from '@cellhive/contracts';
import { orgScope, RecordMutationService, SchemaService, type Db } from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/**
 * T457 over HTTP: formula/lookup values in record reads, `locked` in the
 * field list of each reader (CONTRACTS §5 P34, P36), filters/sorts on a
 * locked field (`422`), the base setting `strict_computed_permissions`
 * (`PATCH /bases/:id`, base admins only) and view configs.
 */
describe('computed field reads over HTTP (T457)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let total: FieldDto;
  let customerName: FieldDto;
  let o1: Id<'rec'>;

  function created(response: LightMyRequestResponse): FieldDto {
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  /** What the `computed.backfill` job does for one stored field. */
  async function backfill(fieldId: Id<'fld'>): Promise<void> {
    const scope = orgScope(fx.orgId);
    let cursor = 0n;
    for (;;) {
      const result = await t.app.get(RecordMutationService).backfillComputedBatch(scope, {
        fieldId,
        afterAuto: cursor,
        limit: 1000,
        statementTimeoutMs: 30_000,
      });
      if (result.status !== 'more') break;
      cursor = result.cursor;
    }
    await t.app.get(SchemaService).finishComputedBackfill(scope, fieldId, { status: 'ready' });
  }

  async function fieldsOf(user: 'u_admin' | 'u_sales1'): Promise<Map<string, FieldDto>> {
    const response = await fx.call(user, 'GET', `/tables/${fx.orders.id}/fields?limit=100`);
    expect(response.statusCode, response.body).toBe(200);
    return new Map(
      fieldListSchema.parse(response.json()).items.map((field) => [field.name, field]),
    );
  }

  async function recordOf(user: 'u_admin' | 'u_sales1') {
    const response = await fx.call(user, 'GET', `/tables/${fx.orders.id}/records/${o1}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ fields: Record<string, unknown> }>().fields;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'customer',
        type: 'link',
        options: { link_table: fx.customers.id },
      }),
    );
    const customers = recordsResponseSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
          records: [{ fields: { Tên: 'An Phát' } }],
        })
      ).json(),
    ).records;
    const orders = recordsResponseSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
          records: [
            {
              fields: {
                title: 'o1',
                amount: 1000,
                cost: 10,
                owner: [{ id: fx.users.u_sales1.id }],
                customer: [customers[0]?.id],
              },
            },
          ],
        })
      ).json(),
    ).records;
    o1 = orders[0]?.id as Id<'rec'>;
    total = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'total_formula',
        type: 'formula',
        options: { expression: '[amount] + [cost]' },
      }),
    );
    customerName = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'customer_name',
        type: 'formula',
        options: { expression: 'ARRAYJOIN([customer].[Tên], ", ")' },
      }),
    );
    await backfill(total.id);
    await backfill(customerName.id);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('records carry computed values; the field list says what is locked (P34)', async () => {
    expect(await recordOf('u_admin')).toMatchObject({
      total_formula: 1010,
      customer_name: 'An Phát',
    });
    const admin = await fieldsOf('u_admin');
    expect(admin.get('customer_name')).toMatchObject({ locked: false });
    // u_sales1 cannot read Customers: the cross-table formula is locked.
    const sales = await fieldsOf('u_sales1');
    expect(sales.get('customer_name')).toMatchObject({ locked: true, options: { style: null } });
    expect(sales.get('customer_name')?.options).not.toHaveProperty('expression');
    expect(sales.get('total_formula')).toMatchObject({ locked: false });
    const record = await recordOf('u_sales1');
    expect(record).toMatchObject({ total_formula: 1010, customer_name: null });
    expect(record).not.toHaveProperty('cost');
    expectProblem(
      await fx.call('u_sales1', 'POST', `/tables/${fx.orders.id}/records/query`, {
        filter: { field: customerName.id, operator: 'is_not_empty' },
      }),
      422,
      'INVALID_FILTER',
    );
    expectProblem(
      await fx.call('u_sales1', 'POST', `/tables/${fx.orders.id}/records/query`, {
        sort: [{ field: 'customer_name', direction: 'asc' }],
      }),
      422,
      'INVALID_SORT',
    );
    const filtered = await fx.call('u_sales1', 'POST', `/tables/${fx.orders.id}/records/query`, {
      filter: { field: total.id, operator: 'gt', value: 1000 },
      sort: [{ field: 'total_formula', direction: 'desc' }],
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(recordListResponseSchema.parse(filtered.json()).records.map((item) => item.id)).toEqual([
      o1,
    ]);
  });

  it('views: a sort on a locked field is INVALID_SORT, on a visible formula it saves', async () => {
    expectProblem(
      await fx.call('u_sales1', 'POST', `/tables/${fx.orders.id}/views`, {
        name: 'mine',
        type: 'grid',
        is_personal: true,
        config: { sort: [{ field: customerName.id, direction: 'asc' }] },
      }),
      422,
      'INVALID_SORT',
    );
    const view = await fx.call('u_sales1', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'mine',
      type: 'grid',
      is_personal: true,
      config: {
        sort: [{ field: total.id, direction: 'desc' }],
        filter: { field: total.id, operator: 'gte', value: 1 },
      },
    });
    expect(view.statusCode, view.body).toBe(201);
  });

  it('P36: strict_computed_permissions (base admins only) hides formulas over no_perm fields', async () => {
    expectProblem(
      await fx.call('u_editor', 'PATCH', `/bases/${fx.baseId}`, {
        settings: { strict_computed_permissions: true },
      }),
      403,
      'PERMISSION_DENIED',
    );
    const on = await fx.call('u_admin', 'PATCH', `/bases/${fx.baseId}`, {
      settings: { strict_computed_permissions: true },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(baseDetailSchema.parse(on.json()).settings).toEqual({
      strict_computed_permissions: true,
    });
    const settings = await db.kysely
      .selectFrom('meta.bases')
      .select('settings')
      .where('id', '=', fx.baseId)
      .executeTakeFirstOrThrow();
    expect(settings.settings).toMatchObject({ strict_computed_permissions: true });
    expect((await fieldsOf('u_sales1')).get('total_formula')).toMatchObject({ locked: true });
    expect(await recordOf('u_sales1')).toMatchObject({ total_formula: null });
    expect(await recordOf('u_admin')).toMatchObject({ total_formula: 1010 });
    expectProblem(
      await fx.call('u_sales1', 'POST', `/tables/${fx.orders.id}/records/query`, {
        filter: { field: total.id, operator: 'gt', value: 0 },
      }),
      422,
      'INVALID_FILTER',
    );
    const off = await fx.call('u_admin', 'PATCH', `/bases/${fx.baseId}`, {
      settings: { strict_computed_permissions: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(await recordOf('u_sales1')).toMatchObject({ total_formula: 1010 });
    expectProblem(
      await fx.call('u_admin', 'PATCH', `/bases/${fx.baseId}`, { settings: {} }),
      422,
      'VALIDATION_FAILED',
    );
  });
});
