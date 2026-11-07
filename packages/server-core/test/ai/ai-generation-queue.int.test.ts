import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AiGenerationQueueRepository,
  enqueueAiGeneration,
  JobsRepository,
  listAiGenerationRescueOrganizations,
  measureAiGenerationQueue,
  orgScope,
  SchemaService,
  systemAuditContext,
  withTxScope,
  type Db,
} from '../../src/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A: Id<'org'> = 'org_AiQueueOrgAAAAA1';
const ORG_B: Id<'org'> = 'org_AiQueueOrgBBBBB1';
const ORG_C: Id<'org'> = 'org_AiQueueOrgCCCCC1';
const ORG_D: Id<'org'> = 'org_AiQueueOrgDDDDD1';
const REC_1: Id<'rec'> = 'rec_AiQueueRecord001';
const REC_2: Id<'rec'> = 'rec_AiQueueRecord002';
const REC_3: Id<'rec'> = 'rec_AiQueueRecord003';

/** Names of the indexes a plan (`EXPLAIN (FORMAT JSON)`) reads. */
function indexesOf(plan: unknown): string[] {
  if (Array.isArray(plan)) return plan.flatMap(indexesOf);
  if (typeof plan !== 'object' || plan === null) return [];
  const node = plan as Record<string, unknown>;
  return [
    ...(typeof node['Index Name'] === 'string' ? [node['Index Name']] : []),
    ...Object.values(node).flatMap(indexesOf),
  ];
}

/** Relations a plan reads with a sequential scan. */
function seqScansOf(plan: unknown): string[] {
  if (Array.isArray(plan)) return plan.flatMap(seqScansOf);
  if (typeof plan !== 'object' || plan === null) return [];
  const node = plan as Record<string, unknown>;
  return [
    ...(node['Node Type'] === 'Seq Scan' ? [String(node['Relation Name'])] : []),
    ...Object.values(node).flatMap(seqScansOf),
  ];
}

/**
 * BACKLOG T910 (migration 0056): `meta.ai_generation_queue` stays inside its
 * organization (tenant isolation of `AiGenerationQueueRepository`), rows
 * merge when queued again, only the holder of a lease finishes a row (a row
 * queued again meanwhile is generated again), retries wait, pause/resume,
 * and the two cross-tenant lookups of the rescue cron and the gauge.
 */
describe('AI generation queue (T910)', () => {
  let database: TestDatabase;
  let db: Db;
  let fieldA: Id<'fld'>;
  let fieldB: Id<'fld'>;
  let fieldC: Id<'fld'>;
  let fieldD: Id<'fld'>;
  const queue = () => new AiGenerationQueueRepository(db);
  const scopeA = () => orgScope(ORG_A);
  const scopeB = () => orgScope(ORG_B);
  /** AI on with record data (what `requireAi` asks), or changed by `values`. */
  const aiOn = async (orgId: Id<'org'>, values: Record<string, unknown> = {}) => {
    const row = {
      enabled: true,
      provider_base_url: 'https://ai.example.test/v1',
      model: 'm',
      allow_record_data: true,
      daily_token_limit: 10_000,
      ...values,
    };
    await sql`
      INSERT INTO meta.ai_settings (organization_id, enabled, provider_base_url, model,
                                    allow_record_data, daily_token_limit)
      VALUES (${orgId}, ${row.enabled}, ${row.provider_base_url}, ${row.model},
              ${row.allow_record_data}, ${row.daily_token_limit})
      ON CONFLICT (organization_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, provider_base_url = EXCLUDED.provider_base_url,
             model = EXCLUDED.model, allow_record_data = EXCLUDED.allow_record_data,
             daily_token_limit = EXCLUDED.daily_token_limit`.execute(db.kysely);
  };
  const clearAll = async () => {
    await sql`DELETE FROM meta.ai_generation_queue`.execute(db.kysely);
    await sql`DELETE FROM meta.ai_settings`.execute(db.kysely);
    await sql`DELETE FROM meta.ai_usage_daily`.execute(db.kysely);
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
  };

  const textField = async (orgId: Id<'org'>, baseId: Id<'bse'>): Promise<Id<'fld'>> => {
    const schema = new SchemaService(db, { maxFieldsPerTable: 50 });
    const { table } = await schema.createTable(
      orgScope(orgId),
      { baseId, name: 'Tickets', primaryFieldName: 'Title' },
      systemAuditContext(),
    );
    const field = await schema.addField(
      orgScope(orgId),
      table.id,
      { name: 'Summary', type: 'text' },
      systemAuditContext(),
    );
    return field.id;
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    const a = await seedTenant(db, ORG_A);
    const b = await seedTenant(db, ORG_B);
    const c = await seedTenant(db, ORG_C);
    const d = await seedTenant(db, ORG_D);
    fieldA = await textField(ORG_A, a.baseId);
    fieldB = await textField(ORG_B, b.baseId);
    fieldC = await textField(ORG_C, c.baseId);
    fieldD = await textField(ORG_D, d.baseId);
    // AI fields (the rescue looks for lost jobs among them).
    await sql`UPDATE meta.fields SET options = options || '{"ai": {"task": "summarize", "prompt": "x"}}'::jsonb
               WHERE id IN (${fieldA}, ${fieldB}, ${fieldC}, ${fieldD})`.execute(db.kysely);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('keeps rows inside their organization (tenant isolation)', async () => {
    expect(await queue().enqueue(scopeA(), fieldA, [REC_1, REC_2, REC_1])).toBe(2);
    // Another organization cannot queue rows of A's field (composite FK) …
    await expect(queue().enqueue(scopeB(), fieldA, [REC_3])).rejects.toThrow();
    // … nor see, take, pause, finish or clear A's rows.
    expect((await queue().statesOf(scopeB(), [fieldA])).get(fieldA)).toEqual({
      queued: 0,
      failed: 0,
      paused: 0,
      paused_reason: null,
      paused_detail: null,
      retry_at: null,
    });
    expect(await queue().cellStates(scopeB(), [fieldA], [REC_1, REC_2])).toEqual([]);
    expect(await queue().take(scopeB(), fieldA, 20)).toEqual([]);
    expect(await queue().pause(scopeB(), 'quota')).toEqual([]);
    expect(await queue().dueFields(scopeB())).toEqual([]);
    expect(await queue().recordIdsOf(scopeB(), fieldA, 'queued')).toEqual([]);
    await queue().clear(scopeB(), fieldA);
    expect(await queue().recordIdsOf(scopeA(), fieldA, 'queued')).toEqual([REC_1, REC_2]);
    expect((await queue().statesOf(scopeA(), [fieldA])).get(fieldA)?.queued).toBe(2);
    await queue().enqueue(scopeB(), fieldB, [REC_3]);
    expect(await queue().recordIdsOf(scopeA(), fieldB, 'queued')).toEqual([]);
    await queue().clear(scopeA(), fieldA);
    await queue().clear(scopeB(), fieldB);
  });

  it('lets only the holder of a lease finish a row; a row queued again meanwhile stays', async () => {
    await queue().enqueue(scopeA(), fieldA, [REC_1, REC_2]);
    const taken = await queue().take(scopeA(), fieldA, 20);
    expect(taken.map((row) => [row.recordId, row.attempts])).toEqual([
      [REC_1, 1],
      [REC_2, 1],
    ]);
    // Nothing more to take while they run.
    expect(await queue().take(scopeA(), fieldA, 20)).toEqual([]);
    // A source of REC_2 changes during the call: the row is queued again.
    await queue().enqueue(scopeA(), fieldA, [REC_2]);
    await queue().finish(scopeA(), fieldA, taken);
    expect(await queue().recordIdsOf(scopeA(), fieldA, 'queued')).toEqual([REC_2]);
    expect(await queue().cellStates(scopeA(), [fieldA], [REC_1, REC_2])).toEqual([
      { field_id: fieldA, record_id: REC_2, status: 'queued', reason: null },
    ]);
    await queue().clear(scopeA(), fieldA);
  });

  it('waits before a retry, fails with a code, pauses and resumes', async () => {
    await queue().enqueue(scopeA(), fieldA, [REC_1, REC_2, REC_3]);
    const taken = await queue().take(scopeA(), fieldA, 20);
    expect(taken.map((row) => row.recordId)).toEqual([REC_1, REC_2, REC_3]);
    await queue().requeue(scopeA(), fieldA, taken.slice(0, 1), { delayMs: 60_000 });
    await queue().fail(scopeA(), fieldA, taken.slice(1, 2), 'invalid_output');
    await queue().requeue(scopeA(), fieldA, taken.slice(2), { refund: true });
    // REC_1 waits a minute; REC_3 is due now with its try given back.
    const due = await queue().take(scopeA(), fieldA, 20);
    expect(due.map((row) => [row.recordId, row.attempts])).toEqual([[REC_3, 1]]);
    await queue().requeue(scopeA(), fieldA, due);
    expect(await queue().recordIdsOf(scopeA(), fieldA, 'failed')).toEqual([REC_2]);

    expect(await queue().pause(scopeA(), 'quota')).toEqual([fieldA]);
    expect((await queue().statesOf(scopeA(), [fieldA])).get(fieldA)).toEqual({
      queued: 0,
      failed: 1,
      paused: 2,
      paused_reason: 'quota',
      paused_detail: null,
      retry_at: null,
    });
    // Another reason does not resume them.
    expect(await queue().resume(scopeA(), ['ai_disabled'])).toEqual([]);
    expect(await queue().resume(scopeA(), ['quota'], fieldA)).toEqual([fieldA]);
    expect(await queue().recordIdsOf(scopeA(), fieldA, 'queued')).toEqual([REC_1, REC_3]);
    await queue().clear(scopeA(), fieldA);
  });

  it('T1002: pauses with what the provider rejected; resumes by reason, never across organizations', async () => {
    await queue().enqueue(scopeA(), fieldA, [REC_1, REC_2]);
    await queue().enqueue(scopeB(), fieldB, [REC_3]);
    expect(await queue().pause(scopeA(), 'provider_error', { detail: 'unauthorized' })).toEqual([
      fieldA,
    ]);
    expect((await queue().statesOf(scopeA(), [fieldA])).get(fieldA)).toMatchObject({
      paused: 2,
      paused_reason: 'provider_error',
      paused_detail: 'unauthorized',
    });
    expect(await queue().cellStates(scopeA(), [fieldA], [REC_1])).toEqual([
      {
        field_id: fieldA,
        record_id: REC_1,
        status: 'paused',
        reason: 'provider_error:unauthorized',
      },
    ]);
    // B's queue is untouched; resuming another reason or in B changes nothing of A.
    expect(await queue().recordIdsOf(scopeB(), fieldB, 'queued')).toEqual([REC_3]);
    expect(
      await queue().resume(scopeA(), ['quota', 'ai_disabled', 'record_data_disabled']),
    ).toEqual([]);
    expect(await queue().resume(scopeB(), ['provider_error'])).toEqual([]);
    expect(await queue().resume(scopeA(), ['provider_error'])).toEqual([fieldA]);
    expect(await queue().recordIdsOf(scopeA(), fieldA, 'queued')).toEqual([REC_1, REC_2]);
    expect((await queue().statesOf(scopeA(), [fieldA])).get(fieldA)).toMatchObject({
      queued: 2,
      paused: 0,
      paused_reason: null,
      paused_detail: null,
    });
    await queue().clear(scopeA(), fieldA);
    await queue().clear(scopeB(), fieldB);
  });

  it('T1002: backs an organization off — nothing taken until then, tries kept, rows queued later wait too', async () => {
    const now = new Date();
    const until = new Date(now.getTime() + 30_000);
    await queue().enqueue(scopeA(), fieldA, [REC_1, REC_2]);
    await queue().enqueue(scopeB(), fieldB, [REC_3]);
    const [first, second] = await queue().take(scopeA(), fieldA, 2, undefined, now);
    if (first === undefined || second === undefined) throw new Error('nothing taken');
    // REC_1's try is given back; REC_2 waits for its own retry later than the back-off.
    await queue().requeue(scopeA(), fieldA, [first], { refund: true });
    await queue().requeue(scopeA(), fieldA, [second], { delayMs: 120_000 });
    expect(await queue().backOff(scopeA(), until)).toEqual([fieldA]);
    expect(await queue().backOffUntil(scopeA(), now)).toEqual(until);
    expect(await queue().backOffUntil(scopeB(), now)).toBeNull();
    expect((await queue().statesOf(scopeA(), [fieldA])).get(fieldA)?.retry_at).toBe(
      until.toISOString(),
    );
    expect((await queue().statesOf(scopeB(), [fieldB])).get(fieldB)?.retry_at).toBeNull();
    // Nothing of A is taken, a row queued meanwhile neither; B goes on.
    await queue().enqueue(scopeA(), fieldA, [REC_3]);
    const later = new Date(now.getTime() + 10_000);
    expect(await queue().take(scopeA(), fieldA, 20, undefined, later)).toEqual([]);
    expect((await queue().take(scopeB(), fieldB, 20, undefined, later)).length).toBe(1);
    expect((await queue().dueFields(scopeA(), later)).map((item) => item.dueAt.getTime())).toEqual([
      until.getTime(),
    ]);
    // After it: the rows due go on with their tries; REC_2 keeps its own later retry.
    const after = new Date(until.getTime() + 1_000);
    expect(await queue().backOffUntil(scopeA(), after)).toBeNull();
    const taken = await queue().take(scopeA(), fieldA, 20, undefined, after);
    expect(taken.map((row) => [row.recordId, row.attempts])).toEqual([
      [REC_1, 1],
      [REC_3, 1],
    ]);
    await queue().clear(scopeA(), fieldA);
    await queue().clear(scopeB(), fieldB);
  });

  it('gives expired leases back and lists the organizations the rescue must visit', async () => {
    await queue().enqueue(scopeA(), fieldA, [REC_1]);
    await queue().take(scopeA(), fieldA, 20, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A running row past its lease, and queued rows of B without an `ai.generate` job.
    await queue().enqueue(scopeB(), fieldB, [REC_2]);
    const list = () =>
      listAiGenerationRescueOrganizations(db.kysely, {
        now: new Date(),
        limit: 10,
        defaultTimeZone: 'UTC',
      });
    // B's job can only run with AI on.
    expect(await list()).toEqual([ORG_A]);
    await aiOn(ORG_B);
    expect(await list()).toEqual([ORG_A, ORG_B]);
    expect(await measureAiGenerationQueue(db)).toEqual({
      queued: 1,
      running: 1,
      failed: 0,
      paused: 0,
    });
    expect(await queue().releaseExpired(scopeB())).toEqual([]);
    expect(await queue().releaseExpired(scopeA())).toEqual([fieldA]);
    expect(await queue().recordIdsOf(scopeA(), fieldA, 'queued')).toEqual([REC_1]);
    await queue().clear(scopeA(), fieldA);
    await queue().clear(scopeB(), fieldB);
    await clearAll();
  });

  it('T1003: a generate request leaves invalid_output rows failed unless it retries them', async () => {
    await queue().enqueue(scopeA(), fieldA, [REC_1, REC_2, REC_3]);
    const taken = await queue().take(scopeA(), fieldA, 20);
    await queue().fail(scopeA(), fieldA, taken.slice(0, 1), 'invalid_output');
    await queue().fail(scopeA(), fieldA, taken.slice(1, 2), 'timeout');
    await queue().requeue(scopeA(), fieldA, taken.slice(2));
    const rows = async () =>
      (
        await sql<{ record_id: string; status: string; reason: string | null; attempts: number }>`
          SELECT record_id, status, reason, attempts FROM meta.ai_generation_queue
           WHERE field_id = ${fieldA} ORDER BY record_id`.execute(db.kysely)
      ).rows;
    expect(
      await queue().enqueue(scopeA(), fieldA, [REC_1, REC_2, REC_3], {
        retryInvalidOutput: false,
      }),
    ).toBe(2);
    expect(await rows()).toEqual([
      { record_id: REC_1, status: 'failed', reason: 'invalid_output', attempts: 1 },
      { record_id: REC_2, status: 'queued', reason: null, attempts: 0 },
      { record_id: REC_3, status: 'queued', reason: null, attempts: 0 },
    ]);
    // Another organization's request changes nothing of A.
    expect(await queue().enqueue(scopeB(), fieldA, [REC_1], { retryInvalidOutput: true })).toBe(0);
    expect((await rows())[0]).toMatchObject({ status: 'failed', attempts: 1 });
    // `failed` / `all` (and writes of a source) retry them, tries reset.
    expect(await queue().enqueue(scopeA(), fieldA, [REC_1])).toBe(1);
    expect((await rows())[0]).toEqual({
      record_id: REC_1,
      status: 'queued',
      reason: null,
      attempts: 0,
    });
    await queue().clear(scopeA(), fieldA);
  });

  it('T1003: counts, pages, due time and the running job of a field stay inside their organization', async () => {
    const jobs = new JobsRepository(db);
    const job = await jobs.create(scopeA(), {
      type: 'ai.generate',
      createdBy: null,
      result: { field_id: fieldA, rows: 3 },
    });
    await jobs.markRunning(scopeA(), job.id);
    await queue().enqueue(scopeA(), fieldA, [REC_3, REC_1, REC_2], { jobId: job.id });
    await queue().enqueue(scopeB(), fieldB, [REC_1]);

    expect(await queue().countOf(scopeA(), fieldA, 'queued')).toBe(3);
    expect(await queue().countOf(scopeB(), fieldA, 'queued')).toBe(0);
    expect(await queue().recordIdPage(scopeA(), fieldA, 'queued', null, 2)).toEqual([REC_1, REC_2]);
    expect(await queue().recordIdPage(scopeA(), fieldA, 'queued', REC_2, 2)).toEqual([REC_3]);
    expect(await queue().recordIdPage(scopeB(), fieldA, 'queued', null, 10)).toEqual([]);
    const now = new Date();
    expect((await queue().dueAt(scopeA(), fieldA, now))?.getTime()).toBe(now.getTime());
    expect(await queue().dueAt(scopeB(), fieldA, now)).toBeNull();
    expect(await queue().dueAt(scopeA(), fieldB, now)).toBeNull();
    // The organization backs off: the field is due when it ends.
    const until = new Date(now.getTime() + 30_000);
    await queue().backOff(scopeA(), until);
    expect(await queue().dueAt(scopeA(), fieldA, now)).toEqual(until);
    expect((await queue().dueAt(scopeB(), fieldB, now))?.getTime()).toBe(now.getTime());

    expect(await queue().runningJobOf(scopeA(), fieldA)).toBe(job.id);
    expect(await queue().runningJobOf(scopeB(), fieldA)).toBeNull();
    expect(await queue().runningJobOf(scopeA(), fieldB)).toBeNull();
    // Rows only paused or failed: the request no longer runs.
    await queue().pause(scopeA(), 'quota');
    expect(await queue().runningJobOf(scopeA(), fieldA)).toBeNull();
    await queue().resume(scopeA(), ['quota']);
    expect(await queue().runningJobOf(scopeA(), fieldA)).toBe(job.id);
    await jobs.markSucceeded(scopeA(), job.id, { rows: 3, failed: 0 });
    expect(await queue().runningJobOf(scopeA(), fieldA)).toBeNull();

    // One generate request of a field at a time; the lock needs the caller's transaction.
    await expect(queue().lockGenerate(scopeA(), fieldA)).rejects.toThrow(TypeError);
    const order: string[] = [];
    let waiting: Promise<void> = Promise.resolve();
    await db.withTx(async (tx) => {
      await queue().lockGenerate(withTxScope(scopeA(), tx), fieldA);
      waiting = db.withTx(async (inner) => {
        await queue().lockGenerate(withTxScope(scopeA(), inner), fieldA);
        order.push('second request');
      });
      // Another field does not wait.
      await db.withTx((inner) => queue().lockGenerate(withTxScope(scopeB(), inner), fieldB));
      await new Promise((resolve) => setTimeout(resolve, 100));
      order.push('first request ends');
    });
    await waiting;
    expect(order).toEqual(['first request ends', 'second request']);
    await clearAll();
  });

  it('T1003: pendingOfJob and failedOfJob read the job index; the back-off check its own (EXPLAIN)', async () => {
    const statements: string[] = [];
    const logged = createTestDb(database.url, { onQuery: (text) => statements.push(text) });
    const pool = new pg.Pool({ connectionString: database.url, max: 1 });
    try {
      // 20,000 rows of 200 generate requests, 2,000 queued by record writes (no job).
      await sql`
        INSERT INTO meta.ai_generation_queue (organization_id, field_id, record_id, status, job_id)
        SELECT ${ORG_A}, ${fieldA}, 'rec_Explain' || lpad(i::text, 9, '0'),
               CASE WHEN i % 7 = 0 THEN 'failed' ELSE 'queued' END,
               CASE WHEN i % 10 = 0 THEN NULL ELSE 'job_Explain' || lpad((i % 200)::text, 9, '0') END
          FROM generate_series(1, 20000) AS i`.execute(db.kysely);
      await sql`ANALYZE meta.ai_generation_queue`.execute(db.kysely);
      const plan = async (run: () => Promise<unknown>) => {
        statements.length = 0;
        await run();
        const text = statements.at(-1);
        if (text === undefined) throw new Error('no statement');
        const { rows } = await pool.query<{ 'QUERY PLAN': unknown }>(
          `EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${text}`,
        );
        return rows[0]?.['QUERY PLAN'];
      };
      const repo = new AiGenerationQueueRepository(logged);
      const job: Id<'job'> = 'job_Explain000000001';
      for (const run of [
        () => repo.pendingOfJob(scopeA(), job),
        () => repo.failedOfJob(scopeA(), job),
      ]) {
        const read = await plan(run);
        expect(indexesOf(read)).toContain('ai_generation_queue_job_idx');
        expect(seqScansOf(read)).toEqual([]);
      }
      expect(await repo.pendingOfJob(scopeA(), job)).toBe(86);
      // The next run of a batch, and taking rows: the organization's waiting rows only.
      const due = await plan(() => repo.dueAt(scopeA(), fieldA, new Date()));
      expect(indexesOf(due)).toContain('ai_generation_queue_backoff_idx');
    } finally {
      await pool.end();
      await logged.destroy();
      await clearAll();
    }
  });

  it('T1003: the rescue lists only organizations whose rows can run now, from a rotating cursor', async () => {
    const now = new Date('2026-11-08T20:00:00Z');
    const list = (after: Id<'org'> | null = null, limit = 10) =>
      listAiGenerationRescueOrganizations(db.kysely, {
        now,
        limit,
        after,
        defaultTimeZone: 'UTC',
      });
    const usage = (orgId: Id<'org'>, day: string, tokens: number) =>
      sql`INSERT INTO meta.ai_usage_daily (organization_id, day, feature, requests, prompt_tokens)
          VALUES (${orgId}, ${day}::date, 'field', 1, ${tokens})`.execute(db.kysely);
    const zone = (orgId: Id<'org'>, timeZone: string) =>
      sql`UPDATE meta.organizations SET settings = jsonb_set(settings, '{timezone}', to_jsonb(${timeZone}::text))
           WHERE id = ${orgId}`.execute(db.kysely);
    const pausedAs = async (
      orgId: Id<'org'>,
      fieldId: Id<'fld'>,
      reason: 'quota' | 'ai_disabled' | 'record_data_disabled' | 'provider_error',
    ) => {
      await queue().enqueue(orgScope(orgId), fieldId, [REC_1]);
      await queue().pause(
        orgScope(orgId),
        reason,
        reason === 'provider_error' ? { detail: 'unauthorized' } : {},
      );
    };
    try {
      // A: AI turned off, rows paused; B: the key rejected; C: today's quota used up;
      // D: queued rows whose job is waiting.
      await pausedAs(ORG_A, fieldA, 'ai_disabled');
      await aiOn(ORG_A, { enabled: false });
      await pausedAs(ORG_B, fieldB, 'provider_error');
      await aiOn(ORG_B);
      await pausedAs(ORG_C, fieldC, 'quota');
      await aiOn(ORG_C);
      await usage(ORG_C, '2026-11-08', 10_000);
      await queue().enqueue(orgScope(ORG_D), fieldD, [REC_1]);
      await aiOn(ORG_D);
      await db.withTx((tx) =>
        enqueueAiGeneration(tx, ORG_D, fieldD, new Date(now.getTime() + 60_000)),
      );
      expect(await list()).toEqual([]);

      // AI back on for A (record data off: still nothing to do).
      await aiOn(ORG_A, { allow_record_data: false });
      expect(await list()).toEqual([]);
      await aiOn(ORG_A);
      expect(await list()).toEqual([ORG_A]);
      // C: a higher limit, no limit, or a new day in its zone (already 9 November in Hà Nội).
      await aiOn(ORG_C, { daily_token_limit: 20_000 });
      expect(await list()).toEqual([ORG_A, ORG_C]);
      await aiOn(ORG_C, { daily_token_limit: null });
      expect(await list()).toEqual([ORG_A, ORG_C]);
      await aiOn(ORG_C);
      expect(await list()).toEqual([ORG_A]);
      await zone(ORG_C, 'Asia/Ho_Chi_Minh');
      expect(await list()).toEqual([ORG_A, ORG_C]);
      // A zone the database does not know: the default zone's day, never an error.
      await zone(ORG_C, 'Mars/Olympus');
      expect(await list()).toEqual([ORG_A]);
      await zone(ORG_C, 'Asia/Ho_Chi_Minh');
      // D: its job lost.
      await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
      expect(await list()).toEqual([ORG_A, ORG_C, ORG_D]);
      // B never: the provider rejected the configuration.
      expect(await list()).not.toContain(ORG_B);

      // From the cursor on, then from the first one.
      expect(await list(null, 2)).toEqual([ORG_A, ORG_C]);
      expect(await list(ORG_C, 2)).toEqual([ORG_D, ORG_A]);
      expect(await list(ORG_A, 2)).toEqual([ORG_C, ORG_D]);
      expect(await list(ORG_D, 10)).toEqual([ORG_A, ORG_C, ORG_D]);
    } finally {
      await sql`UPDATE meta.organizations SET settings = settings - 'timezone'`.execute(db.kysely);
      await clearAll();
    }
  });
});
