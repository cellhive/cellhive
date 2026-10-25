import {
  computedPreviewResponseSchema,
  fieldListSchema,
  fieldSchema,
  recordsResponseSchema,
  updateFieldResponseSchema,
  type FieldDto,
} from '@cellhive/contracts';
import { roleConfigSchema } from '@cellhive/permissions';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type JsonObject,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const VND = { type: 'currency', currency_code: 'VND' };

/**
 * T456 over HTTP: formula and lookup fields (create, read, change),
 * permission-aware name resolution (S§9.5: what the saver cannot read does
 * not exist), who sees the definition (BACKLOG S4b #1c), schema rights
 * (u_editor 403, a `no_perm` table 404), cycles, the per-base limit and the
 * preview endpoint (values on the first 5 readable records).
 */
describe('formula and lookup fields over HTTP (T456)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let customer: FieldDto;
  let orderIds: string[] = [];
  let customerIds: string[] = [];

  function created(response: LightMyRequestResponse): FieldDto {
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  function errorsOf(response: LightMyRequestResponse) {
    return problemOf(response.body).errors as {
      path: string;
      code: string;
      params?: Record<string, unknown>;
    }[];
  }

  /** Custom role of the fixture base, assigned to `user`. */
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
    t = await startTestApp({ DATABASE_URL: database.url, COMPUTED_FIELDS_MAX_PER_BASE: '200' });
    fx = await buildRecordFixture(t, db);
    customer = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'customer',
        type: 'link',
        options: { link_table: fx.customers.id },
      }),
    );
    // Style of amount: VND currency (the style a formula result carries).
    const styled = await fx.call('u_admin', 'PATCH', `/fields/${fx.fld.amount?.id ?? ''}`, {
      options: { style: VND },
    });
    expect(styled.statusCode, styled.body).toBe(200);
    const customers = recordsResponseSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
          records: [{ fields: { Tên: 'An Phát' } }, { fields: { Tên: 'Bình Minh' } }],
        })
      ).json(),
    ).records;
    customerIds = customers.map((record) => record.id);
    const [c1, c2] = customerIds;
    const orders = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        { fields: { title: 'o1', amount: 1000000, cost: 10, status: 'Xong', customer: [c1] } },
        { fields: { title: 'o2', amount: 500000, cost: 20, status: 'Xong', customer: [c1] } },
        { fields: { title: 'o3', amount: 300000, cost: 30, status: 'Mới', customer: [c2] } },
      ],
    });
    expect(orders.statusCode, orders.body).toBe(201);
    orderIds = recordsResponseSchema.parse(orders.json()).records.map((record) => record.id);
    // u_out manages Orders but cannot read `cost`; reads Customers.
    await giveRole('u_out', {
      [fx.orders.id]: {
        perm: 'manage',
        field_rule: { mode: 'specify', fields: { [fx.fld.cost?.id ?? '']: 'no_perm' } },
      },
      [fx.customers.id]: { perm: 'read_only' },
    });
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('creates a stored formula: display form, number result, currency style, backfilling', async () => {
    const field = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'Hoa hồng',
        type: 'formula',
        options: { expression: 'IF([status]="Xong",[amount]*0.1,0)' },
      }),
    );
    expect(field).toMatchObject({
      type: 'formula',
      options: { expression: 'IF([status] = "Xong", [amount] * 0.1, 0)', style: VND },
      result_type: { kind: 'number', list: false },
      compute_mode: 'stored',
      compute_state: 'backfilling',
      compute_error: null,
      required: false,
      unique_values: false,
    });
    // Renaming a referenced field never breaks it: the stored form has ids.
    const renamed = await fx.call('u_admin', 'PATCH', `/fields/${fx.fld.status?.id ?? ''}`, {
      name: 'Trạng thái',
    });
    expect(renamed.statusCode).toBe(200);
    const read = fieldSchema.parse((await fx.call('u_admin', 'GET', `/fields/${field.id}`)).json());
    expect(read.options).toMatchObject({
      expression: 'IF([Trạng thái] = "Xong", [amount] * 0.1, 0)',
    });
    await fx.call('u_admin', 'PATCH', `/fields/${fx.fld.status?.id ?? ''}`, { name: 'status' });
  });

  it('TODAY() → virtual, ready at once', async () => {
    const field = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'Hôm nay',
        type: 'formula',
        options: { expression: 'TODAY()' },
      }),
    );
    expect(field).toMatchObject({
      compute_mode: 'virtual',
      compute_state: 'ready',
      result_type: { kind: 'date', list: false },
    });
  });

  it('lookup sum of Orders.amount through customer, with a currency style', async () => {
    const field = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/fields`, {
        name: 'Tổng tiền',
        type: 'lookup',
        options: {
          from: fx.orders.id,
          select: fx.fld.amount?.id,
          where: { field: customer.id, operator: 'intersects', value: { field_ref: '__id' } },
          aggregate: 'sum',
          style: VND,
        },
      }),
    );
    expect(field).toMatchObject({
      options: { from: fx.orders.id, select: fx.fld.amount?.id, aggregate: 'sum', style: VND },
      result_type: { kind: 'number', list: false },
      compute_mode: 'stored',
    });
    // The preview computes the sums with the caller's read scope.
    const preview = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.customers.id}/computed-preview`,
      {
        type: 'lookup',
        options: {
          from: fx.orders.id,
          select: fx.fld.amount?.id,
          where: { field: customer.id, operator: 'intersects', value: { field_ref: '__id' } },
          aggregate: 'sum',
        },
      },
    );
    expect(preview.statusCode, preview.body).toBe(200);
    expect(computedPreviewResponseSchema.parse(preview.json())).toMatchObject({
      result_type: { kind: 'number', list: false },
      compute_mode: 'stored',
      style: VND,
      perf_warning: null,
      records: [{ value: 1500000 }, { value: 300000 }],
    });
  });

  it('lookup through the one-way link of this table (__id is_any_of field_ref, T467)', async () => {
    const options = {
      from: fx.customers.id,
      select: fx.customers.primary_field_id,
      where: { field: '__id', operator: 'is_any_of', value: { field_ref: customer.id } },
    };
    const preview = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/computed-preview`, {
      type: 'lookup',
      options,
      record_ids: orderIds,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(computedPreviewResponseSchema.parse(preview.json())).toMatchObject({
      result_type: { kind: 'text', list: true },
      compute_mode: 'stored',
      records: [{ value: ['An Phát'] }, { value: ['An Phát'] }, { value: ['Bình Minh'] }],
    });
    const field = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'Tên khách',
        type: 'lookup',
        options,
      }),
    );
    expect(field.options).toMatchObject({ where: options.where });
    // Relinking o3 to An Phát recomputes it (a via_link dependency, T458).
    const relinked = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records/${orderIds[2] ?? ''}`,
      { fields: { customer: [customerIds[0]] } },
    );
    expect(relinked.statusCode, relinked.body).toBe(200);
    const read = await fx.call(
      'u_admin',
      'GET',
      `/tables/${fx.orders.id}/records/${orderIds[2] ?? ''}?field_key_type=id`,
    );
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<{ fields: Record<string, unknown> }>().fields[field.id]).toEqual(['An Phát']);
    // A field of this table that is not a link to the source table is refused.
    const wrong = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/computed-preview`, {
      type: 'lookup',
      options: {
        ...options,
        where: { field: '__id', operator: 'is_any_of', value: { field_ref: fx.fld.amount?.id } },
      },
    });
    expectProblem(wrong, 422, 'FORMULA_TYPE_ERROR');
    expect(errorsOf(wrong)[0]).toMatchObject({
      code: 'INVALID_LOOKUP',
      path: 'options.where.value.field_ref',
    });
  });

  it('schema rights: u_editor 403, a table the caller cannot see 404', async () => {
    const body = { name: 'x', type: 'formula', options: { expression: '1 + 1' } };
    expectProblem(
      await fx.call('u_editor', 'POST', `/tables/${fx.orders.id}/fields`, body),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_sales1', 'POST', `/tables/${fx.customers.id}/fields`, body),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await fx.call('u_editor', 'POST', `/tables/${fx.orders.id}/computed-preview`, {
        type: 'formula',
        options: { expression: '1' },
      }),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_sales1', 'POST', `/tables/${fx.customers.id}/computed-preview`, {
        type: 'formula',
        options: { expression: '1' },
      }),
      404,
      'NOT_FOUND',
    );
  });

  it('a manager who cannot read cost saving a formula with cost → UNKNOWN_FIELD at its position', async () => {
    const response = await fx.call('u_out', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'Lãi',
      type: 'formula',
      options: { expression: '[amount] - [cost]' },
    });
    expectProblem(response, 422, 'FORMULA_SYNTAX_ERROR');
    expect(errorsOf(response)[0]).toMatchObject({
      path: 'options.expression',
      code: 'UNKNOWN_FIELD',
      params: { position: { start: 11, length: 6 } },
    });
    // The same formula exists (the admin can read cost): its definition is not given to u_out.
    const profit = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'Lãi',
        type: 'formula',
        options: { expression: '[amount] - [cost]' },
      }),
    );
    const seen = fieldSchema.parse((await fx.call('u_out', 'GET', `/fields/${profit.id}`)).json());
    expect(seen.options).toEqual({ style: VND });
    expect(JSON.stringify(seen)).not.toContain(fx.fld.cost?.id ?? 'x');
    expect(seen).toMatchObject({ result_type: { kind: 'number', list: false } });
    // Nor to readers without schema rights (u_reader), even when they read every field.
    const listed = fieldListSchema.parse(
      (await fx.call('u_reader', 'GET', `/tables/${fx.orders.id}/fields`)).json(),
    );
    const readerView = listed.items.find((item) => item.id === profit.id);
    expect(readerView?.options).toEqual({ style: VND });
    // u_out cannot change it either (would have to read cost).
    const change = await fx.call('u_out', 'PATCH', `/fields/${profit.id}`, {
      options: { style: null },
    });
    expectProblem(change, 422, 'FORMULA_SYNTAX_ERROR');
  });

  it('syntax and limit errors carry positions; unsupported functions are named', async () => {
    const syntax = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/computed-preview`, {
      type: 'formula',
      options: { expression: '[amount] +* 2' },
    });
    expectProblem(syntax, 422, 'FORMULA_SYNTAX_ERROR');
    expect(errorsOf(syntax)[0]).toMatchObject({
      code: 'UNEXPECTED_TOKEN',
      params: { position: { start: 10, length: 1 } },
    });
    const phase2 = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'r',
      type: 'formula',
      options: { expression: 'RANDOMBETWEEN(1, 2)' },
    });
    expectProblem(phase2, 422, 'FORMULA_SYNTAX_ERROR');
    expect(errorsOf(phase2)[0]?.code).toBe('UNSUPPORTED_FUNCTION');
    const long = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/computed-preview`, {
      type: 'formula',
      options: { expression: `${'1 + '.repeat(1000)}1` },
    });
    expectProblem(long, 422, 'FORMULA_LIMIT_EXCEEDED');
    expect(errorsOf(long)[0]).toMatchObject({ code: 'MAX_LENGTH', params: { limit: 4000 } });
  });

  it('a formula whose SQL would explode → FORMULA_LIMIT_EXCEEDED / MAX_COMPILED_SIZE everywhere', async () => {
    // 286 characters; each LET variable used three times → 3^14 copies of [title].
    const parts = ['a0, [title]'];
    for (let i = 1; i <= 14; i += 1) {
      parts.push(`a${String(i)}, a${String(i - 1)} & a${String(i - 1)} & a${String(i - 1)}`);
    }
    const expression = `LET(${parts.join(', ')}, a14)`;
    const nestedIfBlank = Array.from({ length: 15 }).reduce<string>(
      (inner) => `IFBLANK(${inner}, "x")`,
      '[title]',
    );
    const expectTooLarge = (response: Awaited<ReturnType<typeof fx.call>>) => {
      expectProblem(response, 422, 'FORMULA_LIMIT_EXCEEDED');
      expect(errorsOf(response)[0]).toMatchObject({
        path: 'options.expression',
        code: 'MAX_COMPILED_SIZE',
        params: { limit: 524288, unit: 'bytes', position: { start: 0, length: 0 } },
      });
    };
    for (const formula of [expression, nestedIfBlank]) {
      const started = performance.now();
      expectTooLarge(
        await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/computed-preview`, {
          type: 'formula',
          options: { expression: formula },
        }),
      );
      expect(performance.now() - started).toBeLessThan(2000);
    }
    expectTooLarge(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'explode',
        type: 'formula',
        options: { expression },
      }),
    );
    const fine = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'fine',
        type: 'formula',
        options: { expression: 'LET(a, [title], a & a)' },
      }),
    );
    expectTooLarge(
      await fx.call('u_admin', 'PATCH', `/fields/${fine.id}`, { options: { expression } }),
    );
    const scratch = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'scratch',
        type: 'text',
      }),
    );
    expectTooLarge(
      await fx.call('u_admin', 'PUT', `/fields/${scratch.id}`, {
        type: 'formula',
        options: { expression },
        confirm: true,
      }),
    );
    expectTooLarge(
      await fx.call('u_admin', 'POST', `/fields/${scratch.id}/convert-preview`, {
        type: 'formula',
        options: { expression },
      }),
    );
  });

  it('preview: values of the first 5 readable records, errors per row are null', async () => {
    const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/computed-preview`, {
      type: 'formula',
      options: { expression: '[amount] / ([cost] - 10)' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const preview = computedPreviewResponseSchema.parse(response.json());
    expect(preview.records.map((record) => record.value)).toEqual([null, 50000, 15000]);
    const sales = await fx.call('u_sales1', 'POST', `/tables/${fx.orders.id}/computed-preview`, {
      type: 'formula',
      options: { expression: '[amount]' },
    });
    // u_sales1 has `edit`, not `manage`, on Orders: previews need schema rights.
    expectProblem(sales, 403, 'PERMISSION_DENIED');
  });

  it('PATCH: a new expression is re-analysed; a cycle through a two-way link → FORMULA_CYCLE', async () => {
    const link = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'buyer',
        type: 'link',
        options: {
          link_table: fx.customers.id,
          bidirectional: true,
          bidirectional_link_field_name: 'bought',
        },
      }),
    );
    expect(link.type).toBe('link');
    const b = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'B',
        type: 'formula',
        options: { expression: '[buyer].[Tên].ARRAYJOIN()' },
      }),
    );
    const a = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/fields`, {
        name: 'A',
        type: 'formula',
        options: { expression: '[bought].[B].ARRAYJOIN()' },
      }),
    );
    const cycle = await fx.call('u_admin', 'PATCH', `/fields/${b.id}`, {
      options: { expression: '[buyer].[A].ARRAYJOIN()' },
    });
    expectProblem(cycle, 422, 'FORMULA_CYCLE');
    expect(errorsOf(cycle)[0]).toMatchObject({
      code: 'CIRCULAR_REFERENCE',
      params: {
        cycle: [
          { id: b.id, name: 'B' },
          { id: a.id, name: 'A' },
          { id: b.id, name: 'B' },
        ],
      },
    });
    const ok = await fx.call('u_admin', 'PATCH', `/fields/${b.id}`, {
      options: { expression: '[buyer].COUNTA()' },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const updated = updateFieldResponseSchema.parse(ok.json());
    expect(updated).toMatchObject({
      options: { expression: '[buyer].COUNTA()' },
      result_type: { kind: 'number', list: false },
      compute_state: 'backfilling',
    });
    expect(updated.job_id).toMatch(/^job_/);
    // A reads B: same type (ARRAYJOIN gives text), recomputed after B.
    const readerOfB = fieldSchema.parse(
      (await fx.call('u_admin', 'GET', `/fields/${a.id}`)).json(),
    );
    expect(readerOfB.compute_state).toBe('backfilling');
  });

  it('the 201st formula or lookup of a base → FORMULA_LIMIT_EXCEEDED', async () => {
    const scope = orgScope(fx.orgId);
    const schema = t.app.get(SchemaService);
    const existing = await db.kysely
      .selectFrom('meta.fields')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('organization_id', '=', fx.orgId)
      .where('type', 'in', ['formula', 'lookup'])
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    for (let index = Number(existing.n); index < 200; index += 1) {
      await schema.addField(
        scope,
        fx.tickets.id,
        { name: `v${String(index)}`, type: 'formula', options: { expression: 'TODAY()' } },
        systemAuditContext(),
      );
    }
    const over = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'one too many',
      type: 'formula',
      options: { expression: '1' },
    });
    expectProblem(over, 422, 'FORMULA_LIMIT_EXCEEDED');
    expect(errorsOf(over)[0]).toMatchObject({
      code: 'MAX_COMPUTED_FIELDS',
      params: { limit: 200 },
    });
  });
});
