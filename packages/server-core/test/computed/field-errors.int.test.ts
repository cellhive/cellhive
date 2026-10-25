import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { orgScope, type Db, type OrgScope } from '../../src/db/index.js';
import { isAppError } from '../../src/errors/index.js';
import { JobsRepository } from '../../src/jobs/jobs.repository.js';
import { RecordMutationService, RecordQueryService } from '../../src/records/index.js';
import {
  FieldsRepository,
  SchemaService,
  TablesRepository,
  type SchemaChange,
} from '../../src/schema/index.js';
import { buildOrdersFixture, NOW, type OrdersFixture } from '../records/fixtures.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { queuedJobs, userContext } from '../support/schema.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ORG_A = 'org_FieldErrOrgA0001';
const ORG_B = 'org_FieldErrOrgB0001';

/**
 * T460 at the service level, on PostgreSQL 18: field-level errors of
 * formula/lookup fields set and cleared in the transaction of the schema
 * change — `REF` (deleted field, link side, table in the trash, purge),
 * `CIRCLE` (a restore closing a cycle), `INVALID_CONFIG` (a conversion
 * breaking the typecheck), `TIMEOUT` (recompute job), indirect `REF`; the
 * self-healing restore with its backfill, `field.updated` audit and
 * `schema.changed`, and the tenant isolation of the new repository reads.
 */
describe('field-level errors of computed fields (T460)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let records: RecordMutationService;
  let fx: OrdersFixture;
  let scope: OrgScope;
  const published: SchemaChange[] = [];
  const f: Record<string, FieldRow> = {};
  const rec = { c1: newId('rec'), c2: newId('rec'), o1: newId('rec'), o2: newId('rec') };

  const ctx = () => userContext(fx.users.u_admin.id);

  async function meta(id: Id<'fld'>): Promise<FieldRow> {
    const row = await new FieldsRepository(db).getById(scope, id, { includeDeleted: true });
    if (row === undefined) throw new Error('no field');
    return row;
  }

  async function errorOf(field: FieldRow) {
    const row = await meta(field.id);
    return { state: row.compute_state, error: row.compute_error };
  }

  const formula = (table: TableRow, name: string, expression: string) =>
    schema.addField(
      scope,
      table.id,
      { name, type: 'formula', options: { expression }, computed: { timeZone: 'UTC' } },
      ctx(),
    );

  /** What `computed.backfill` does for one field. */
  async function backfill(field: FieldRow): Promise<void> {
    let cursor = 0n;
    for (;;) {
      const result = await records.backfillComputedBatch(scope, {
        fieldId: field.id,
        afterAuto: cursor,
        limit: 100,
        statementTimeoutMs: 30_000,
      });
      if (result.status !== 'more' && result.status !== 'done') break;
      cursor = result.cursor;
      if (result.status === 'done') break;
    }
    await schema.finishComputedBackfill(scope, field.id, { status: 'ready' });
  }

  async function stored(table: TableRow, field: FieldRow, id: string): Promise<unknown> {
    const column = (await meta(field.id)).db_column_name;
    if (column === null) throw new Error('no column');
    const { rows } = await sql<{ v: unknown }>`
      SELECT ${sql.id(column)}::text AS v FROM ${sql.id('data', table.db_table_name)} WHERE __id = ${id}
    `.execute(db.kysely);
    return rows[0]?.v ?? null;
  }

  async function backfillJobs(): Promise<string[]> {
    return (await queuedJobs(db, 'computed.backfill'))
      .map((job) => job.payload['field_id'] as string)
      .sort();
  }

  async function clearJobs(): Promise<void> {
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
  }

  async function auditOf(fieldId: Id<'fld'>) {
    return db.kysely
      .selectFrom('meta.audit_logs')
      .select(['action', 'before', 'after'])
      .where('organization_id', '=', ORG_A)
      .where('entity_id', '=', fieldId)
      .where('action', '=', 'field.updated')
      .orderBy('created_at')
      .execute();
  }

  async function problem(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (isAppError(error)) return error.code;
      throw error;
    }
    throw new Error('expected an error');
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    schema = new SchemaService(db, {
      maxFieldsPerTable: 500,
      publisher: { publish: (change) => void published.push(change) },
    });
    const query = new RecordQueryService(db, { now: () => NOW });
    records = new RecordMutationService(db, { schema, query, now: () => NOW });
    fx = await buildOrdersFixture(db, schema, ORG_A);
    await buildOrdersFixture(db, new SchemaService(db, { maxFieldsPerTable: 500 }), ORG_B);
    scope = orgScope(ORG_A);
    f.customer = await schema.addField(
      scope,
      fx.orders.id,
      {
        name: 'customer',
        type: 'link',
        options: {
          link_table: fx.customers.id,
          bidirectional: true,
          bidirectional_link_field_name: 'orders',
        },
      },
      ctx(),
    );
    f.reverse = await meta(
      (f.customer.options as { symmetric_field_id: Id<'fld'> }).symmetric_field_id,
    );
    const data = (table: TableRow) => sql.id('data', table.db_table_name);
    const col = (field: FieldRow) => sql.id(field.db_column_name ?? '');
    await sql`INSERT INTO ${data(fx.customers)} (__id, ${col(fx.fld.name)}) VALUES
      (${rec.c1}, 'An'), (${rec.c2}, 'Bình')`.execute(db.kysely);
    await sql`INSERT INTO ${data(fx.orders)} (__id, ${col(fx.fld.title)}, ${col(fx.fld.amount)}, ${col(fx.fld.cost)}) VALUES
      (${rec.o1}, 'o1', 100, 7), (${rec.o2}, 'o2', 200, 8)`.execute(db.kysely);
    await sql`INSERT INTO ${sql.id('data', f.customer.link_junction ?? '')} (a_id, b_id, position) VALUES
      (${rec.o1}, ${rec.c1}, 0), (${rec.o2}, ${rec.c1}, 0)`.execute(db.kysely);

    f.double = await formula(fx.orders, 'double', `[amount] * 2`);
    f.plus = await formula(fx.orders, 'plus', `[double] + 1`);
    f.custName = await formula(fx.orders, 'custName', `[customer].[name].ARRAYJOIN()`);
    f.total = await schema.addField(
      scope,
      fx.customers.id,
      {
        name: 'total',
        type: 'lookup',
        options: {
          from: fx.orders.id,
          select: fx.fld.amount.id,
          where: { field: f.customer.id, operator: 'intersects', value: { field_ref: '__id' } },
          aggregate: 'sum',
        },
        computed: { timeZone: 'UTC' },
      },
      ctx(),
    );
    f.viaReverse = await formula(fx.customers, 'viaReverse', `[orders].[amount].SUM()`);
    for (const key of ['double', 'plus', 'custName', 'total', 'viaReverse']) {
      await backfill(f[key] as FieldRow);
    }
  });

  beforeEach(async () => {
    published.length = 0;
    await clearJobs();
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('starts without errors, values backfilled', async () => {
    for (const key of ['double', 'plus', 'custName', 'total', 'viaReverse']) {
      expect(await errorOf(f[key] as FieldRow)).toEqual({ state: 'ready', error: null });
    }
    expect(Number(await stored(fx.orders, f.plus as FieldRow, rec.o1))).toBe(201);
    expect(Number(await stored(fx.customers, f.total as FieldRow, rec.c1))).toBe(300);
  });

  it('deleting `amount` → REF (formula, lookup, formula through the reverse link), indirect REF; restore heals and backfills', async () => {
    await schema.deleteField(scope, fx.fld.amount.id, ctx());
    const amountRef = { code: 'REF', refs: [{ kind: 'field', id: fx.fld.amount.id }] };
    expect(await errorOf(f.double as FieldRow)).toEqual({ state: 'error', error: amountRef });
    expect(await errorOf(f.total as FieldRow)).toEqual({ state: 'error', error: amountRef });
    expect(await errorOf(f.viaReverse as FieldRow)).toEqual({ state: 'error', error: amountRef });
    // `plus` reads `double`, which is in error: REF pointing at it.
    expect(await errorOf(f.plus as FieldRow)).toEqual({
      state: 'error',
      error: { code: 'REF', refs: [{ kind: 'field', id: f.double?.id }] },
    });
    expect(await errorOf(f.custName as FieldRow)).toEqual({ state: 'ready', error: null });
    // One `field.updated` per field with before/after compute_error, and schema.changed.
    const audit = await auditOf(f.double?.id as Id<'fld'>);
    expect(audit.at(-1)).toMatchObject({
      before: { compute_error: null },
      after: { compute_error: amountRef },
    });
    const updated = published.filter((c) => c.action === 'updated').map((c) => c.entity_id);
    expect(updated).toEqual(
      expect.arrayContaining([f.double?.id, f.plus?.id, f.total?.id, f.viaReverse?.id]),
    );
    expect(published).toContainEqual(
      expect.objectContaining({ entity_id: fx.fld.amount.id, action: 'deleted' }),
    );

    published.length = 0;
    await schema.restoreField(scope, fx.fld.amount.id, ctx());
    for (const key of ['double', 'plus', 'total', 'viaReverse']) {
      expect(await errorOf(f[key] as FieldRow)).toEqual({ state: 'backfilling', error: null });
    }
    // One job per field no other job covers: `plus` is computed after `double`.
    expect(await backfillJobs()).toEqual(
      [f.double?.id, f.total?.id, f.viaReverse?.id].sort() as string[],
    );
    expect((await auditOf(f.plus?.id as Id<'fld'>)).at(-1)).toMatchObject({
      after: { compute_error: null },
    });
    await sql`UPDATE ${sql.id('data', fx.orders.db_table_name)} SET ${sql.id(fx.fld.amount.db_column_name ?? '')} = 1000 WHERE __id = ${rec.o1}`.execute(
      db.kysely,
    );
    for (const key of ['double', 'plus', 'total', 'viaReverse']) await backfill(f[key] as FieldRow);
    expect(Number(await stored(fx.orders, f.plus as FieldRow, rec.o1))).toBe(2001);
    expect(Number(await stored(fx.customers, f.total as FieldRow, rec.c1))).toBe(1200);
    expect(await errorOf(f.plus as FieldRow)).toEqual({ state: 'ready', error: null });
  });

  it('two-way → one-way deletes the other side: the formula walking it is REF; revert heals with the same id', async () => {
    const started = await schema.startLinkConversion(
      scope,
      f.customer?.id as Id<'fld'>,
      { expectedOptions: (await meta(f.customer?.id as Id<'fld'>)).options, change: 'to_one_way' },
      ctx(),
    );
    for (;;) {
      const batch = await records.convertFieldBatch(scope, started.jobId, 100);
      if (batch === undefined || batch.done) break;
    }
    expect(
      await schema.finishConversion(scope, started.jobId, { status: 'succeeded', counts: {} }),
    ).toBe('finished');
    expect((await meta(f.reverse?.id as Id<'fld'>)).deleted_at).not.toBeNull();
    expect(await errorOf(f.viaReverse as FieldRow)).toEqual({
      state: 'error',
      error: { code: 'REF', refs: [{ kind: 'field', id: f.reverse?.id }] },
    });
    // The lookup reads the Orders side, kept: no error (recomputed by the job, T458).
    expect(await errorOf(f.total as FieldRow)).toMatchObject({ error: null });
    expect((await errorOf(f.total as FieldRow)).state).not.toBe('error');

    await schema.revertLinkConversion(scope, f.customer?.id as Id<'fld'>, ctx());
    expect((await meta(f.reverse?.id as Id<'fld'>)).deleted_at).toBeNull();
    expect(await errorOf(f.viaReverse as FieldRow)).toEqual({ state: 'backfilling', error: null });
    expect(await backfillJobs()).toEqual([f.viaReverse?.id]);
    await backfill(f.viaReverse as FieldRow);
    expect(Number(await stored(fx.customers, f.viaReverse as FieldRow, rec.c1))).toBe(1200);
  });

  it('Customers in the trash → Orders formula reading it through the link is REF (table); restore heals', async () => {
    await schema.deleteTable(scope, fx.customers.id, ctx());
    expect(await errorOf(f.custName as FieldRow)).toEqual({
      state: 'error',
      error: { code: 'REF', refs: [{ kind: 'table', id: fx.customers.id }] },
    });
    await schema.restoreTable(scope, fx.customers.id, ctx());
    expect(await errorOf(f.custName as FieldRow)).toEqual({ state: 'backfilling', error: null });
    // Its stored fields missed changes of Orders while in the trash: computed again.
    expect(await errorOf(f.total as FieldRow)).toMatchObject({ state: 'backfilling' });
    expect(await backfillJobs()).toEqual(
      [f.custName?.id, f.total?.id, f.viaReverse?.id].sort() as string[],
    );
    for (const key of ['custName', 'total', 'viaReverse']) await backfill(f[key] as FieldRow);
    expect(await stored(fx.orders, f.custName as FieldRow, rec.o1)).toBe('An');
  });

  it('Orders in the trash → the lookup of Customers is REF on the table', async () => {
    await schema.deleteTable(scope, fx.orders.id, ctx());
    expect(await errorOf(f.total as FieldRow)).toEqual({
      state: 'error',
      error: { code: 'REF', refs: [{ kind: 'table', id: fx.orders.id }] },
    });
    await schema.restoreTable(scope, fx.orders.id, ctx());
    expect(await errorOf(f.total as FieldRow)).toEqual({ state: 'backfilling', error: null });
    for (const key of ['double', 'plus', 'custName', 'total', 'viaReverse']) {
      await backfill(f[key] as FieldRow);
    }
  });

  it('a conversion breaking the typecheck → INVALID_CONFIG (not REF); revert heals', async () => {
    const times = await formula(fx.orders, 'times', `[cost] * 10`);
    await backfill(times);
    const cost = await meta(fx.fld.cost.id);
    const started = await schema.startConversion(
      scope,
      cost.id,
      {
        expectedFrom: { type: cost.type, options: cost.options },
        toType: 'text',
        toOptions: {},
        settings: {},
        locale: 'vi',
        timeZone: 'UTC',
      },
      ctx(),
    );
    await new JobsRepository(db).markRunning(scope, started.jobId);
    for (;;) {
      const batch = await records.convertFieldBatch(scope, started.jobId, 100);
      if (batch === undefined) throw new Error('not running');
      if (!batch.done) continue;
      const end = await schema.finishConversion(scope, started.jobId, {
        status: 'succeeded',
        counts: { ...batch.counts },
      });
      if (end === 'finished') break;
    }
    expect(await errorOf(times)).toEqual({
      state: 'error',
      error: { code: 'INVALID_CONFIG', refs: [{ kind: 'field', id: cost.id }] },
    });
    await schema.revertConversion(scope, cost.id, ctx());
    expect(await errorOf(times)).toEqual({ state: 'backfilling', error: null });
    await backfill(times);
    expect(Number(await stored(fx.orders, times, rec.o2))).toBe(80);
    await schema.deleteField(scope, times.id, ctx());
  });

  it('a new definition that typechecks again heals its readers (INVALID_CONFIG → fine)', async () => {
    const base = await formula(fx.orders, 'base', `[cost] + 1`);
    const reader = await formula(fx.orders, 'reader', `[base] * 2`);
    await clearJobs();
    await schema.updateField(
      scope,
      base.id,
      { optionsPatch: { expression: '"#" & [cost]' } },
      ctx(),
    );
    expect(await errorOf(reader)).toEqual({
      state: 'error',
      error: { code: 'INVALID_CONFIG', refs: [{ kind: 'field', id: base.id }] },
    });
    await clearJobs();
    await schema.updateField(scope, base.id, { optionsPatch: { expression: '[cost] + 2' } }, ctx());
    expect(await errorOf(reader)).toEqual({ state: 'backfilling', error: null });
    // Covered by the job of `base` (it computes its readers after it).
    const jobs = await backfillJobs();
    expect(jobs).toContain(base.id);
    expect(jobs).not.toContain(reader.id);
    await schema.deleteField(scope, reader.id, ctx());
    await schema.deleteField(scope, base.id, ctx());
  });

  it('a restore closing a cycle → CIRCLE on every field of it; saving it still 422; a fix heals', async () => {
    const x = await formula(fx.orders, 'x', `[cost] + 1`);
    const d = await formula(fx.orders, 'd', `[x] + 1`);
    const a = await formula(fx.orders, 'a', `[d] + 1`);
    await schema.deleteField(scope, d.id, ctx());
    expect((await errorOf(a)).error).toEqual({
      code: 'REF',
      refs: [{ kind: 'field', id: d.id }],
    });
    // x → a is no cycle while d is in the trash.
    await schema.updateField(scope, x.id, { optionsPatch: { expression: '[a] + 1' } }, ctx());
    expect((await errorOf(x)).error).toEqual({ code: 'REF', refs: [{ kind: 'field', id: a.id }] });

    await schema.restoreField(scope, d.id, ctx());
    const cycle = [a.id, d.id, x.id].sort().map((id) => ({ kind: 'field', id }));
    for (const field of [x, d, a]) {
      expect(await errorOf(field)).toEqual({
        state: 'error',
        error: { code: 'CIRCLE', refs: cycle },
      });
    }
    expect(
      await problem(
        schema.updateField(scope, a.id, { optionsPatch: { expression: '[d] + 2' } }, ctx()),
      ),
    ).toBe('FORMULA_CYCLE');
    // Breaking the cycle heals every field of it.
    await schema.updateField(scope, x.id, { optionsPatch: { expression: '[cost] * 3' } }, ctx());
    for (const field of [x, d, a]) {
      expect((await errorOf(field)).error).toBeNull();
    }
    for (const field of [a, d, x]) await schema.deleteField(scope, field.id, ctx());
  });

  it('a recompute batch past its statement timeout → TIMEOUT, readers REF; saving it again retries', async () => {
    expect(await schema.markComputedTimeout(scope, f.double?.id as Id<'fld'>)).toBe(true);
    expect(await errorOf(f.double as FieldRow)).toEqual({
      state: 'error',
      error: { code: 'TIMEOUT', refs: [] },
    });
    expect((await errorOf(f.plus as FieldRow)).error).toEqual({
      code: 'REF',
      refs: [{ kind: 'field', id: f.double?.id }],
    });
    // Another schema change keeps the TIMEOUT.
    const tmp = await schema.addField(scope, fx.orders.id, { name: 'tmp', type: 'text' }, ctx());
    await schema.deleteField(scope, tmp.id, ctx());
    expect((await errorOf(f.double as FieldRow)).error).toEqual({ code: 'TIMEOUT', refs: [] });
    // Saving the same definition again computes it again.
    await schema.updateField(
      scope,
      f.double?.id as Id<'fld'>,
      { optionsPatch: { expression: '[amount] * 2' }, computed: { timeZone: 'UTC' } },
      ctx(),
    );
    expect(await errorOf(f.double as FieldRow)).toEqual({ state: 'backfilling', error: null });
    expect((await errorOf(f.plus as FieldRow)).error).toBeNull();
    expect(await schema.markComputedTimeout(scope, fx.fld.amount.id)).toBe(false);
    for (const key of ['double', 'plus']) await backfill(f[key] as FieldRow);
  });

  it('purging Customers: Orders fields reading it stay REF, the link partner trashed for good', async () => {
    await schema.deleteTable(scope, fx.customers.id, ctx());
    await schema.purgeTable(
      scope,
      fx.customers.id,
      { reason: 'manual', confirmName: 'Customers' },
      ctx(),
    );
    // `customer` (Orders side) went to the trash for good: its readers name it.
    const after = await errorOf(f.custName as FieldRow);
    expect(after).toMatchObject({ state: 'error', error: { code: 'REF' } });
    const refs = (after.error as { refs: unknown[] }).refs;
    expect(refs).toHaveLength(2);
    expect(refs).toEqual(
      expect.arrayContaining([
        { kind: 'field', id: f.customer?.id },
        { kind: 'table', id: fx.customers.id },
      ]),
    );
    expect(await errorOf(f.double as FieldRow)).toMatchObject({ error: null });
  });

  it('repository reads by id never cross tenants', async () => {
    const own = await new FieldsRepository(db).listByIds(scope, [fx.fld.amount.id]);
    expect(own.map((row) => row.id)).toEqual([fx.fld.amount.id]);
    expect(await new FieldsRepository(db).listByIds(orgScope(ORG_B), [fx.fld.amount.id])).toEqual(
      [],
    );
    expect(await new FieldsRepository(db).listByIds(scope, [])).toEqual([]);
    const tables = await new TablesRepository(db).listByIds(scope, [fx.customers.id]);
    expect(tables.map((row) => [row.id, row.purged_at !== null])).toEqual([
      [fx.customers.id, true],
    ]);
    expect(await new TablesRepository(db).listByIds(orgScope(ORG_B), [fx.orders.id])).toEqual([]);
  });
});
