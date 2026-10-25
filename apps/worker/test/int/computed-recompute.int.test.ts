import { type Id } from '@cellhive/contracts';
import {
  BasesRepository,
  ComputedRecomputeService,
  orgScope,
  RecordMutationService,
  SchemaService,
  systemAuditContext,
  type Db,
  type FieldRow,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker, type WorkerHandle } from '../../src/index.js';
import { createComputedRecomputeTask } from '../../src/tasks/computed-recompute.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  queuedJobs,
  testConfig,
  waitFor,
  type CapturedLogger,
  type TestDatabase,
} from './support.js';

import type { JobHelpers } from 'graphile-worker';

async function seed(
  db: Db,
  key: string,
): Promise<{ org: Id<'org'>; user: Id<'usr'>; base: Id<'bse'> }> {
  const org: Id<'org'> = `org_${key}`;
  const user: Id<'usr'> = `usr_${key}`;
  const wsp: Id<'wsp'> = `wsp_${key}`;
  await db.withTx(async (tx) => {
    await tx
      .insertInto('meta.organizations')
      .values({ id: org, name: key, slug: key.toLowerCase() })
      .execute();
    await tx
      .insertInto('meta.users')
      .values({ id: user, email: `${key.toLowerCase()}@example.test`, display_name: key })
      .execute();
    await tx
      .insertInto('meta.org_members')
      .values({ organization_id: org, user_id: user, role: 'owner' })
      .execute();
    await tx
      .insertInto('meta.workspaces')
      .values({ id: wsp, organization_id: org, name: key, slug: 'main' })
      .execute();
  });
  const base = await new BasesRepository(db).create(orgScope(org), {
    workspaceId: wsp,
    ownerId: user,
    name: 'Base',
  });
  return { org, user, base: base.id };
}

async function state(db: Db, field: FieldRow): Promise<string | null> {
  const row = await db.kysely
    .selectFrom('meta.fields')
    .select('compute_state')
    .where('id', '=', field.id)
    .executeTakeFirstOrThrow();
  return row.compute_state;
}

async function columnValues(db: Db, table: string, field: FieldRow): Promise<string[]> {
  const { rows } = await sql<{ v: string | null }>`
    SELECT ${sql.ref(field.db_column_name ?? '')}::text AS v
      FROM ${sql.table(`data.${table}`)} ORDER BY __auto
  `.execute(db.kysely);
  return rows.map((row) => row.v ?? 'null');
}

describe('worker: computed.recompute (T458)', () => {
  let database: TestDatabase;
  let db: Db;
  let worker: WorkerHandle;
  let captured: CapturedLogger;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    captured = captureLogger();
    worker = await createWorker(testConfig(database.url), {
      logger: captured.logger,
      pollIntervalMs: 200,
    });
  });

  afterAll(async () => {
    await worker.close();
    await db.destroy();
    await database.drop();
  });

  it('a queued every-record recompute runs after its debounce; the field ends ready', async () => {
    const { org, user, base } = await seed(db, 'WorkerRecompute1');
    const scope = orgScope(org);
    const context = { ...systemAuditContext(), actor: { type: 'user' as const, id: user } };
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const { table } = await schema.createTable(
      scope,
      { baseId: base, name: 'T', primaryFieldName: 'Name' },
      context,
    );
    const n = await schema.addField(scope, table.id, { name: 'n', type: 'number' }, context);
    // TEST FIXTURE: rows written directly.
    await sql`INSERT INTO ${sql.table(`data.${table.db_table_name}`)} (__id, ${sql.ref(n.db_column_name ?? '')})
      SELECT 'rec_' || lpad(g::text, 16, '0'), g FROM generate_series(1, 12) AS g`.execute(
      db.kysely,
    );
    const big = await schema.addField(
      scope,
      table.id,
      {
        name: 'big',
        type: 'formula',
        options: { expression: 'COUNTIF([T], CurrentValue.[n] > 10)' },
      },
      context,
    );
    await waitFor(async () => (await state(db, big)) === 'ready', { what: 'the backfill' });
    expect(new Set(await columnValues(db, table.db_table_name, big))).toEqual(new Set(['2']));

    // TEST FIXTURE: values changed behind the services' back, then a change
    // of every record of `n` (what a conversion or a renamed option does).
    await sql`UPDATE ${sql.table(`data.${table.db_table_name}`)} SET ${sql.ref(n.db_column_name ?? '')} = 100`.execute(
      db.kysely,
    );
    const result = await db.withTx((tx) =>
      new ComputedRecomputeService(db).enqueue(tx, {
        organizationId: org,
        changes: [{ kind: 'fields', baseId: base, tableId: table.id, fieldIds: [n.id] }],
      }),
    );
    expect(result.deferred).toEqual([
      { baseId: base, tableId: table.id, fieldId: big.id, rows: 'all' },
    ]);
    expect(await state(db, big)).toBe('recomputing');
    const [job] = (await queuedJobs(db, 'computed.recompute')).filter(
      (item) => item.payload['field_id'] === big.id,
    );
    // Debounced (ADR-18 §5): runs about 2 s after the write.
    expect(job?.run_at.getTime()).toBeGreaterThan(Date.now());

    await waitFor(async () => (await state(db, big)) === 'ready', {
      what: 'the recompute job',
    });
    expect(new Set(await columnValues(db, table.db_table_name, big))).toEqual(new Set(['12']));
    const queue = await db.kysely
      .selectFrom('meta.computed_recompute_queue')
      .selectAll()
      .where('organization_id', '=', org)
      .execute();
    expect(queue).toEqual([]);
    await waitFor(async () =>
      Promise.resolve(captured.lines.some((line) => line.msg === 'computed.recompute finished')),
    );
  });
});

describe('computed.recompute without a running worker: lock wait vs statement timeout (T474)', () => {
  let database: TestDatabase;
  let db: Db;
  const helpers = { job: { id: '1' } } as unknown as JobHelpers;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  /**
   * A table `T` (`n` = 1…rows) with a ready stored formula, then every
   * record of `n` rewritten behind the services' back and queued for
   * `computed.recompute` (what a conversion or a renamed option does).
   */
  async function recomputing(key: string, expression: string, rows: number) {
    const { org, user, base } = await seed(db, key);
    const scope = orgScope(org);
    const context = { ...systemAuditContext(), actor: { type: 'user' as const, id: user } };
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const { table } = await schema.createTable(
      scope,
      { baseId: base, name: 'T', primaryFieldName: 'Name' },
      context,
    );
    const n = await schema.addField(scope, table.id, { name: 'n', type: 'number' }, context);
    const formula = await schema.addField(
      scope,
      table.id,
      { name: 'f', type: 'formula', options: { expression } },
      context,
    );
    // Backfilled while the table is empty (instant), then ready.
    const records = new RecordMutationService(db, { schema, defaultTimeZone: 'UTC' });
    await records.backfillComputedBatch(scope, {
      fieldId: formula.id,
      afterAuto: 0n,
      limit: 10,
      statementTimeoutMs: 30_000,
    });
    await schema.finishComputedBackfill(scope, formula.id, { status: 'ready' });
    // TEST FIXTURE: rows written directly, then a change of every record of `n`.
    await sql`INSERT INTO ${sql.table(`data.${table.db_table_name}`)} (__id, ${sql.ref(n.db_column_name ?? '')})
      SELECT 'rec_' || lpad(g::text, 16, '0'), g FROM generate_series(1, ${rows}::int) AS g`.execute(
      db.kysely,
    );
    const result = await db.withTx((tx) =>
      new ComputedRecomputeService(db).enqueue(tx, {
        organizationId: org,
        changes: [{ kind: 'fields', baseId: base, tableId: table.id, fieldIds: [n.id] }],
      }),
    );
    expect(result.deferred.map((item) => item.fieldId)).toEqual([formula.id]);
    expect(await state(db, formula)).toBe('recomputing');
    return { org, schema, table, formula };
  }

  async function fieldState(field: FieldRow) {
    return db.kysely
      .selectFrom('meta.fields')
      .select(['compute_state', 'compute_error'])
      .where('id', '=', field.id)
      .executeTakeFirstOrThrow();
  }

  it('a batch blocked by rows another transaction holds waits, then finishes: field ready', async () => {
    const { org, schema, table, formula } = await recomputing('WorkerRecompute2', '[n] * 2', 12);
    // A short lock_timeout so each attempt waits little; the job waits longer in total.
    const records = new RecordMutationService(db, {
      schema,
      defaultTimeZone: 'UTC',
      lockTimeoutMs: 200,
    });
    const data = sql.table(`data.${table.db_table_name}`);
    // Another transaction (an import, a bulk write) holds a row for 2.5 s:
    // past the batch's lock_timeout and past its statement_timeout, which a
    // lock wait alone used to hit (the field ended TIMEOUT before T474).
    let locked = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.withTx(async (tx) => {
      await sql`SELECT __id FROM ${data} WHERE __id = 'rec_0000000000000003' FOR UPDATE`.execute(
        tx,
      );
      locked();
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    });
    await holding;
    const captured = captureLogger();
    const task = createComputedRecomputeTask({
      schema,
      records,
      logger: captured.logger,
      statementTimeoutMs: 1_000,
    });
    await task({ organization_id: org, field_id: formula.id }, helpers);
    await holder;

    expect(await fieldState(formula)).toEqual({ compute_state: 'ready', compute_error: null });
    expect(await columnValues(db, table.db_table_name, formula)).toEqual(
      Array.from({ length: 12 }, (_, i) => String((i + 1) * 2)),
    );
    const waits = captured.lines.filter(
      (line) => line.msg === 'computed.recompute: batch waited for locks, retrying',
    );
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]).toMatchObject({ error_code: 'SCHEMA_LOCKED', sqlstate: '55P03' });
    expect(captured.raw()).not.toContain('canceling statement');
    expect(captured.lines.map((line) => line.msg)).toContain('computed.recompute finished');
  });

  it('an expression really too slow times out twice (half the rows the second time): TIMEOUT', async () => {
    // A FILTER over the whole table per row: far slower than the 50 ms given below.
    const { org, schema, formula } = await recomputing(
      'WorkerRecompute3',
      '[T].FILTER(CurrentValue.[n] = [n]).[n].COUNTA()',
      20_000,
    );
    const records = new RecordMutationService(db, { schema, defaultTimeZone: 'UTC' });
    const captured = captureLogger();
    const task = createComputedRecomputeTask({
      schema,
      records,
      logger: captured.logger,
      statementTimeoutMs: 50,
    });
    await task({ organization_id: org, field_id: formula.id }, helpers);

    expect(await fieldState(formula)).toEqual({
      compute_state: 'error',
      compute_error: { code: 'TIMEOUT', refs: [] },
    });
    const halved = captured.lines.find(
      (line) =>
        line.msg ===
        'computed.recompute: batch past its statement timeout, retrying with half the rows',
    );
    expect(halved).toMatchObject({ batch_size: 2_500, error_code: 'QUERY_TIMEOUT' });
    expect(captured.lines.map((line) => line.msg)).toContain(
      'computed.recompute: batch past its statement timeout twice, field marked TIMEOUT',
    );
    // Its queue was dropped.
    const queue = await db.kysely
      .selectFrom('meta.computed_recompute_queue')
      .selectAll()
      .where('field_id', '=', formula.id)
      .execute();
    expect(queue).toEqual([]);
  });
});
