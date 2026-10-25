import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { orgScope, type Db, type Tx } from '../../src/db/index.js';
import {
  acquireOrgSlot,
  countRunningJobsOf,
  JobsRepository,
  ORG_SLOT_DEFER_BASE_MS,
  type DeferrableJob,
} from '../../src/jobs/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

const ORG_A = 'org_SlotOrgA00000001';
const ORG_B = 'org_SlotOrgB00000001';
const TYPE = 'base.export';

function runningJob(orgId: string, jobId: string, attempts = 1): DeferrableJob {
  return {
    task_identifier: 'test.export',
    payload: { organization_id: orgId, job_id: jobId },
    priority: 3,
    attempts,
    max_attempts: 10,
    key: `export:${jobId}`,
    flags: { heavy: true },
    queue_name: null,
  };
}

interface QueueJob {
  task_identifier: string;
  payload: unknown;
  priority: number;
  attempts: number;
  max_attempts: number;
  key: string | null;
  flags: Record<string, true> | null;
  delay_ms: number;
}

describe('acquireOrgSlot (ADR-18)', () => {
  let database: TestDatabase;
  let db: Db;
  let jobs: JobsRepository;

  async function queued(): Promise<QueueJob[]> {
    const { rows } = await sql<QueueJob>`
      SELECT task_identifier, payload, jobs.priority, jobs.attempts, jobs.max_attempts, jobs.key, jobs.flags,
             (extract(epoch FROM jobs.run_at - now()) * 1000)::int AS delay_ms
        FROM graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id) ORDER BY id
    `.execute(db.kysely);
    return rows;
  }

  async function startRunning(orgId: typeof ORG_A | typeof ORG_B): Promise<void> {
    await db.withTx(async (tx) => {
      const scope = orgScope(orgId, tx);
      const job = await jobs.create(scope, { type: TYPE, createdBy: null });
      await jobs.markRunning(scope, job.id);
    });
  }

  function acquire(tx: Tx, orgId: typeof ORG_A | typeof ORG_B, job: DeferrableJob) {
    return acquireOrgSlot(tx, {
      orgId,
      kind: TYPE,
      cap: 1,
      countRunning: countRunningJobsOf(jobs, TYPE),
      job,
      random: () => 0.5,
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    await db.kysely
      .insertInto('meta.organizations')
      .values([
        { id: ORG_A, name: 'A', slug: 'slot-a' },
        { id: ORG_B, name: 'B', slug: 'slot-b' },
      ])
      .execute();
    jobs = new JobsRepository(db);
  });

  beforeEach(async () => {
    await sql`DELETE FROM meta.jobs`.execute(db.kysely);
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('org A at its cap: the job is re-enqueued unchanged without using an attempt; org B runs', async () => {
    await startRunning(ORG_A);

    const deferred = await db.withTx((tx) => acquire(tx, ORG_A, runningJob(ORG_A, 'j1', 3)));
    expect(deferred).toMatchObject({
      acquired: false,
      running: 1,
      delayMs: ORG_SLOT_DEFER_BASE_MS + 1_000,
    });

    const [copy, ...rest] = await queued();
    expect(rest).toEqual([]);
    expect(copy).toMatchObject({
      task_identifier: 'test.export',
      payload: { organization_id: ORG_A, job_id: 'j1' },
      priority: 3,
      key: 'export:j1',
      flags: { heavy: true },
      // Not yet attempted, and still 8 attempts left as before the deferral
      // (10 max, 2 failed before the current one).
      attempts: 0,
      max_attempts: 8,
    });
    expect(copy?.delay_ms).toBeGreaterThan(5_000);
    expect(copy?.delay_ms).toBeLessThanOrEqual(6_000);

    const other = await db.withTx((tx) => acquire(tx, ORG_B, runningJob(ORG_B, 'j2')));
    expect(other).toEqual({ acquired: true, running: 0 });
    expect(await queued()).toHaveLength(1);
  });

  it('serialises concurrent acquisitions of the same organization and kind', async () => {
    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstAcquired!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      firstAcquired = resolve;
    });

    const first = db.withTx(async (tx) => {
      const slot = await acquire(tx, ORG_A, runningJob(ORG_A, 'first'));
      const scope = orgScope(ORG_A, tx);
      const job = await jobs.create(scope, { type: TYPE, createdBy: null });
      await jobs.markRunning(scope, job.id);
      firstAcquired();
      await firstHolds;
      return slot;
    });
    await firstReady;

    let secondDone = false;
    const second = db
      .withTx((tx) => acquire(tx, ORG_A, runningJob(ORG_A, 'second')))
      .finally(() => {
        secondDone = true;
      });
    // Blocked on the advisory lock while the first transaction is open.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(secondDone).toBe(false);

    releaseFirst();
    expect(await first).toEqual({ acquired: true, running: 0 });
    // Sees the run committed by the first transaction.
    expect(await second).toMatchObject({ acquired: false, running: 1 });
  });

  it('frees the slot once the running job ends', async () => {
    await startRunning(ORG_A);
    const running = await db.kysely.selectFrom('meta.jobs').select('id').executeTakeFirstOrThrow();
    await jobs.markSucceeded(orgScope(ORG_A), running.id, { size: 1 });
    expect(await db.withTx((tx) => acquire(tx, ORG_A, runningJob(ORG_A, 'j3')))).toEqual({
      acquired: true,
      running: 0,
    });
  });
});

describe('JobsRepository', () => {
  let database: TestDatabase;
  let db: Db;
  let jobs: JobsRepository;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    await db.kysely
      .insertInto('meta.organizations')
      .values([
        { id: ORG_A, name: 'A', slug: 'jobs-a' },
        { id: ORG_B, name: 'B', slug: 'jobs-b' },
      ])
      .execute();
    jobs = new JobsRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('follows queued → running → succeeded and refuses to leave a final state', async () => {
    const scope = orgScope(ORG_A);
    const job = await jobs.create(scope, { type: TYPE, createdBy: null });
    expect(job).toMatchObject({ status: 'queued', progress: 0, organization_id: ORG_A });
    expect(await jobs.setProgress(scope, job.id, 0.5)).toBeUndefined();
    expect(await jobs.markRunning(scope, job.id)).toMatchObject({ status: 'running' });
    expect(await jobs.markRunning(scope, job.id)).toBeUndefined();
    expect(await jobs.setProgress(scope, job.id, 0.5)).toMatchObject({ progress: 0.5 });
    await expect(jobs.setProgress(scope, job.id, 2)).rejects.toThrow(RangeError);
    const done = await jobs.markSucceeded(scope, job.id, { size: 42 });
    expect(done).toMatchObject({ status: 'succeeded', progress: 1, result: { size: 42 } });
    expect(done?.finished_at).toBeInstanceOf(Date);
    expect(await jobs.markFailed(scope, job.id, { code: 'INTERNAL' })).toBeUndefined();
    expect(await jobs.markCancelled(scope, job.id)).toBeUndefined();
  });

  it('records failures as problem objects and cancellations', async () => {
    const scope = orgScope(ORG_A);
    const failed = await jobs.create(scope, { type: TYPE, createdBy: null });
    await jobs.markRunning(scope, failed.id);
    expect(
      await jobs.markFailed(scope, failed.id, { code: 'INVALID_PACKAGE', detail: 'x' }),
    ).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_PACKAGE', detail: 'x' },
    });
    const cancelled = await jobs.create(scope, { type: TYPE, createdBy: null });
    expect(await jobs.markCancelled(scope, cancelled.id)).toMatchObject({ status: 'cancelled' });
  });

  it('is isolated by organization', async () => {
    const job = await jobs.create(orgScope(ORG_A), { type: 'isolation', createdBy: null });
    const scopeB = orgScope(ORG_B);
    expect(await jobs.getById(scopeB, job.id)).toBeUndefined();
    expect(await jobs.markRunning(scopeB, job.id)).toBeUndefined();
    expect(await jobs.markCancelled(scopeB, job.id)).toBeUndefined();
    expect(await jobs.markRunning(orgScope(ORG_A), job.id)).toMatchObject({ status: 'running' });
    expect(await jobs.countRunning(scopeB, 'isolation')).toBe(0);
    expect(await jobs.countRunning(orgScope(ORG_A), 'isolation')).toBe(1);
    expect(await jobs.setProgress(scopeB, job.id, 0.3)).toBeUndefined();
    expect(await jobs.markSucceeded(scopeB, job.id)).toBeUndefined();
    expect(await jobs.markFailed(scopeB, job.id, { code: 'INTERNAL' })).toBeUndefined();
    expect(await jobs.getById(orgScope(ORG_A), job.id)).toMatchObject({ status: 'running' });
  });
});
