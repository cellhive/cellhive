import {
  convertFieldPreviewSchema,
  deletePreviewSchema,
  fieldListSchema,
  fieldSchema,
  recordListResponseSchema,
  recordsResponseSchema,
  type FieldDto,
  type Id,
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
 * T460 over HTTP: field-level errors in the field API (`compute_error` with
 * `refs` that never name what the reader cannot see), cells of a field in
 * error read `null`, filters on it answer like a missing field, the delete
 * previews (`dependents`, permissions) and the formula/lookup dependents of
 * `convert-preview`.
 */
describe('field-level errors of computed fields over HTTP (T460)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let customer: FieldDto;
  let costTimes: FieldDto;
  let reader: FieldDto;
  let total: FieldDto;
  let custName: FieldDto;
  let o1: Id<'rec'>;

  function created(response: LightMyRequestResponse): FieldDto {
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  async function fieldAs(user: FixtureUser, id: Id<'fld'>): Promise<FieldDto> {
    const response = await fx.call(user, 'GET', `/fields/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return fieldSchema.parse(response.json());
  }

  async function recordAs(user: FixtureUser, id: Id<'rec'>) {
    const response = await fx.call(user, 'GET', `/tables/${fx.orders.id}/records/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    const body: unknown = response.json();
    return (body as { fields: Record<string, unknown> }).fields;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    customer = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'customer',
        type: 'link',
        options: { link_table: fx.customers.id },
      }),
    );
    const [c1] = recordsResponseSchema
      .parse(
        (
          await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
            records: [{ fields: { Tên: 'An Phát' } }],
          })
        ).json(),
      )
      .records.map((record) => record.id);
    const orders = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [{ fields: { title: 'o1', amount: 1000, cost: 7, customer: [c1] } }],
    });
    expect(orders.statusCode, orders.body).toBe(201);
    o1 = recordsResponseSchema.parse(orders.json()).records[0]?.id as Id<'rec'>;
    costTimes = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'costTimes',
        type: 'formula',
        options: { expression: '[cost] * 10' },
      }),
    );
    reader = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'reader',
        type: 'formula',
        options: { expression: '[costTimes] + [amount]' },
      }),
    );
    custName = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'custName',
        type: 'formula',
        options: { expression: '[customer].[Tên].ARRAYJOIN()' },
      }),
    );
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
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('delete-preview of a field: formula/lookup that would be REF; schema rights only', async () => {
    const preview = await fx.call(
      'u_admin',
      'GET',
      `/fields/${fx.fld.cost?.id ?? ''}/delete-preview`,
    );
    expect(preview.statusCode, preview.body).toBe(200);
    const { dependents } = deletePreviewSchema.parse(preview.json());
    expect(dependents.filter((d) => d.type === 'field')).toEqual(
      expect.arrayContaining([
        { type: 'field', id: costTimes.id, table_id: fx.orders.id, name: 'costTimes' },
        { type: 'field', id: reader.id, table_id: fx.orders.id, name: 'reader' },
      ]),
    );
    // `amount` is read by `reader` and by the lookup of Customers.
    const amount = deletePreviewSchema.parse(
      (await fx.call('u_admin', 'GET', `/fields/${fx.fld.amount?.id ?? ''}/delete-preview`)).json(),
    );
    expect(amount.dependents.map((d) => d.id)).toEqual(
      expect.arrayContaining([reader.id, total.id]),
    );
    expectProblem(
      await fx.call('u_editor', 'GET', `/fields/${fx.fld.cost?.id ?? ''}/delete-preview`),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('stranger', 'GET', `/fields/${fx.fld.cost?.id ?? ''}/delete-preview`),
      404,
      'NOT_FOUND',
    );
  });

  it('delete-preview of a table: formulas of other tables that would be REF; base admins only', async () => {
    const preview = await fx.call('u_admin', 'GET', `/tables/${fx.customers.id}/delete-preview`);
    expect(preview.statusCode, preview.body).toBe(200);
    const ids = deletePreviewSchema.parse(preview.json()).dependents.map((d) => d.id);
    expect(ids).toContain(custName.id);
    // Its own fields go with it: not listed.
    expect(ids).not.toContain(total.id);
    expectProblem(
      await fx.call('u_editor', 'GET', `/tables/${fx.customers.id}/delete-preview`),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('stranger', 'GET', `/tables/${fx.customers.id}/delete-preview`),
      404,
      'NOT_FOUND',
    );
  });

  it('convert-preview lists the formulas a new type breaks', async () => {
    const preview = await fx.call(
      'u_admin',
      'POST',
      `/fields/${fx.fld.cost?.id ?? ''}/convert-preview`,
      {
        type: 'text',
        options: {},
      },
    );
    expect(preview.statusCode, preview.body).toBe(200);
    const body = convertFieldPreviewSchema.parse(preview.json());
    expect(body.dependents).toContainEqual({
      type: 'field',
      id: costTimes.id,
      table_id: fx.orders.id,
      name: 'costTimes',
    });
  });

  it('deleting `cost`: REF in the schema, refs by reader, cells null, filters refused; restore heals', async () => {
    const deleted = await fx.call('u_admin', 'DELETE', `/fields/${fx.fld.cost?.id ?? ''}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    // The admin sees what is missing (they manage the table and its trash).
    expect((await fieldAs('u_admin', costTimes.id)).compute_error).toEqual({
      code: 'REF',
      refs: [{ kind: 'field', id: fx.fld.cost?.id, name: 'cost' }],
    });
    expect((await fieldAs('u_admin', reader.id)).compute_error).toEqual({
      code: 'REF',
      refs: [{ kind: 'field', id: costTimes.id, name: 'costTimes' }],
    });
    // A reader without schema rights never learns the id or name of the trashed field.
    const editorView = await fieldAs('u_editor', costTimes.id);
    expect(editorView).toMatchObject({ compute_state: 'error' });
    expect(editorView.compute_error).toEqual({
      code: 'REF',
      refs: [{ kind: 'field', id: null, name: null }],
    });
    const list = fieldListSchema.parse(
      (await fx.call('u_sales1', 'GET', `/tables/${fx.orders.id}/fields?limit=100`)).json(),
    );
    const salesView = list.items.find((item) => item.id === costTimes.id);
    expect(salesView?.compute_error?.refs).toEqual([{ kind: 'field', id: null, name: null }]);
    // Cells read null.
    expect(await recordAs('u_admin', o1)).toMatchObject({ costTimes: null, reader: null });
    // A filter on it answers like a field that does not exist.
    expectProblem(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records/query`, {
        filter: { field: costTimes.id, operator: 'is_empty' },
      }),
      422,
      'INVALID_FILTER',
    );

    const restored = await fx.call('u_admin', 'POST', `/fields/${fx.fld.cost?.id ?? ''}/restore`);
    expect(restored.statusCode, restored.body).toBe(200);
    for (const id of [costTimes.id, reader.id]) {
      expect(await fieldAs('u_admin', id)).toMatchObject({
        compute_state: 'backfilling',
        compute_error: null,
      });
    }
    const query = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records/query`, {
      filter: { field: costTimes.id, operator: 'is_empty' },
    });
    expect(query.statusCode, query.body).toBe(200);
    expect(recordListResponseSchema.parse(query.json()).records).toBeDefined();
  });

  it('Customers in the trash: the Orders formula is REF on the table, named for base admins only', async () => {
    const deleted = await fx.call('u_admin', 'DELETE', `/tables/${fx.customers.id}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect((await fieldAs('u_admin', custName.id)).compute_error).toEqual({
      code: 'REF',
      refs: [{ kind: 'table', id: fx.customers.id, name: 'Customers' }],
    });
    expect((await fieldAs('u_editor', custName.id)).compute_error).toEqual({
      code: 'REF',
      refs: [{ kind: 'table', id: null, name: null }],
    });
    expect(await recordAs('u_admin', o1)).toMatchObject({ custName: null });
    const restored = await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/restore`);
    expect(restored.statusCode, restored.body).toBe(200);
    expect(await fieldAs('u_admin', custName.id)).toMatchObject({
      compute_state: 'backfilling',
      compute_error: null,
    });
  });
});
