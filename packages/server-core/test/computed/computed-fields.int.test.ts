import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ComputeModel,
  FieldDependenciesRepository,
  loadBaseSchemaRows,
  type SchemaReadability,
} from '../../src/computed/index.js';
import { orgScope, withTxScope, type Db, type OrgScope } from '../../src/db/index.js';
import { isAppError } from '../../src/errors/index.js';
import { RecordMutationService } from '../../src/records/index.js';
import { SchemaService, usedColumnSlots, type CreatedTable } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { expectConsistent, physicalColumns, queuedJobs, userContext } from '../support/schema.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { FieldRow } from '../../src/db/schema.js';

const ORG_A = 'org_ComputedFldOrgA1';
const ORG_B = 'org_ComputedFldOrgB1';

const VND = { type: 'currency', currency_code: 'VND' };

/**
 * T456 at the service level: formula/lookup definitions (display form in,
 * stored form in meta), the dependency graph, stored columns (types,
 * slots, compaction), the backfill batches, cycles, limits and what the
 * saver may reference — on PostgreSQL 18 with the real migrator.
 */
describe('computed fields: SchemaService + backfill (T456)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let records: RecordMutationService;
  let tenant: SeededTenant;
  let scope: OrgScope;
  let orders: CreatedTable;
  let customers: CreatedTable;
  const fld: Record<string, FieldRow> = {};
  const rec = {
    c1: newId('rec'),
    c2: newId('rec'),
    o1: newId('rec'),
    o2: newId('rec'),
    o3: newId('rec'),
  };

  const ctx = () => userContext(tenant.userId);

  async function problem(promise: Promise<unknown>): Promise<{
    code: string;
    errors: readonly { path: string; code: string; params?: Record<string, unknown> | undefined }[];
  }> {
    try {
      await promise;
    } catch (error) {
      if (isAppError(error)) return { code: error.code, errors: error.errors ?? [] };
      throw error;
    }
    throw new Error('expected an error');
  }

  const formula = (
    table: CreatedTable,
    name: string,
    expression: string,
    extra: Record<string, unknown> = {},
    readable?: SchemaReadability,
  ) =>
    schema.addField(
      scope,
      table.table.id,
      {
        name,
        type: 'formula',
        options: { expression, ...extra },
        computed: { timeZone: 'Asia/Ho_Chi_Minh', ...(readable === undefined ? {} : { readable }) },
      },
      ctx(),
    );

  /** Runs every batch of the backfill of `field` (what the job does per field). */
  async function backfill(field: FieldRow, batch = 2): Promise<number> {
    let cursor = 0n;
    let rows = 0;
    for (;;) {
      const result = await records.backfillComputedBatch(scope, {
        fieldId: field.id,
        afterAuto: cursor,
        limit: batch,
        statementTimeoutMs: 30_000,
      });
      if (result.status !== 'more' && result.status !== 'done') return rows;
      rows += result.rows;
      cursor = result.cursor;
      if (result.status === 'done') break;
    }
    await schema.finishComputedBackfill(scope, field.id, { status: 'ready' });
    return rows;
  }

  async function values(table: CreatedTable, field: FieldRow): Promise<Record<string, unknown>> {
    const current = await db.kysely
      .selectFrom('meta.fields')
      .selectAll()
      .where('id', '=', field.id)
      .executeTakeFirstOrThrow();
    const column = current.db_column_name;
    if (column === null) throw new Error('no column');
    const { rows } = await sql<{ id: string; v: unknown }>`
      SELECT __id AS id, ${sql.id(column)} AS v FROM ${sql.id('data', table.table.db_table_name)}
    `.execute(db.kysely);
    return Object.fromEntries(rows.map((row) => [row.id, row.v]));
  }

  async function meta(field: FieldRow): Promise<FieldRow> {
    return db.kysely
      .selectFrom('meta.fields')
      .selectAll()
      .where('id', '=', field.id)
      .executeTakeFirstOrThrow();
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    tenant = await seedTenant(db, ORG_A, { collation: 'vi-VN-x-icu' });
    await seedTenant(db, ORG_B);
    scope = orgScope(ORG_A);
    schema = new SchemaService(db, { maxFieldsPerTable: 500, maxComputedFieldsPerBase: 12 });
    records = new RecordMutationService(db, { schema, defaultTimeZone: 'UTC' });
    customers = await schema.createTable(
      scope,
      { baseId: tenant.baseId, name: 'Customers', primaryFieldName: 'Tên' },
      ctx(),
    );
    orders = await schema.createTable(
      scope,
      { baseId: tenant.baseId, name: 'Orders', primaryFieldName: 'title' },
      ctx(),
    );
    const add = (table: CreatedTable, name: string, type: string, options: unknown = {}) =>
      schema.addField(scope, table.table.id, { name, type, options }, ctx());
    fld.amount = await add(orders, 'Số tiền', 'number', { style: VND });
    fld.cost = await add(orders, 'cost', 'number');
    fld.status = await add(orders, 'Trạng thái', 'select', {
      options: [
        { id: 'opt_New0000000000000', name: 'Mới' },
        { id: 'opt_Done000000000000', name: 'Xong' },
      ],
    });
    fld.customer = await add(orders, 'Khách hàng', 'link', {
      link_table: customers.table.id,
    });
    fld.code = await add(customers, 'Mã', 'text');

    const data = (table: CreatedTable) => sql.id('data', table.table.db_table_name);
    const col = (field: FieldRow) => sql.id(field.db_column_name ?? '');
    const cName = sql.id(customers.primaryField.db_column_name ?? '');
    await sql`INSERT INTO ${data(customers)} (__id, ${cName}, ${col(fld.code)}) VALUES
      (${rec.c1}, 'An Phát', 'K1'), (${rec.c2}, 'Bình Minh', 'K2')`.execute(db.kysely);
    const title = sql.id(orders.primaryField.db_column_name ?? '');
    await sql`INSERT INTO ${data(orders)} (__id, ${title}, ${col(fld.amount)}, ${col(fld.cost)}, ${col(fld.status)}) VALUES
      (${rec.o1}, 'o1', 1000000, 200, ARRAY['opt_Done000000000000']),
      (${rec.o2}, 'o2', 500000, 100, ARRAY['opt_Done000000000000']),
      (${rec.o3}, 'o3', 300000, 50, ARRAY['opt_New0000000000000'])`.execute(db.kysely);
    const junction = sql.id('data', fld.customer.link_junction ?? '');
    await sql`INSERT INTO ${junction} (a_id, b_id, position) VALUES
      (${rec.o1}, ${rec.c1}, 0), (${rec.o2}, ${rec.c1}, 0), (${rec.o3}, ${rec.c2}, 0)`.execute(
      db.kysely,
    );
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('stored formula: stored form, number column, currency style, dependencies, backfill job', async () => {
    const slots = await usedColumnSlots(db.kysely, orders.table.db_table_name);
    const field = await formula(
      orders,
      'Hoa hồng',
      'IF([Trạng thái] = "Xong", [Số tiền] * 0.1, 0)',
    );
    fld.commission = field;
    expect(field.options).toEqual({
      expression: `IF([${fld.status?.id ?? ''}] = "Xong", [${fld.amount?.id ?? ''}] * 0.1, 0)`,
      style: VND,
    });
    expect(field).toMatchObject({
      type: 'formula',
      compute_mode: 'stored',
      result_type: { kind: 'number' },
      compute_state: 'backfilling',
      compute_error: null,
    });
    expect(field.db_column_name).toMatch(/^f_[0-9a-z]{12}$/);
    expect(await physicalColumns(db, orders.table.db_table_name)).toContain(field.db_column_name);
    expect(await usedColumnSlots(db.kysely, orders.table.db_table_name)).toBe(slots + 1);
    await expectConsistent(schema, scope, orders.table.id);
    const edges = await new FieldDependenciesRepository(db).listByBase(scope, tenant.baseId);
    expect(
      edges
        .filter((edge) => edge.fieldId === field.id)
        .map((edge) => [edge.dependsOnFieldId, edge.kind])
        .sort(),
    ).toEqual(
      [
        [fld.amount?.id, 'same_row'],
        [fld.status?.id, 'same_row'],
      ].sort(),
    );
    const jobs = await queuedJobs(db, 'computed.backfill');
    expect(jobs.at(-1)).toMatchObject({
      payload: { field_id: field.id },
      queue_name: `schema:${orders.table.id}`,
    });

    expect(await backfill(field)).toBe(3);
    expect(await values(orders, field)).toEqual({
      [rec.o1]: '100000',
      [rec.o2]: '50000',
      [rec.o3]: '0',
    });
    expect((await meta(field)).compute_state).toBe('ready');
    // No record event/audit/version change from computed values (ADR-23 §2).
    const versions = await sql<{
      v: number;
    }>`SELECT __version AS v FROM ${sql.id('data', orders.table.db_table_name)}`.execute(db.kysely);
    expect(versions.rows.every((row) => row.v === 1)).toBe(true);
  });

  it('TODAY() → virtual: no column, no slot, ready at once, no job', async () => {
    const slots = await usedColumnSlots(db.kysely, orders.table.db_table_name);
    const before = (await queuedJobs(db, 'computed.backfill')).length;
    const field = await formula(orders, 'Tuổi', 'TODAY() - DATE(2026, 1, 1)');
    expect(field).toMatchObject({
      compute_mode: 'virtual',
      db_column_name: null,
      compute_state: 'ready',
      result_type: { kind: 'number' },
    });
    expect(await usedColumnSlots(db.kysely, orders.table.db_table_name)).toBe(slots);
    expect((await queuedJobs(db, 'computed.backfill')).length).toBe(before);
    await expectConsistent(schema, scope, orders.table.id);
  });

  it('lookup sum of Orders.amount through the link: stored, currency, sums per customer', async () => {
    const field = await schema.addField(
      scope,
      customers.table.id,
      {
        name: 'Tổng tiền',
        type: 'lookup',
        options: {
          from: orders.table.id,
          select: fld.amount?.id,
          where: { field: fld.customer?.id, operator: 'intersects', value: { field_ref: '__id' } },
          aggregate: 'sum',
        },
        computed: { timeZone: 'UTC' },
      },
      ctx(),
    );
    fld.total = field;
    expect(field).toMatchObject({
      type: 'lookup',
      compute_mode: 'stored',
      result_type: { kind: 'number' },
      options: { from: orders.table.id, aggregate: 'sum', style: VND },
    });
    await backfill(field);
    expect(await values(customers, field)).toEqual({ [rec.c1]: '1500000', [rec.c2]: '300000' });
    const edges = await new FieldDependenciesRepository(db).listByBase(scope, tenant.baseId);
    expect(edges.filter((edge) => edge.fieldId === field.id).map((edge) => edge.kind)).toEqual(
      expect.arrayContaining(['cross_table']),
    );
  });

  it('lookup through a one-way link of this table (__id is_any_of field_ref, T467): via_link', async () => {
    const lookup = (name: string, where: unknown) =>
      schema.addField(
        scope,
        orders.table.id,
        {
          name,
          type: 'lookup',
          options: { from: customers.table.id, select: fld.code?.id, where },
          computed: { timeZone: 'UTC' },
        },
        ctx(),
      );
    const field = await lookup('Mã khách', {
      field: '__id',
      operator: 'is_any_of',
      value: { field_ref: fld.customer?.id },
    });
    expect(field).toMatchObject({
      compute_mode: 'stored',
      result_type: { kind: 'list', element: { kind: 'text' } },
      options: {
        where: { field: '__id', operator: 'is_any_of', value: { field_ref: fld.customer?.id } },
      },
    });
    await backfill(field);
    expect(await values(orders, field)).toEqual({
      [rec.o1]: ['K1'],
      [rec.o2]: ['K1'],
      [rec.o3]: ['K2'],
    });
    const edges = await new FieldDependenciesRepository(db).listByBase(scope, tenant.baseId);
    expect(
      edges.find((edge) => edge.fieldId === field.id && edge.dependsOnFieldId === fld.code?.id),
    ).toMatchObject({ kind: 'via_link', paths: [{ link_path: [fld.customer?.id] }] });

    // Only a link of this table to the source table, only is_any_of / is_none_of.
    const notLink = await problem(
      lookup('x-link', {
        field: '__id',
        operator: 'is_any_of',
        value: { field_ref: fld.amount?.id },
      }),
    );
    expect(notLink).toMatchObject({
      code: 'FORMULA_TYPE_ERROR',
      errors: [{ code: 'INVALID_LOOKUP', path: 'options.where.value.field_ref' }],
    });
    const operator = await problem(
      lookup('x-op', { field: '__id', operator: 'eq', value: { field_ref: fld.customer?.id } }),
    );
    expect(operator).toMatchObject({
      code: 'INVALID_FILTER',
      errors: [{ code: 'OPERATOR_NOT_ALLOWED', path: 'options.where.operator' }],
    });
    await schema.deleteField(scope, field.id, ctx());
  });

  it('formula over a stored computed field of another table (through the link)', async () => {
    const field = await formula(orders, 'Tổng của khách', '[Khách hàng].[Tổng tiền].SUM()');
    expect(field).toMatchObject({ compute_mode: 'stored', result_type: { kind: 'number' } });
    await backfill(field);
    expect(await values(orders, field)).toEqual({
      [rec.o1]: '1500000',
      [rec.o2]: '1500000',
      [rec.o3]: '300000',
    });
    const edges = await new FieldDependenciesRepository(db).listByBase(scope, tenant.baseId);
    expect(
      edges.find((edge) => edge.fieldId === field.id && edge.dependsOnFieldId === fld.total?.id),
    ).toMatchObject({ kind: 'via_link', paths: [{ link_path: [fld.customer?.id] }] });
  });

  it('errors: syntax (position), unknown field, types, lookup where', async () => {
    const syntax = await problem(formula(orders, 'x1', 'IF([Số tiền] > 1, 2'));
    expect(syntax.code).toBe('FORMULA_SYNTAX_ERROR');
    expect(syntax.errors[0]).toMatchObject({ path: 'options.expression', code: 'UNEXPECTED_END' });
    expect(syntax.errors[0]?.params?.position).toEqual({ start: 19, length: 0 });
    const unknown = await problem(formula(orders, 'x2', '[Không có] + 1'));
    expect(unknown).toMatchObject({
      code: 'FORMULA_SYNTAX_ERROR',
      errors: [{ code: 'UNKNOWN_FIELD', params: { position: { start: 0, length: 10 } } }],
    });
    const types = await problem(formula(orders, 'x3', '[Số tiền] & 1 > "a" + 1'));
    expect(types.code).toBe('FORMULA_TYPE_ERROR');
    const emptyWhere = await problem(
      schema.addField(
        scope,
        customers.table.id,
        {
          name: 'x4',
          type: 'lookup',
          options: {
            from: orders.table.id,
            select: fld.amount?.id,
            where: { op: 'and', items: [] },
          },
        },
        ctx(),
      ),
    );
    expect(emptyWhere).toMatchObject({
      code: 'INVALID_FILTER',
      errors: [{ code: 'EMPTY_FILTER' }],
    });
    const pair = await problem(
      schema.addField(
        scope,
        customers.table.id,
        {
          name: 'x5',
          type: 'lookup',
          options: {
            from: orders.table.id,
            select: fld.amount?.id,
            where: { field: fld.amount?.id, operator: 'eq', value: { field_ref: fld.code?.id } },
          },
        },
        ctx(),
      ),
    );
    expect(pair).toMatchObject({
      code: 'FORMULA_TYPE_ERROR',
      errors: [{ code: 'INVALID_LOOKUP', path: 'options.where.value.field_ref' }],
    });
    const style = await problem(formula(orders, 'x6', '"a"', { style: VND }));
    expect(style).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'options.style' }] });
    const required = await problem(
      schema.addField(
        scope,
        orders.table.id,
        { name: 'x7', type: 'formula', options: { expression: '1' }, required: true },
        ctx(),
      ),
    );
    expect(required.errors[0]?.code).toBe('REQUIRED_NOT_SUPPORTED');
  });

  it('the saver cannot reference what they cannot read (UNKNOWN_FIELD/UNKNOWN_TABLE, like P08)', async () => {
    const readable: SchemaReadability = {
      table: () => true,
      field: (_table, fieldId) => fieldId !== fld.cost?.id,
    };
    const hidden = await problem(formula(orders, 'y1', '[amount] - [cost]', {}, readable));
    expect(hidden.errors.map((error) => error.code)).toContain('UNKNOWN_FIELD');
    const noCustomers: SchemaReadability = {
      table: (tableId) => tableId !== customers.table.id,
      field: () => true,
    };
    const table = await problem(
      formula(orders, 'y2', '[Customers].[Mã].COUNTA()', {}, noCustomers),
    );
    expect(table.code).toBe('FORMULA_SYNTAX_ERROR');
    const through = await problem(
      formula(orders, 'y3', '[Khách hàng].[Mã].ARRAYJOIN()', {}, noCustomers),
    );
    expect(through.errors[0]?.code).toBe('UNKNOWN_FIELD');
    const lookup = await problem(
      schema.addField(
        scope,
        customers.table.id,
        {
          name: 'y4',
          type: 'lookup',
          options: {
            from: orders.table.id,
            select: fld.cost?.id,
            where: {
              field: fld.customer?.id,
              operator: 'intersects',
              value: { field_ref: '__id' },
            },
          },
          computed: { readable },
        },
        ctx(),
      ),
    );
    expect(lookup.errors[0]).toMatchObject({ code: 'UNKNOWN_FIELD', path: 'options.select' });
  });

  it('a cycle A → B → A through a two-way link → FORMULA_CYCLE with the chain', async () => {
    const link = await schema.addField(
      scope,
      orders.table.id,
      {
        name: 'Khách 2',
        type: 'link',
        options: {
          link_table: customers.table.id,
          bidirectional: true,
          bidirectional_link_field_name: 'Đơn 2',
        },
      },
      ctx(),
    );
    expect(link.type).toBe('link');
    const b = await formula(orders, 'B', '[Khách 2].[Mã].ARRAYJOIN()');
    const a = await formula(customers, 'A', '[Đơn 2].[B].ARRAYJOIN()');
    const cycle = await problem(
      schema.updateField(
        scope,
        b.id,
        { optionsPatch: { expression: '[Khách 2].[A].ARRAYJOIN()' } },
        ctx(),
      ),
    );
    expect(cycle).toMatchObject({
      code: 'FORMULA_CYCLE',
      errors: [
        {
          path: 'options',
          code: 'CIRCULAR_REFERENCE',
          params: {
            cycle: [
              { id: b.id, name: 'B' },
              { id: a.id, name: 'A' },
              { id: b.id, name: 'B' },
            ],
          },
        },
      ],
    });
    // Only the fields the saver reads are named.
    const blind = await problem(
      schema.updateField(
        scope,
        b.id,
        {
          optionsPatch: { expression: '[Khách 2].[A].ARRAYJOIN()' },
          computed: {
            readable: { table: () => true, field: (_t, id) => id !== a.id },
          },
        },
        ctx(),
      ),
    );
    // A is invisible, so the formula itself cannot name it.
    expect(blind.code).toBe('FORMULA_SYNTAX_ERROR');
    const self = await problem(
      schema.updateField(scope, b.id, { optionsPatch: { expression: '[B] & "x"' } }, ctx()),
    );
    expect(self.code).toBe('FORMULA_CYCLE');
  });

  it('a change of result type gets a new column; readers follow (cascade); consistency holds', async () => {
    const base = await formula(orders, 'Gốc', '[Số tiền] * 2');
    const reader = await formula(orders, 'Đọc gốc', '[Gốc] + 1');
    expect(reader.result_type).toEqual({ kind: 'number' });
    const oldColumn = base.db_column_name;
    const changed = await schema.updateField(
      scope,
      base.id,
      { optionsPatch: { expression: '"#" & [Số tiền]' } },
      ctx(),
    );
    expect(changed.result_type).toEqual({ kind: 'text' });
    expect(changed.db_column_name).not.toBe(oldColumn);
    expect(await physicalColumns(db, orders.table.db_table_name)).not.toContain(oldColumn);
    // `[Gốc] + 1` no longer typechecks: the reader is in error (INVALID_CONFIG, T460).
    expect(await meta(reader)).toMatchObject({
      compute_state: 'error',
      compute_error: { code: 'INVALID_CONFIG', refs: [{ kind: 'field', id: base.id }] },
    });
    await expectConsistent(schema, scope, orders.table.id);
    await backfill(changed);
    expect(Object.values(await values(orders, changed)).sort()).toEqual([
      '#1000000',
      '#300000',
      '#500000',
    ]);

    // Same type, new expression: same column, values recomputed in place.
    const again = await schema.updateField(
      scope,
      changed.id,
      { optionsPatch: { expression: '"$" & [Số tiền]' } },
      ctx(),
    );
    expect(again.db_column_name).toBe(changed.db_column_name);
    expect(again.compute_state).toBe('backfilling');
    // Only the style: the stored expression is kept.
    const styled = await schema.updateField(
      scope,
      fld.commission?.id as Id<'fld'>,
      { optionsPatch: { style: { type: 'plain', precision: 2 } } },
      ctx(),
    );
    expect(styled.options).toMatchObject({
      expression:
        fld.commission?.options && (fld.commission.options as { expression: string }).expression,
      style: { type: 'plain', precision: 2 },
    });

    // Stored → virtual: the column goes.
    const virtual = await schema.updateField(
      scope,
      again.id,
      { optionsPatch: { expression: 'TODAY() & ""' } },
      ctx(),
    );
    expect(virtual).toMatchObject({ compute_mode: 'virtual', db_column_name: null });
    await expectConsistent(schema, scope, orders.table.id);
  });

  it('compaction keeps stored computed columns (active and in the trash)', async () => {
    const keep = await formula(orders, 'Giữ', '[Số tiền] + [cost]');
    await backfill(keep);
    const trashed = await formula(orders, 'Bỏ', '[Số tiền] - [cost]');
    await schema.deleteField(scope, trashed.id, ctx());
    await schema.compactTable(scope, orders.table.id);
    await expectConsistent(schema, scope, orders.table.id);
    expect(await values(orders, keep)).toEqual({
      [rec.o1]: '1000200',
      [rec.o2]: '500100',
      [rec.o3]: '300050',
    });
  });

  it('literals and names never reach the SQL text (injection)', async () => {
    const odd = await schema.addField(
      scope,
      orders.table.id,
      { name: `x"; DROP TABLE data.x; -- ]`, type: 'text' },
      ctx(),
    );
    const field = await formula(
      orders,
      `f'); DROP TABLE meta.fields; --`,
      `"'; DROP TABLE meta.fields; --" & [x"; DROP TABLE data.x; -- \\]] & "$1 \\\\ /* */"`,
    );
    await backfill(field);
    const got = Object.values(await values(orders, field));
    expect(got).toEqual([
      `'; DROP TABLE meta.fields; --$1 \\ /* */`,
      `'; DROP TABLE meta.fields; --$1 \\ /* */`,
      `'; DROP TABLE meta.fields; --$1 \\ /* */`,
    ]);
    expect(odd.type).toBe('text');
    const fields = await db.kysely.selectFrom('meta.fields').select('id').execute();
    expect(fields.length).toBeGreaterThan(5);

    // A table name with SQL in it, read through `[Table]`; the compiled SQL only
    // has placeholders for the literals, identifiers come from meta.
    const evil = await schema.createTable(
      scope,
      { baseId: tenant.baseId, name: `T'; DROP TABLE meta.tables; --`, primaryFieldName: 'Name' },
      ctx(),
    );
    const counted = await formula(
      orders,
      'count evil',
      `[T'; DROP TABLE meta.tables; --].FILTER(CurrentValue.[Name] != "/* $1 */").[Name].COUNTA()`,
    );
    expect(counted.compute_mode).toBe('stored');
    const rows = await loadBaseSchemaRows(db, scope, tenant.baseId);
    const model = new ComputeModel(rows, { timeZone: 'UTC' });
    for (const target of [field, counted]) {
      const current = rows.fields.find((row) => row.id === target.id);
      if (current === undefined) throw new Error('missing field');
      const compiled = model.storedValue(current, 'cr')?.compile(db.kysely);
      expect(compiled?.sql).not.toMatch(/DROP|\/\*/);
      const parameters = (compiled?.parameters ?? []).filter(
        (value): value is string => typeof value === 'string',
      );
      expect(parameters.some((value) => value.includes('DROP') || value.includes('$1'))).toBe(true);
    }
    await backfill(counted);
    expect(Object.values(await values(orders, counted))).toEqual(['0', '0', '0']);
    expect(evil.table.name).toBe(`T'; DROP TABLE meta.tables; --`);
  });

  it('at most COMPUTED_FIELDS_MAX_PER_BASE computed fields per base → FORMULA_LIMIT_EXCEEDED', async () => {
    const count = Number(
      (
        await sql<{ n: string }>`SELECT count(*) AS n FROM meta.fields
          WHERE organization_id = ${ORG_A} AND type IN ('formula', 'lookup') AND deleted_at IS NULL`.execute(
          db.kysely,
        )
      ).rows[0]?.n,
    );
    for (let index = count; index < 12; index += 1) {
      await formula(orders, `limit ${String(index)}`, '1 + 1');
    }
    const over = await problem(formula(orders, 'one too many', '1 + 1'));
    expect(over).toMatchObject({
      code: 'FORMULA_LIMIT_EXCEEDED',
      errors: [{ code: 'MAX_COMPUTED_FIELDS', params: { limit: 12 } }],
    });
  });
});

describe('FieldDependenciesRepository tenant isolation (T456)', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('reads and writes only the rows of its organization', async () => {
    const a = await seedTenant(db, 'org_DepsRepoOrgA0001');
    const b = await seedTenant(db, 'org_DepsRepoOrgB0001');
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const make = async (tenant: SeededTenant) => {
      const s = orgScope(tenant.orgId);
      const { table } = await schema.createTable(
        s,
        { baseId: tenant.baseId, name: 'T', primaryFieldName: 'Name' },
        userContext(tenant.userId),
      );
      const n = await schema.addField(
        s,
        table.id,
        { name: 'n', type: 'number' },
        userContext(tenant.userId),
      );
      const f = await schema.addField(
        s,
        table.id,
        { name: 'f', type: 'formula', options: { expression: '[n] * 2' } },
        userContext(tenant.userId),
      );
      return { s, n, f };
    };
    const inA = await make(a);
    const inB = await make(b);
    const repo = new FieldDependenciesRepository(db);
    expect((await repo.listByBase(inA.s, a.baseId)).map((edge) => edge.fieldId)).toEqual([
      inA.f.id,
    ]);
    // Another organization's base, dependents or field: nothing.
    expect(await repo.listByBase(inA.s, b.baseId)).toEqual([]);
    expect(await repo.listDependents(inA.s, [inB.n.id])).toEqual([]);
    await db.withTx(async (tx) => {
      await repo.deleteForField(withTxScope(inA.s, tx), inB.f.id);
      await repo.replaceForField(withTxScope(inA.s, tx), {
        baseId: a.baseId,
        fieldId: inB.f.id,
        edges: [],
      });
    });
    expect((await repo.listByBase(inB.s, b.baseId)).map((edge) => edge.fieldId)).toEqual([
      inB.f.id,
    ]);
    expect(await repo.listDependents(inB.s, [inB.n.id])).toEqual([
      { fieldId: inB.f.id, dependsOnFieldId: inB.n.id },
    ]);

    // T471: edges for another organization's field are not written under
    // this scope, so that organization can still replace its own.
    const edgesOfB = await repo.listByBase(inB.s, b.baseId);
    await db.withTx(async (tx) => {
      await repo.replaceForField(withTxScope(inA.s, tx), {
        baseId: a.baseId,
        fieldId: inB.f.id,
        edges: edgesOfB,
      });
    });
    expect(await repo.listByBase(inA.s, b.baseId)).toEqual([]);
    expect(await repo.listDependents(inA.s, [inB.n.id])).toEqual([]);
    await db.withTx(async (tx) => {
      await repo.replaceForField(withTxScope(inB.s, tx), {
        baseId: b.baseId,
        fieldId: inB.f.id,
        edges: edgesOfB,
      });
    });
    expect(await repo.listByBase(inB.s, b.baseId)).toEqual(edgesOfB);
  });
});
