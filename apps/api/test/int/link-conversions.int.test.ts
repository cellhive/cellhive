import {
  convertFieldPreviewSchema,
  convertFieldResponseSchema,
  fieldSchema,
  jobSchema,
  recordSchema,
  recordsResponseSchema,
  revertConversionPreviewSchema,
  type FieldDto,
  type Id,
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
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { captureLogger, problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/** Polls until `check` returns a value (jobs run in the worker). */
async function eventually<T>(check: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('eventually: timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * T404 acceptance over HTTP (ADR-28, CONTRACTS §4): Orders → Customers
 * one-way → two-way (links visible at once on the Customers side, no
 * `record.updated` there), a customer with 600 orders (`over_limit`, then
 * adding is `TOO_MANY_VALUES`, removing works), two-way → one-way with a
 * dependent view (`confirm`), `revert-conversion` bringing the reverse
 * field back with its id, `allow_multiple` true → false keeping the first
 * link, schema rights on both tables (`403`/`404`) and `parent` conversions
 * refused with `CONVERSION_NOT_ALLOWED`.
 */
describe('link conversions API (T404)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let worker: WorkerHandle;
  let fx: RecordFixture;
  let customer: FieldDto;
  let c1: Id<'rec'>, c2: Id<'rec'>, big: Id<'rec'>;
  let r1: Id<'rec'>, r2: Id<'rec'>;

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  async function jobDone(jobId: Id<'job'>) {
    return eventually(async () => {
      const job = jobSchema.parse((await fx.call('u_admin', 'GET', `/jobs/${jobId}`)).json());
      return job.status === 'succeeded' || job.status === 'failed' ? job : undefined;
    });
  }

  async function getField(fieldId: Id<'fld'>): Promise<FieldDto> {
    const response = await fx.call('u_admin', 'GET', `/fields/${fieldId}`);
    expect(response.statusCode, response.body).toBe(200);
    return fieldSchema.parse(response.json());
  }

  async function cellOf(tableId: Id<'tbl'>, recordId: Id<'rec'>, fieldId: Id<'fld'>) {
    const response = await fx.call(
      'u_admin',
      'GET',
      `/tables/${tableId}/records/${recordId}?field_key_type=id`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const value = recordSchema.parse(response.json()).fields[fieldId];
    return Array.isArray(value) ? value.map((ref) => (ref as { id: string }).id) : null;
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

  async function customerEvents(): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM meta.events
       WHERE organization_id = ${fx.orgId} AND type = 'record.updated'
         AND entity_id = ANY(${[c1, c2, big]}::text[])
    `.execute(db.kysely);
    return Number(rows[0]?.n ?? 0);
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 100 });
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'customer',
      type: 'link',
      options: { link_table: fx.customers.id },
    });
    expect(created.statusCode, created.body).toBe(201);
    customer = fieldSchema.parse(created.json());
    [c1, c2, big] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
        records: [
          { fields: { Tên: 'An Phát' } },
          { fields: { Tên: 'Bình Minh' } },
          { fields: { Tên: 'Lớn' } },
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
    [r1, r2] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: [
          { fields: { title: 'r1', customer: [c1] } },
          { fields: { title: 'r2', customer: [c2, c1] } },
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>];
    // The big customer has 600 orders (ADR-28 §4: over the 500 cap once two-way).
    records(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: Array.from({ length: 600 }, (_, index) => ({
          fields: { title: `bulk ${String(index)}`, customer: [big] },
        })),
      }),
    );
    // u_out manages Orders and reads Customers; u_sales2 manages Orders, no Customers.
    await giveRole('u_out', {
      [fx.orders.id]: { perm: 'manage' },
      [fx.customers.id]: { perm: 'read_only' },
    });
    await giveRole('u_sales2', { [fx.orders.id]: { perm: 'manage' } });
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('two-way needs schema rights on both tables: 403 when Customers is readable, 404 when not', async () => {
    const body = {
      type: 'link',
      options: { bidirectional: true, bidirectional_link_field_name: 'Đơn hàng' },
    };
    expectProblem(
      await fx.call('u_out', 'POST', `/fields/${customer.id}/convert-preview`, body),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_out', 'PUT', `/fields/${customer.id}`, body),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_sales2', 'PUT', `/fields/${customer.id}`, body),
      404,
      'NOT_FOUND',
    );
    // Record editors have no schema rights at all.
    expectProblem(
      await fx.call('u_editor', 'POST', `/fields/${customer.id}/convert-preview`, body),
      403,
      'PERMISSION_DENIED',
    );
  });

  it('one-way → two-way: preview counts over_limit, the reverse field shows every link at once', async () => {
    const preview = convertFieldPreviewSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/fields/${customer.id}/convert-preview`, {
          type: 'link',
          options: { bidirectional: true },
        })
      ).json(),
    );
    expect(preview).toMatchObject({
      allowed: true,
      kind: 'keep',
      requires_confirm: false,
      over_limit: 1,
      over_limit_samples: [{ record_id: big, links: 600 }],
      link_change: {
        change: 'to_two_way',
        partner_table_id: fx.customers.id,
        partner_field_id: null,
      },
    });
    // The reverse field's name is required on PUT.
    const unnamed = await fx.call('u_admin', 'PUT', `/fields/${customer.id}`, {
      type: 'link',
      options: { bidirectional: true },
    });
    expectProblem(unnamed, 422, 'VALIDATION_FAILED');
    expect((problemOf(unnamed.body).errors as unknown[] | undefined)?.[0]).toMatchObject({
      path: 'options.bidirectional_link_field_name',
      code: 'REQUIRED',
    });
    // A name already used in Customers → 409.
    expectProblem(
      await fx.call('u_admin', 'PUT', `/fields/${customer.id}`, {
        type: 'link',
        options: { bidirectional: true, bidirectional_link_field_name: 'Mã khách hàng' },
      }),
      409,
      'NAME_CONFLICT',
    );

    const eventsBefore = await customerEvents();
    const put = await fx.call('u_admin', 'PUT', `/fields/${customer.id}`, {
      type: 'link',
      options: { bidirectional: true, bidirectional_link_field_name: 'Đơn hàng' },
    });
    expect(put.statusCode, put.body).toBe(202);
    const started = convertFieldResponseSchema.parse(put.json());
    expect(started.field.conversion).toMatchObject({
      status: 'running',
      link_change: 'to_two_way',
    });
    expect((await jobDone(started.job_id as Id<'job'>)).status).toBe('succeeded');

    const converted = await getField(customer.id);
    expect(converted.options).toMatchObject({
      bidirectional: true,
      bidirectional_link_field_name: 'Đơn hàng',
    });
    const reverseId = converted.options.symmetric_field_id as Id<'fld'>;
    const reverse = await getField(reverseId);
    expect(reverse).toMatchObject({
      table_id: fx.customers.id,
      name: 'Đơn hàng',
      type: 'link',
      options: { link_table: fx.orders.id, symmetric_field_id: customer.id, allow_multiple: true },
    });
    expect(await cellOf(fx.customers.id, c1, reverseId)).toEqual([r1, r2]);
    expect(await cellOf(fx.customers.id, c2, reverseId)).toEqual([r2]);
    expect((await cellOf(fx.customers.id, big, reverseId))?.length).toBe(600);
    // No record event on the Customers side (the data did not change).
    expect(await customerEvents()).toBe(eventsBefore);

    // The cell over 500 keeps its links: adding one more is refused, removing works.
    const [extra] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: [{ fields: { title: 'extra' } }],
      }),
    ).map((record) => record.id) as [Id<'rec'>];
    const tooMany = await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records`, {
      records: [{ id: extra, fields: { customer: [big] } }],
    });
    expectProblem(tooMany, 422, 'INVALID_CELL_VALUE');
    expect((problemOf(tooMany.body).errors as unknown[] | undefined)?.[0]).toMatchObject({
      code: 'TOO_MANY_VALUES',
      params: { limit: 500, record_id: big },
    });
    const bigOrders = (await cellOf(fx.customers.id, big, reverseId)) as Id<'rec'>[];
    const removed = await fx.call('u_admin', 'PATCH', `/tables/${fx.customers.id}/records`, {
      records: [{ id: big, fields: { 'Đơn hàng': bigOrders.slice(1) } }],
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await cellOf(fx.customers.id, big, reverseId))?.length).toBe(599);
  });

  it('two-way → one-way lists a view using the reverse field, needs confirm, reverts to the same id', async () => {
    const reverseId = (await getField(customer.id)).options.symmetric_field_id as Id<'fld'>;
    // A Customers view filtering on the reverse field (links cannot be grouped, CONTRACTS §1.4).
    const view = await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/views`, {
      name: 'With orders',
      type: 'grid',
      config: {
        filter: { op: 'and', items: [{ field: reverseId, operator: 'is_not_empty' }] },
      },
    });
    expect(view.statusCode, view.body).toBe(201);
    const viewId = view.json<{ id: Id<'viw'> }>().id;
    const body = { type: 'link', options: { bidirectional: false } };
    const preview = convertFieldPreviewSchema.parse(
      (await fx.call('u_admin', 'POST', `/fields/${customer.id}/convert-preview`, body)).json(),
    );
    expect(preview).toMatchObject({
      allowed: true,
      kind: 'keep',
      requires_confirm: true,
      dependents: [{ type: 'view', id: viewId }],
      link_change: { change: 'to_one_way', partner_field_id: reverseId },
    });
    const unconfirmed = await fx.call('u_admin', 'PUT', `/fields/${customer.id}`, body);
    expectProblem(unconfirmed, 422, 'CONVERSION_REQUIRES_CONFIRM');
    const put = await fx.call('u_admin', 'PUT', `/fields/${customer.id}`, {
      ...body,
      confirm: true,
    });
    expect(put.statusCode, put.body).toBe(202);
    const started = convertFieldResponseSchema.parse(put.json());
    await jobDone(started.job_id as Id<'job'>);
    expect((await getField(customer.id)).options).toMatchObject({
      bidirectional: false,
      symmetric_field_id: null,
    });
    expectProblem(await fx.call('u_admin', 'GET', `/fields/${reverseId}`), 404, 'NOT_FOUND');
    // Data of the kept side is untouched.
    expect(await cellOf(fx.orders.id, r2, customer.id)).toEqual([c2, c1]);

    const revertPreview = revertConversionPreviewSchema.parse(
      (await fx.call('u_admin', 'POST', `/fields/${customer.id}/revert-conversion/preview`)).json(),
    );
    expect(revertPreview).toMatchObject({
      from_type: 'link',
      new_field_available: false,
      link_change: { change: 'to_one_way', partner_field_id: reverseId },
    });
    const reverted = await fx.call(
      'u_admin',
      'POST',
      `/fields/${customer.id}/revert-conversion`,
      {},
    );
    expect(reverted.statusCode, reverted.body).toBe(200);
    expect(fieldSchema.parse(reverted.json()).options).toMatchObject({
      bidirectional: true,
      symmetric_field_id: reverseId,
    });
    const back = await getField(reverseId);
    expect(back.options).toMatchObject({ symmetric_field_id: customer.id });
    expect(await cellOf(fx.customers.id, c1, reverseId)).toEqual([r1, r2]);
    // Reverted once: nothing left to revert.
    expectProblem(
      await fx.call('u_admin', 'POST', `/fields/${customer.id}/revert-conversion`, {}),
      404,
      'NOT_FOUND',
    );
  });

  it('allow_multiple true → false keeps the first link by position (confirm, truncated counts)', async () => {
    const body = { type: 'link', options: { allow_multiple: false } };
    const preview = convertFieldPreviewSchema.parse(
      (await fx.call('u_admin', 'POST', `/fields/${customer.id}/convert-preview`, body)).json(),
    );
    expect(preview).toMatchObject({
      allowed: true,
      kind: 'truncate',
      requires_confirm: true,
      truncated: 1,
      samples: [
        {
          record_id: r2,
          from: [
            { id: c2, title: 'Bình Minh' },
            { id: c1, title: 'An Phát' },
          ],
          to: [{ id: c2, title: 'Bình Minh' }],
          outcome: 'truncated',
        },
      ],
    });
    expectProblem(
      await fx.call('u_admin', 'PUT', `/fields/${customer.id}`, body),
      422,
      'CONVERSION_REQUIRES_CONFIRM',
    );
    const put = await fx.call('u_admin', 'PUT', `/fields/${customer.id}`, {
      ...body,
      confirm: true,
    });
    expect(put.statusCode, put.body).toBe(202);
    const job = await jobDone(convertFieldResponseSchema.parse(put.json()).job_id as Id<'job'>);
    expect(job.status).toBe('succeeded');
    expect(await cellOf(fx.orders.id, r2, customer.id)).toEqual([c2]);
    expect(await cellOf(fx.orders.id, r1, customer.id)).toEqual([c1]);
    expect((await getField(customer.id)).options).toMatchObject({ allow_multiple: false });
    // The cut record has one audit entry (link changes are not in record history yet, T402).
    const { rows: audits } = await sql<{ entity_id: string; before: unknown; after: unknown }>`
      SELECT entity_id, before, after FROM meta.audit_logs
       WHERE organization_id = ${fx.orgId} AND action = 'record.updated' AND batch_id = ${job.id}
    `.execute(db.kysely);
    expect(audits).toEqual([
      { entity_id: r2, before: { [customer.id]: [c2, c1] }, after: { [customer.id]: [c2] } },
    ]);

    const reverted = await fx.call(
      'u_admin',
      'POST',
      `/fields/${customer.id}/revert-conversion`,
      {},
    );
    expect(reverted.statusCode, reverted.body).toBe(200);
    expect(await cellOf(fx.orders.id, r2, customer.id)).toEqual([c2, c1]);
  });

  it('refuses link ↔ other types, several changes at once, and PATCH conversions', async () => {
    expectProblem(
      await fx.call('u_admin', 'PUT', `/fields/${customer.id}`, { type: 'text' }),
      422,
      'CONVERSION_NOT_ALLOWED',
    );
    const toLink = await fx.call(
      'u_admin',
      'POST',
      `/fields/${String(fx.fld.customerCode?.id)}/convert-preview`,
      {
        type: 'link',
        options: { link_table: fx.orders.id },
      },
    );
    expect(convertFieldPreviewSchema.parse(toLink.json())).toMatchObject({
      allowed: false,
      reason: 'CONVERSION_NOT_ALLOWED',
      kind: 'forbidden',
    });
    const both = await fx.call('u_admin', 'PUT', `/fields/${customer.id}`, {
      type: 'link',
      options: { bidirectional: false, allow_multiple: false, link_table: fx.tickets.id },
    });
    expectProblem(both, 422, 'CONVERSION_NOT_ALLOWED');
    expectProblem(
      await fx.call('u_admin', 'PATCH', `/fields/${customer.id}`, {
        options: { bidirectional: false },
      }),
      422,
      'CONVERSION_NOT_ALLOWED',
    );
  });

  it('a parent field converts nowhere: CONVERSION_NOT_ALLOWED like links', async () => {
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/fields`, {
      name: 'Parent',
      type: 'parent',
    });
    expect(created.statusCode, created.body).toBe(201);
    const parent = fieldSchema.parse(created.json());
    expectProblem(
      await fx.call('u_admin', 'PUT', `/fields/${parent.id}`, { type: 'text' }),
      422,
      'CONVERSION_NOT_ALLOWED',
    );
    expectProblem(
      await fx.call('u_admin', 'PUT', `/fields/${String(fx.fld.ticketTitle?.id)}`, {
        type: 'parent',
      }),
      422,
      'CONVERSION_NOT_ALLOWED',
    );
  });
});
