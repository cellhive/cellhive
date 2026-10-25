import { type Id } from '@cellhive/contracts';
import {
  AppError,
  BasesRepository,
  JobsRepository,
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
import {
  COMPUTED_BACKFILL_BATCH_ATTEMPTS,
  createComputedBackfillTask,
} from '../../src/tasks/computed-backfill.js';

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

async function columnValues(db: Db, table: string, field: FieldRow): Promise<string[]> {
  const current = await db.kysely
    .selectFrom('meta.fields')
    .select('db_column_name')
    .where('id', '=', field.id)
    .executeTakeFirstOrThrow();
  const { rows } = await sql<{ v: string | null }>`
    SELECT ${sql.ref(current.db_column_name ?? '')}::text AS v
      FROM ${sql.table(`data.${table}`)} ORDER BY __auto
  `.execute(db.kysely);
  return rows.map((row) => row.v ?? 'null');
}

describe('worker: computed.backfill (T456)', () => {
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

  it('computes a stored formula, then the stored formula reading it; fields end ready', async () => {
    const { org, user, base } = await seed(db, 'WorkerComputed01');
    const scope = orgScope(org);
    const context = { ...systemAuditContext(), actor: { type: 'user' as const, id: user } };
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const { table } = await schema.createTable(
      scope,
      { baseId: base, name: 'T', primaryFieldName: 'Name' },
      context,
    );
    const amount = await schema.addField(scope, table.id, { name: 'n', type: 'number' }, context);
    const column = sql.ref(amount.db_column_name ?? '');
    await sql`INSERT INTO ${sql.table(`data.${table.db_table_name}`)} (__id, ${column})
      SELECT 'rec_' || lpad(g::text, 16, '0'), g FROM generate_series(1, 12) AS g`.execute(
      db.kysely,
    );

    const double = await schema.addField(
      scope,
      table.id,
      { name: 'double', type: 'formula', options: { expression: '[n] * 2' } },
      context,
    );
    const jobs = new JobsRepository(db);
    await waitFor(
      async () => {
        const row = await db.kysely
          .selectFrom('meta.fields')
          .select('compute_state')
          .where('id', '=', double.id)
          .executeTakeFirstOrThrow();
        return row.compute_state === 'ready';
      },
      { what: 'the formula to be backfilled' },
    );
    expect(await columnValues(db, table.db_table_name, double)).toEqual(
      Array.from({ length: 12 }, (_, i) => String((i + 1) * 2)),
    );
    const plus = await schema.addField(
      scope,
      table.id,
      { name: 'plus', type: 'formula', options: { expression: '[double] + 1' } },
      context,
    );
    await waitFor(
      async () =>
        (
          await db.kysely
            .selectFrom('meta.fields')
            .select('compute_state')
            .where('id', '=', plus.id)
            .executeTakeFirstOrThrow()
        ).compute_state === 'ready',
      { what: 'the second formula' },
    );

    // Changing the first recomputes it and then its reader, in that order.
    const changed = await schema.updateField(
      scope,
      double.id,
      { optionsPatch: { expression: '[n] * 3' } },
      context,
    );
    expect(changed.compute_state).toBe('backfilling');
    await waitFor(
      async () => {
        const rows = await db.kysely
          .selectFrom('meta.fields')
          .select('compute_state')
          .where('id', 'in', [double.id, plus.id])
          .execute();
        return rows.every((row) => row.compute_state === 'ready');
      },
      { what: 'both formulas to be recomputed' },
    );
    expect(await columnValues(db, table.db_table_name, plus)).toEqual(
      Array.from({ length: 12 }, (_, i) => String((i + 1) * 3 + 1)),
    );
    // Each field turns `ready` before its job is marked `succeeded` (two
    // commits), so the job of the last field may still be `running` here.
    const jobsOfTable = () =>
      db.kysely
        .selectFrom('meta.jobs')
        .selectAll()
        .where('organization_id', '=', org)
        .where('type', '=', 'computed.backfill')
        .orderBy('created_at')
        .orderBy('id')
        .execute();
    await waitFor(
      async () =>
        (await jobsOfTable()).every((job) => ['succeeded', 'failed'].includes(job.status)),
      {
        what: 'the backfill jobs to end',
      },
    );
    const done = await jobsOfTable();
    expect(done.map((job) => job.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(await jobs.getById(scope, done[2]?.id as Id<'job'>)).toMatchObject({
      progress: 1,
      result: { fields: 2, rows: 24, timeouts: 0 },
    });
    await waitFor(async () =>
      Promise.resolve(captured.lines.some((line) => line.msg === 'computed.backfill finished')),
    );
    expect(await schema.checkConsistency(scope, table.id)).toEqual([]);
  });
});

describe('computed.backfill without a running worker: timeout and supersession (T456)', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  function helpersOf(payload: Record<string, unknown>, attempts = 1): JobHelpers {
    return {
      job: {
        id: '1',
        task_identifier: 'computed.backfill',
        payload,
        priority: 0,
        attempts,
        max_attempts: 5,
        key: null,
        flags: null,
        job_queue_id: null,
      },
      getQueueName: () => Promise.resolve(null),
    } as unknown as JobHelpers;
  }

  it('a batch past its statement timeout marks the field TIMEOUT; a newer definition cancels', async () => {
    const { org, user, base } = await seed(db, 'WorkerComputed02');
    const scope = orgScope(org);
    const context = { ...systemAuditContext(), actor: { type: 'user' as const, id: user } };
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const records = new RecordMutationService(db, { schema, defaultTimeZone: 'UTC' });
    const { table } = await schema.createTable(
      scope,
      { baseId: base, name: 'Big', primaryFieldName: 'Name' },
      context,
    );
    const n = await schema.addField(scope, table.id, { name: 'n', type: 'number' }, context);
    await sql`INSERT INTO ${sql.table(`data.${table.db_table_name}`)} (__id, ${sql.ref(n.db_column_name ?? '')})
      SELECT 'rec_' || lpad(g::text, 16, '0'), g % 97 FROM generate_series(1, 20000) AS g`.execute(
      db.kysely,
    );
    // A FILTER over the whole table per row: far slower than the 50 ms given below.
    const slow = await schema.addField(
      scope,
      table.id,
      {
        name: 'same n',
        type: 'formula',
        options: { expression: '[Big].FILTER(CurrentValue.[n] = [n]).[n].COUNTA()' },
      },
      context,
    );
    expect(slow.compute_mode).toBe('stored');
    const [queued] = await queuedJobs(db, 'computed.backfill');
    if (queued === undefined) throw new Error('no job queued');
    const captured = captureLogger();
    const task = createComputedBackfillTask({
      db,
      schema,
      records,
      jobs: new JobsRepository(db),
      logger: captured.logger,
      statementTimeoutMs: 50,
    });
    await task(queued.payload as never, helpersOf(queued.payload));
    const field = await db.kysely
      .selectFrom('meta.fields')
      .selectAll()
      .where('id', '=', slow.id)
      .executeTakeFirstOrThrow();
    expect(field).toMatchObject({
      compute_state: 'error',
      compute_error: { code: 'TIMEOUT', refs: [] },
    });
    expect(
      captured.lines.some(
        (line) => typeof line.msg === 'string' && line.msg.includes('statement timeout'),
      ),
    ).toBe(true);
    // T474: TIMEOUT only after a second attempt with half the rows.
    const halved = captured.lines.find(
      (line) =>
        line.msg ===
        'computed.backfill: batch past its statement timeout, retrying with half the rows',
    );
    expect(halved).toMatchObject({ batch_size: 2500, error_code: 'QUERY_TIMEOUT' });
    expect(captured.lines.map((line) => line.msg)).toContain(
      'computed.backfill: batch past its statement timeout twice, field marked TIMEOUT',
    );
    const audits = await db.kysely
      .selectFrom('meta.audit_logs')
      .select(['action', 'after'])
      .where('entity_id', '=', slow.id)
      .where('action', '=', 'field.updated')
      .execute();
    expect(audits).toContainEqual({
      action: 'field.updated',
      after: { compute_error: field.compute_error },
    });

    // A newer definition: the older job stops without writing.
    const newer = await schema.updateField(
      scope,
      slow.id,
      { optionsPatch: { expression: '[n] + 1' } },
      context,
    );
    expect(newer.compute_state).toBe('backfilling');
    const stale = { ...queued.payload, job_id: undefined };
    const jobs = new JobsRepository(db);
    const staleJob = await jobs.create(scope, { type: 'computed.backfill', createdBy: null });
    const stalePayload = { ...stale, job_id: staleJob.id };
    await task(stalePayload as never, helpersOf(stalePayload));
    expect((await jobs.getById(scope, staleJob.id))?.status).toBe('cancelled');
  });

  async function setup(key: string, expression: string, rows: number) {
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
    if (rows > 0) {
      await sql`INSERT INTO ${sql.table(`data.${table.db_table_name}`)} (__id, ${sql.ref(n.db_column_name ?? '')})
        SELECT 'rec_' || lpad(g::text, 16, '0'), g FROM generate_series(1, ${rows}::int) AS g`.execute(
        db.kysely,
      );
    }
    const formula = await schema.addField(
      scope,
      table.id,
      { name: 'f', type: 'formula', options: { expression } },
      context,
    );
    const [queued] = (await queuedJobs(db, 'computed.backfill')).filter(
      (job) => job.payload['field_id'] === formula.id,
    );
    if (queued === undefined) throw new Error('no job queued');
    return { scope, schema, table, formula, queued, jobId: queued.payload['job_id'] as Id<'job'> };
  }

  async function fieldState(fieldId: Id<'fld'>) {
    return db.kysely
      .selectFrom('meta.fields')
      .select(['compute_state', 'compute_error'])
      .where('id', '=', fieldId)
      .executeTakeFirstOrThrow();
  }

  function lockTimeoutError(): AppError {
    return new AppError('SCHEMA_LOCKED', {
      detail: 'locked',
      cause: Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
      }),
    });
  }

  it('a batch blocked by rows another transaction holds waits, then finishes: field ready (T474)', async () => {
    const { scope, schema, table, formula, queued, jobId } = await setup(
      'WorkerComputed03',
      '[n] * 2',
      12,
    );
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
      await sql`SELECT __id FROM ${data} WHERE __id = 'rec_0000000000000007' FOR UPDATE`.execute(
        tx,
      );
      locked();
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    });
    await holding;
    const captured = captureLogger();
    const task = createComputedBackfillTask({
      db,
      schema,
      records,
      jobs: new JobsRepository(db),
      logger: captured.logger,
      statementTimeoutMs: 1_000,
    });
    await task(queued.payload as never, helpersOf(queued.payload));
    await holder;

    expect(await fieldState(formula.id)).toEqual({ compute_state: 'ready', compute_error: null });
    expect(await columnValues(db, table.db_table_name, formula)).toEqual(
      Array.from({ length: 12 }, (_, i) => String((i + 1) * 2)),
    );
    expect((await new JobsRepository(db).getById(scope, jobId))?.status).toBe('succeeded');
    const waits = captured.lines.filter(
      (line) => line.msg === 'computed.backfill: batch waited for locks, retrying',
    );
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]).toMatchObject({ error_code: 'SCHEMA_LOCKED', sqlstate: '55P03' });
    // Codes and ids only: no database message (it can quote values).
    expect(captured.raw()).not.toContain('canceling statement');
  });

  it('a job still blocked fails for graphile to retry; the retry goes on from its batch (T474)', async () => {
    const { scope, schema, table, formula, queued, jobId } = await setup(
      'WorkerComputed04',
      '[n] * 3',
      12,
    );
    const records = new RecordMutationService(db, { schema, defaultTimeZone: 'UTC' });
    // The second batch keeps waiting for locks during the first attempt.
    const cursors: string[] = [];
    let blocked = true;
    const flaky: Pick<RecordMutationService, 'backfillComputedBatch'> = {
      backfillComputedBatch: (batchScope, input) => {
        cursors.push(input.afterAuto.toString());
        if (blocked && input.afterAuto > 0n) return Promise.reject(lockTimeoutError());
        return records.backfillComputedBatch(batchScope, input);
      },
    };
    const captured = captureLogger();
    const task = createComputedBackfillTask({
      db,
      schema,
      records: flaky,
      jobs: new JobsRepository(db),
      logger: captured.logger,
      batchSize: 5,
      sleep: () => Promise.resolve(),
    });
    await expect(task(queued.payload as never, helpersOf(queued.payload, 1))).rejects.toMatchObject(
      { code: 'SCHEMA_LOCKED' },
    );
    // Not the last attempt: the job stays running, the field backfilling.
    const jobs = new JobsRepository(db);
    expect((await jobs.getById(scope, jobId))?.status).toBe('running');
    expect(await fieldState(formula.id)).toEqual({
      compute_state: 'backfilling',
      compute_error: null,
    });
    expect(cursors[0]).toBe('0');
    const stoppedAt = cursors[1];
    expect(stoppedAt).not.toBe('0');
    expect(cursors.slice(1).every((cursor) => cursor === stoppedAt)).toBe(true);
    expect(cursors).toHaveLength(1 + COMPUTED_BACKFILL_BATCH_ATTEMPTS);

    // graphile-worker's retry: from the blocked batch, not from the first row.
    blocked = false;
    cursors.length = 0;
    await task(queued.payload as never, helpersOf(queued.payload, 2));
    expect(cursors[0]).toBe(stoppedAt);
    expect(cursors).not.toContain('0');
    expect(await jobs.getById(scope, jobId)).toMatchObject({
      status: 'succeeded',
      result: { fields: 1, rows: 12, timeouts: 0 },
    });
    expect(await fieldState(formula.id)).toEqual({ compute_state: 'ready', compute_error: null });
    expect(await columnValues(db, table.db_table_name, formula)).toEqual(
      Array.from({ length: 12 }, (_, i) => String((i + 1) * 3)),
    );
    expect(captured.lines.find((line) => line.msg === 'computed.backfill finished')).toMatchObject({
      resumed: true,
      resumed_from_field: 0,
    });
  });

  it('the last attempt of a blocked job ends it failed, never TIMEOUT (T474)', async () => {
    const { scope, schema, formula, queued, jobId } = await setup('WorkerComputed05', '[n] + 1', 0);
    const task = createComputedBackfillTask({
      db,
      schema,
      records: {
        backfillComputedBatch: () =>
          Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' })),
      },
      jobs: new JobsRepository(db),
      logger: captureLogger().logger,
      sleep: () => Promise.resolve(),
    });
    await expect(task(queued.payload as never, helpersOf(queued.payload, 5))).rejects.toThrow(
      'deadlock detected',
    );
    expect(await new JobsRepository(db).getById(scope, jobId)).toMatchObject({
      status: 'failed',
      error: { code: 'INTERNAL' },
    });
    expect(await fieldState(formula.id)).toEqual({
      compute_state: 'backfilling',
      compute_error: null,
    });
  });
});
