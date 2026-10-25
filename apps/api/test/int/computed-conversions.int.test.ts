import {
  convertFieldPreviewSchema,
  convertFieldResponseSchema,
  fieldSchema,
  jobSchema,
  recordListResponseSchema,
  recordsResponseSchema,
  revertConversionPreviewSchema,
  type FieldDto,
  type Id,
} from '@cellhive/contracts';
import { roleConfigSchema } from '@cellhive/permissions';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  orgScope,
  SchemaService,
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

const VND = { type: 'currency', currency_code: 'VND' } as const;

/** Polls until `check` returns a value (jobs run in the worker). */
async function eventually<T>(check: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('eventually: timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * T463 over HTTP: conversions from a formula/lookup to a stored type
 * ("convert to static values") and from any type to a formula/lookup
 * (CONTRACTS §4.1), their previews (counts, samples before/after,
 * `dependents`), the `field.convert` job, the 7-day revert (the old
 * definition and values come back; `CIRCLE` when the revert closes a
 * cycle), the formula/lookup fields reading the converted field, and the
 * permission rules (schema rights `403`; invisible `404`; converting a
 * formula needs read access to its sources).
 */
describe('conversions from and to formula/lookup (T463)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let worker: WorkerHandle;
  let fx: RecordFixture;
  let customer: FieldDto;
  let ticket: FieldDto;
  let orderIds: Id<'rec'>[];
  let customerIds: Id<'rec'>[];

  function created(response: LightMyRequestResponse): FieldDto {
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  async function addField(
    tableId: Id<'tbl'>,
    name: string,
    type: string,
    options: unknown = {},
  ): Promise<FieldDto> {
    return created(
      await fx.call('u_admin', 'POST', `/tables/${tableId}/fields`, { name, type, options }),
    );
  }

  async function fieldOf(id: Id<'fld'>): Promise<FieldDto> {
    const response = await fx.call('u_admin', 'GET', `/fields/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return fieldSchema.parse(response.json());
  }

  /** Values of a field by record id (Orders unless said otherwise). */
  async function valuesOf(
    fieldId: Id<'fld'>,
    tableId: Id<'tbl'> = fx.orders.id,
  ): Promise<Record<string, unknown>> {
    const read = await fx.call(
      'u_admin',
      'GET',
      `/tables/${tableId}/records?field_key_type=id&fields=${fieldId}&limit=1000`,
    );
    expect(read.statusCode, read.body).toBe(200);
    return Object.fromEntries(
      recordListResponseSchema
        .parse(read.json())
        .records.map((record) => [record.id, record.fields[fieldId] ?? null]),
    );
  }

  async function jobDone(jobId: Id<'job'>) {
    return eventually(async () => {
      const job = jobSchema.parse((await fx.call('u_admin', 'GET', `/jobs/${jobId}`)).json());
      return job.status === 'succeeded' || job.status === 'failed' ? job : undefined;
    });
  }

  async function ready(fieldId: Id<'fld'>): Promise<FieldDto> {
    return eventually(async () => {
      const field = await fieldOf(fieldId);
      return field.compute_state === 'ready' || field.compute_state === 'error' ? field : undefined;
    });
  }

  /** `PUT` + the `field.convert` job, succeeded. */
  async function convert(fieldId: Id<'fld'>, body: Record<string, unknown>): Promise<FieldDto> {
    const response = await fx.call('u_admin', 'PUT', `/fields/${fieldId}`, body);
    expect(response.statusCode, response.body).toBe(202);
    const started = convertFieldResponseSchema.parse(response.json());
    if (started.job_id === null) throw new Error('expected a job');
    const job = await jobDone(started.job_id);
    expect(job.status, JSON.stringify(job)).toBe('succeeded');
    return fieldOf(fieldId);
  }

  async function consistency(): Promise<string[]> {
    return t.app.get(SchemaService).checkConsistency(orgScope(fx.orgId), fx.orders.id);
  }

  async function giveRole(user: 'u_out', tables: Record<string, unknown>) {
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
    fx = await buildRecordFixture(t, db);
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 100 });
    const styled = await fx.call('u_admin', 'PATCH', `/fields/${fx.fld.amount?.id ?? ''}`, {
      options: { style: VND },
    });
    expect(styled.statusCode, styled.body).toBe(200);
    customer = await addField(fx.orders.id, 'customer', 'link', { link_table: fx.customers.id });
    ticket = await addField(fx.orders.id, 'ticket', 'link', { link_table: fx.tickets.id });
    const tickets = recordsResponseSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/records`, {
          records: [{ fields: { 'Tiêu đề': 'Sửa máy' } }, { fields: { 'Tiêu đề': 'Lắp đặt' } }],
        })
      ).json(),
    ).records;
    customerIds = recordsResponseSchema
      .parse(
        (
          await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
            records: [{ fields: { Tên: 'An Phát' } }, { fields: { Tên: 'Bình Minh' } }],
          })
        ).json(),
      )
      .records.map((record) => record.id);
    const [c1, c2] = customerIds;
    const [k1, k2] = tickets.map((record) => record.id);
    const orders = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        { fields: { title: 'o1', amount: 1000, cost: 10, customer: [c1], ticket: [k1] } },
        { fields: { title: 'o2', amount: 2000, cost: 20, customer: [c1], ticket: [k2] } },
        { fields: { title: 'o3', amount: 3000, cost: 30, customer: [c2] } },
      ],
    });
    expect(orders.statusCode, orders.body).toBe(201);
    orderIds = recordsResponseSchema.parse(orders.json()).records.map((record) => record.id);
    // u_out manages Orders but cannot read `cost`.
    await giveRole('u_out', {
      [fx.orders.id]: {
        perm: 'manage',
        field_rule: { mode: 'specify', fields: { [fx.fld.cost?.id ?? '']: 'no_perm' } },
      },
      [fx.customers.id]: { perm: 'read_only' },
    });
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('formula currency → number keeps the values and the style; readers are recomputed', async () => {
    const vat = await addField(fx.orders.id, 'vat', 'formula', { expression: '[amount] * 0.1' });
    expect(vat.options).toMatchObject({ style: VND });
    const reader = await addField(fx.orders.id, 'vatPlus', 'formula', {
      expression: '[vat] + 1',
    });
    await ready(vat.id);
    await ready(reader.id);

    const preview = convertFieldPreviewSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/fields/${vat.id}/convert-preview`, { type: 'number' })
      ).json(),
    );
    expect(preview).toMatchObject({
      allowed: true,
      kind: 'keep',
      requires_confirm: false,
      affected: 3,
      lost: 0,
      truncated: 0,
      dependents: [],
    });
    expect(preview.samples).toEqual(
      expect.arrayContaining([{ record_id: orderIds[0], from: 100, to: 100, outcome: 'kept' }]),
    );

    const converted = await convert(vat.id, { type: 'number' });
    expect(converted).toMatchObject({
      type: 'number',
      options: { style: VND },
      conversion: { status: 'succeeded', from_type: 'formula', to_type: 'number' },
    });
    expect(converted.compute_mode).toBeUndefined();
    expect(await valuesOf(vat.id)).toEqual({
      [orderIds[0] as string]: 100,
      [orderIds[1] as string]: 200,
      [orderIds[2] as string]: 300,
    });
    // The value is static now: a new amount leaves it; its reader reads the static value.
    const edited = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records/${orderIds[0] ?? ''}`,
      { fields: { amount: 5000 } },
    );
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await valuesOf(vat.id))[orderIds[0] as string]).toBe(100);
    expect((await ready(reader.id)).compute_error).toBeNull();
    expect((await valuesOf(reader.id))[orderIds[0] as string]).toBe(101);
    // A cell of the static field can be written now; the reader follows.
    await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records/${orderIds[1] ?? ''}`, {
      fields: { vat: 7 },
    });
    await eventually(async () =>
      (await valuesOf(reader.id))[orderIds[1] as string] === 8 ? true : undefined,
    );

    // Revert (7 days): the formula comes back; the written cell is replaced (confirm).
    // The old column (7 days) is a known column of the table.
    expect(await consistency()).toEqual([]);
    const revertPreview = revertConversionPreviewSchema.parse(
      (await fx.call('u_admin', 'POST', `/fields/${vat.id}/revert-conversion/preview`)).json(),
    );
    expect(revertPreview).toMatchObject({
      from_type: 'formula',
      edited: 1,
      edited_unconvertible: 1,
      new_field_available: false,
    });
    expect(revertPreview.samples).toEqual([
      { record_id: orderIds[1], from: 7, to: null, outcome: 'lost' },
    ]);
    expectProblem(
      await fx.call('u_admin', 'POST', `/fields/${vat.id}/revert-conversion`, {}),
      422,
      'CONVERSION_REQUIRES_CONFIRM',
    );
    expectProblem(
      await fx.call('u_admin', 'POST', `/fields/${vat.id}/revert-conversion`, {
        mode: 'new_field',
      }),
      422,
      'CONVERSION_NOT_ALLOWED',
    );
    const reverted = await fx.call('u_admin', 'POST', `/fields/${vat.id}/revert-conversion`, {
      confirm: true,
    });
    expect(reverted.statusCode, reverted.body).toBe(200);
    expect(fieldSchema.parse(reverted.json())).toMatchObject({
      type: 'formula',
      options: { expression: '[amount] * 0.1', style: VND },
      result_type: { kind: 'number', list: false },
      conversion: null,
    });
    await ready(vat.id);
    expect(await valuesOf(vat.id)).toEqual({
      [orderIds[0] as string]: 500,
      [orderIds[1] as string]: 200,
      [orderIds[2] as string]: 300,
    });
    await eventually(async () =>
      (await valuesOf(reader.id))[orderIds[0] as string] === 501 ? true : undefined,
    );
  });

  it('text with values → formula needs confirm; the formula computes; revert gives the text back', async () => {
    const note = await addField(fx.orders.id, 'note', 'text');
    await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records`, {
      records: [
        { id: orderIds[0], fields: { note: 'giao sớm' } },
        { id: orderIds[1], fields: { note: 'gọi trước' } },
      ],
    });
    const reader = await addField(fx.orders.id, 'noteBang', 'formula', {
      expression: '[note] & "!"',
    });
    await ready(reader.id);
    const body = { type: 'formula', options: { expression: '[title] & "?"' } };
    const preview = convertFieldPreviewSchema.parse(
      (await fx.call('u_admin', 'POST', `/fields/${note.id}/convert-preview`, body)).json(),
    );
    expect(preview).toMatchObject({
      allowed: true,
      kind: 'keep',
      requires_confirm: true,
      affected: 2,
      lost: 2,
      truncated: 0,
    });
    expect(preview.samples).toEqual(
      expect.arrayContaining([
        { record_id: orderIds[0], from: 'giao sớm', to: 'o1?', outcome: 'lost' },
      ]),
    );
    const unconfirmed = await fx.call('u_admin', 'PUT', `/fields/${note.id}`, body);
    expectProblem(unconfirmed, 422, 'CONVERSION_REQUIRES_CONFIRM');
    expect((problemOf(unconfirmed.body).errors as unknown[] | undefined)?.[0]).toMatchObject({
      path: 'confirm',
      params: { lost: 2, truncated: 0 },
    });
    // A formula reading itself is a cycle.
    expectProblem(
      await fx.call('u_admin', 'PUT', `/fields/${note.id}`, {
        type: 'formula',
        options: { expression: '[note] & "x"' },
        confirm: true,
      }),
      422,
      'FORMULA_CYCLE',
    );

    const response = await fx.call('u_admin', 'PUT', `/fields/${note.id}`, {
      ...body,
      confirm: true,
    });
    expect(response.statusCode, response.body).toBe(202);
    const started = convertFieldResponseSchema.parse(response.json());
    // Until the job ends the field keeps its definition and values (SPEC §5.5).
    expect(started.field.type).toBe('text');
    await jobDone(started.job_id as Id<'job'>);
    const converted = await ready(note.id);
    expect(converted).toMatchObject({
      type: 'formula',
      options: { expression: '[title] & "?"' },
      result_type: { kind: 'text', list: false },
      compute_mode: 'stored',
      compute_error: null,
      conversion: { status: 'succeeded', from_type: 'text', to_type: 'formula' },
    });
    expect(await valuesOf(note.id)).toEqual({
      [orderIds[0] as string]: 'o1?',
      [orderIds[1] as string]: 'o2?',
      [orderIds[2] as string]: 'o3?',
    });
    await eventually(async () =>
      (await valuesOf(reader.id))[orderIds[2] as string] === 'o3?!' ? true : undefined,
    );
    // The formula follows its sources.
    await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records/${orderIds[0] ?? ''}`, {
      fields: { title: 'o1b' },
    });
    await eventually(async () =>
      (await valuesOf(note.id))[orderIds[0] as string] === 'o1b?' ? true : undefined,
    );
    // Writing a computed cell is refused (T470: 403 FIELD_READ_ONLY, like any formula cell).
    const write = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records/${orderIds[0] ?? ''}`,
      { fields: { note: 'x' } },
    );
    expectProblem(write, 403, 'FIELD_READ_ONLY');

    // The old column (7 days) is a known column of the table.
    expect(await consistency()).toEqual([]);
    const revertPreview = revertConversionPreviewSchema.parse(
      (await fx.call('u_admin', 'POST', `/fields/${note.id}/revert-conversion/preview`)).json(),
    );
    expect(revertPreview).toMatchObject({
      from_type: 'text',
      edited: 0,
      edited_unconvertible: 0,
      new_field_available: true,
    });
    const reverted = await fx.call('u_admin', 'POST', `/fields/${note.id}/revert-conversion`, {});
    expect(reverted.statusCode, reverted.body).toBe(200);
    expect(fieldSchema.parse(reverted.json())).toMatchObject({ type: 'text', conversion: null });
    expect(await valuesOf(note.id)).toEqual({
      [orderIds[0] as string]: 'giao sớm',
      [orderIds[1] as string]: 'gọi trước',
      [orderIds[2] as string]: null,
    });
    await eventually(async () =>
      (await valuesOf(reader.id))[orderIds[0] as string] === 'giao sớm!' ? true : undefined,
    );
  });

  it('lookup of a link → text: record titles (every source record, whoever converts)', async () => {
    const tickets = await addField(fx.customers.id, 'tickets', 'lookup', {
      from: fx.orders.id,
      select: ticket.id,
      where: { field: customer.id, operator: 'intersects', value: { field_ref: '__id' } },
    });
    expect(tickets.result_type).toEqual({ kind: 'record', list: true });
    await ready(tickets.id);
    const preview = convertFieldPreviewSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/fields/${tickets.id}/convert-preview`, { type: 'text' })
      ).json(),
    );
    expect(preview).toMatchObject({ allowed: true, kind: 'keep', affected: 1, lost: 0 });
    const converted = await convert(tickets.id, { type: 'text' });
    expect(converted.type).toBe('text');
    const values = await valuesOf(tickets.id, fx.customers.id);
    expect(values[customerIds[0] as string]).toBe('Sửa máy, Lắp đặt');
    expect(values[customerIds[1] as string]).toBeNull();
  });

  it('lookup → formula replaces the definition; the revert brings the lookup back', async () => {
    const total = await addField(fx.customers.id, 'total', 'lookup', {
      from: fx.orders.id,
      select: fx.fld.cost?.id,
      where: { field: customer.id, operator: 'intersects', value: { field_ref: '__id' } },
      aggregate: 'sum',
    });
    await ready(total.id);
    expect((await valuesOf(total.id, fx.customers.id))[customerIds[0] as string]).toBe(30);
    const body = { type: 'formula', options: { expression: 'LEN([Tên])' }, confirm: true };
    const converted = await convert(total.id, body);
    expect(converted).toMatchObject({ type: 'formula', result_type: { kind: 'number' } });
    await ready(total.id);
    expect((await valuesOf(total.id, fx.customers.id))[customerIds[0] as string]).toBe(7);
    const reverted = await fx.call('u_admin', 'POST', `/fields/${total.id}/revert-conversion`, {});
    expect(reverted.statusCode, reverted.body).toBe(200);
    expect(fieldSchema.parse(reverted.json())).toMatchObject({ type: 'lookup', conversion: null });
    await ready(total.id);
    expect((await valuesOf(total.id, fx.customers.id))[customerIds[0] as string]).toBe(30);
    expect(
      await t.app.get(SchemaService).checkConsistency(orgScope(fx.orgId), fx.customers.id),
    ).toEqual([]);
  });

  it('literals of the new definition stay parameters (injection)', async () => {
    const tricky = `'; DROP TABLE meta.fields; -- $1 " \\ /*`;
    const plain = await addField(fx.orders.id, 'tricky', 'text');
    const converted = await convert(plain.id, {
      type: 'formula',
      options: { expression: JSON.stringify(tricky) },
    });
    expect(converted.type).toBe('formula');
    expect(new Set(Object.values(await valuesOf(plain.id)))).toEqual(new Set([tricky]));
  });

  it('a virtual formula is computed when the job runs', async () => {
    const year = await addField(fx.orders.id, 'year', 'formula', {
      expression: 'YEAR(TODAY())',
    });
    expect(year.compute_mode).toBe('virtual');
    const converted = await convert(year.id, { type: 'number' });
    expect(converted.type).toBe('number');
    const now = new Date().getUTCFullYear();
    expect(Object.values(await valuesOf(year.id))).toEqual(
      expect.arrayContaining([expect.any(Number)]),
    );
    for (const value of Object.values(await valuesOf(year.id))) {
      expect([now - 1, now, now + 1]).toContain(value);
    }
    // Back to virtual: no column, computed on read again.
    const reverted = await fx.call('u_admin', 'POST', `/fields/${year.id}/revert-conversion`, {
      confirm: true,
    });
    expect(reverted.statusCode, reverted.body).toBe(200);
    expect(fieldSchema.parse(reverted.json())).toMatchObject({
      type: 'formula',
      compute_mode: 'virtual',
    });
  });

  it('a formula reading the converted field: INVALID_CONFIG when the type no longer fits', async () => {
    const base = await addField(fx.orders.id, 'base', 'formula', { expression: '[cost] * 2' });
    const plus = await addField(fx.orders.id, 'plus', 'formula', { expression: '[base] + 1' });
    await ready(base.id);
    await ready(plus.id);
    const preview = convertFieldPreviewSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/fields/${base.id}/convert-preview`, {
          type: 'text',
        })
      ).json(),
    );
    expect(preview.kind).toBe('keep');
    expect(preview.dependents).toEqual([
      { type: 'field', id: plus.id, table_id: fx.orders.id, name: 'plus' },
    ]);
    await convert(base.id, { type: 'text' });
    expect((await fieldOf(plus.id)).compute_error).toMatchObject({ code: 'INVALID_CONFIG' });
    // Reverting heals it.
    const reverted = await fx.call('u_admin', 'POST', `/fields/${base.id}/revert-conversion`, {});
    expect(reverted.statusCode, reverted.body).toBe(200);
    const healed = await ready(plus.id);
    expect(healed.compute_error).toBeNull();
    await eventually(async () =>
      (await valuesOf(plus.id))[orderIds[2] as string] === 61 ? true : undefined,
    );
  });

  it('a revert that closes a cycle puts every field on it in CIRCLE (T460)', async () => {
    const y = await addField(fx.orders.id, 'cy', 'formula', { expression: '[cost]' });
    const x = await addField(fx.orders.id, 'cx', 'formula', { expression: '[cy] + 1' });
    await ready(y.id);
    await ready(x.id);
    await convert(x.id, { type: 'number' });
    // x is static now: y may read it.
    const patched = await fx.call('u_admin', 'PATCH', `/fields/${y.id}`, {
      options: { expression: '[cx] * 2' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const reverted = await fx.call('u_admin', 'POST', `/fields/${x.id}/revert-conversion`, {
      confirm: true,
    });
    expect(reverted.statusCode, reverted.body).toBe(200);
    const xField = await fieldOf(x.id);
    const yField = await fieldOf(y.id);
    for (const field of [xField, yField]) {
      expect(field.compute_state).toBe('error');
      expect(field.compute_error?.code).toBe('CIRCLE');
      expect(field.compute_error?.refs.map((ref) => ref.id).sort()).toEqual([x.id, y.id].sort());
    }
    // Cells of fields in error read empty.
    expect((await valuesOf(x.id))[orderIds[0] as string]).toBeNull();
    // Breaking the cycle heals both.
    const fixed = await fx.call('u_admin', 'PATCH', `/fields/${y.id}`, {
      options: { expression: '[cost]' },
    });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect((await ready(x.id)).compute_error).toBeNull();
    expect(await consistency()).toEqual([]);
  });

  it('refuses what cannot be converted, schema rights (403), invisible fields (404)', async () => {
    const cost = await addField(fx.orders.id, 'costTimes', 'formula', {
      expression: '[cost] * 10',
    });
    const body = { type: 'number' };
    expectProblem(
      await fx.call('u_editor', 'POST', `/fields/${cost.id}/convert-preview`, body),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_editor', 'PUT', `/fields/${cost.id}`, body),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(await fx.call('stranger', 'PUT', `/fields/${cost.id}`, body), 404, 'NOT_FOUND');
    // Sales cannot see Customers: 404, never 403.
    const upper = await addField(fx.customers.id, 'upper', 'formula', {
      expression: 'UPPER([Tên])',
    });
    expectProblem(
      await fx.call('u_sales1', 'POST', `/fields/${upper.id}/convert-preview`, body),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await fx.call('u_sales1', 'POST', `/fields/${upper.id}/revert-conversion`, {}),
      404,
      'NOT_FOUND',
    );
    // u_out manages Orders but cannot read `cost`: converting a formula reading it is refused…
    expectProblem(
      await fx.call('u_out', 'POST', `/fields/${cost.id}/convert-preview`, body),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_out', 'PUT', `/fields/${cost.id}`, body),
      403,
      'PERMISSION_DENIED',
    );
    // …and so is a formula naming it (unknown, like a missing field).
    const plain = await addField(fx.orders.id, 'plain', 'number');
    const unknown = await fx.call('u_out', 'PUT', `/fields/${plain.id}`, {
      type: 'formula',
      options: { expression: '[cost] + 1' },
    });
    expect(unknown.statusCode, unknown.body).toBe(422);

    // The primary field, links and targets without a column of their own.
    const primary = convertFieldPreviewSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/fields/${fx.fld.title?.id ?? ''}/convert-preview`, {
          type: 'formula',
          options: { expression: '"x"' },
        })
      ).json(),
    );
    expect(primary).toMatchObject({ allowed: false, kind: 'forbidden' });
    expectProblem(
      await fx.call('u_admin', 'PUT', `/fields/${fx.fld.title?.id ?? ''}`, {
        type: 'formula',
        options: { expression: '"x"' },
      }),
      422,
      'CONVERSION_NOT_ALLOWED',
    );
    expectProblem(
      await fx.call('u_admin', 'PUT', `/fields/${customer.id}`, {
        type: 'formula',
        options: { expression: '"x"' },
      }),
      422,
      'CONVERSION_NOT_ALLOWED',
    );
    const toSystem = convertFieldPreviewSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/fields/${cost.id}/convert-preview`, {
          type: 'created_at',
        })
      ).json(),
    );
    expect(toSystem).toMatchObject({ allowed: false, kind: 'forbidden' });
    // Nothing leaked into the data table of another organization's request.
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM meta.field_conversions WHERE field_id = ${cost.id}
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe('0');
  });
});
