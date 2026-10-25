import { idOf, type Id } from '@cellhive/contracts';
import {
  acquireOrgSlot,
  countRunningJobsOf,
  deferrableJob,
  JobsRepository,
  orgScope,
  type Db,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startJobRunner } from '../../src/index.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  queuedJobs,
  waitFor,
  type TestDatabase,
} from './support.js';

import type { Runner, Task } from 'graphile-worker';

const ORG_A = 'org_SlotRunnerOrgA01';
const ORG_B = 'org_SlotRunnerOrgB01';
const KIND = 'test.org_job';

interface OrgJobPayload {
  readonly organization_id: Id<'org'>;
  readonly job_id: Id<'job'>;
  readonly hold: boolean;
}

describe('acquireOrgSlot in a running worker (ADR-18, cap 1)', () => {
  let database: TestDatabase;
  let db: Db;
  let jobs: JobsRepository;
  let runner: Runner;
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const started: string[] = [];
  const deferred: string[] = [];

  /** A generic background job that respects the per-organization cap. */
  const orgJob: Task = async (rawPayload, helpers) => {
    const payload = rawPayload as OrgJobPayload;
    const orgId = idOf('org').parse(payload.organization_id);
    const job = await deferrableJob(helpers);
    const slot = await db.withTx(async (tx) => {
      const acquired = await acquireOrgSlot(tx, {
        orgId,
        kind: KIND,
        cap: 1,
        countRunning: countRunningJobsOf(jobs, KIND),
        job,
      });
      if (acquired.acquired) await jobs.markRunning(orgScope(orgId, tx), payload.job_id);
      return acquired;
    });
    if (!slot.acquired) {
      deferred.push(payload.job_id);
      return;
    }
    started.push(payload.job_id);
    if (payload.hold) await held;
    await jobs.markSucceeded(orgScope(orgId), payload.job_id);
  };

  async function submit(orgId: Id<'org'>, hold: boolean): Promise<Id<'job'>> {
    return db.withTx(async (tx) => {
      const record = await jobs.create(orgScope(orgId, tx), { type: KIND, createdBy: null });
      const payload: OrgJobPayload = { organization_id: orgId, job_id: record.id, hold };
      await sql`SELECT graphile_worker.add_job(${KIND}, ${JSON.stringify(payload)}::json)`.execute(
        tx,
      );
      return record.id;
    });
  }

  async function status(orgId: Id<'org'>, id: Id<'job'>): Promise<string | undefined> {
    return (await jobs.getById(orgScope(orgId), id))?.status;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    await db.kysely
      .insertInto('meta.organizations')
      .values([
        { id: ORG_A, name: 'A', slug: 'runner-a' },
        { id: ORG_B, name: 'B', slug: 'runner-b' },
      ])
      .execute();
    jobs = new JobsRepository(db);
    runner = await startJobRunner({
      connectionString: database.url,
      concurrency: 4,
      pollIntervalMs: 200,
      logger: captureLogger().logger,
      taskList: { [KIND]: orgJob },
    });
  });

  afterAll(async () => {
    releaseHeld();
    await runner.stop();
    await db.destroy();
    await database.drop();
  });

  it('org A slow job holds the slot: A is rescheduled without an attempt, B runs at once', async () => {
    const slowA = await submit(ORG_A, true);
    await waitFor(async () => (await status(ORG_A, slowA)) === 'running', { what: 'A1 running' });

    const secondA = await submit(ORG_A, false);
    const jobB = await submit(ORG_B, false);

    // B is not blocked by A's slow job.
    await waitFor(async () => (await status(ORG_B, jobB)) === 'succeeded', { what: 'B done' });
    expect(await status(ORG_A, slowA)).toBe('running');

    // A's second job was deferred: re-enqueued ~5 s later, attempts not increased.
    await waitFor(() => Promise.resolve(deferred.includes(secondA)), { what: 'A2 deferred' });
    expect(await status(ORG_A, secondA)).toBe('queued');
    // graphile-worker removes the original job row asynchronously after the task
    // returns, so for a moment both it and the re-enqueued copy are listed.
    const copiesOfSecondA = async () =>
      (await queuedJobs(db, KIND)).filter((job) => job.payload.job_id === secondA);
    await waitFor(async () => (await copiesOfSecondA()).length === 1, {
      what: 'only the re-enqueued copy of A2 left',
    });
    const [copy, ...others] = await copiesOfSecondA();
    expect(others).toEqual([]);
    expect(copy).toMatchObject({
      attempts: 0,
      max_attempts: 25,
      last_error: null,
      locked_by: null,
    });
    const delayMs = (copy?.run_at.getTime() ?? 0) - Date.now();
    expect(delayMs).toBeGreaterThan(2_000);
    expect(delayMs).toBeLessThanOrEqual(7_000);

    // Once A1 ends, A2 gets the slot on its next try.
    releaseHeld();
    await waitFor(async () => (await status(ORG_A, slowA)) === 'succeeded', { what: 'A1 done' });
    await waitFor(async () => (await status(ORG_A, secondA)) === 'succeeded', {
      timeoutMs: 20_000,
      what: 'A2 done after the deferral',
    });
    expect(started).toEqual([slowA, jobB, secondA]);
    expect(deferred.filter((id) => id === secondA).length).toBeGreaterThanOrEqual(1);
  });
});
