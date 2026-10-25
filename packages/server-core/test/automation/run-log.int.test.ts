import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import {
  AutomationRunLog,
  AutomationRunStepsRepository,
  AutomationRunsRepository,
  AutomationsRepository,
  purgeExpiredAutomationRuns,
  stepIdempotencyKey,
} from '../../src/automation/index.js';
import { listOrganizationsWithExpiredAutomationRuns } from '../../src/db/cross-tenant-lookups.js';
import { orgScope, type Db, type OrgScope } from '../../src/db/index.js';
import { AppError } from '../../src/errors/app-error.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { AutomationRunStatusKind, JsonObject } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_RunLogOrgA000001';
const ORG_B = 'org_RunLogOrgB000001';
const TABLE: Id<'tbl'> = 'tbl_RunLogTable00001';

const DEFINITION = {
  trigger: { type: 'schedule', cron: '0 9 * * *', timezone: null },
  condition: null,
  actions: [
    { id: 'act_1', type: 'create_record', config: { table_id: TABLE, fields: {} } },
    {
      id: 'act_2',
      type: 'find_records',
      config: { table_id: TABLE, filter: null, sort: [], fields: [], limit: 50 },
    },
  ],
};

let serial = 0;
const nextId = <P extends string>(prefix: P, tag: string): `${P}_${string}` => {
  serial += 1;
  return `${prefix}_${tag}${String(serial).padStart(16 - tag.length, '0')}`;
};

/**
 * BACKLOG T518 at the service/repository level: the run log stays inside its
 * organization (AGENTS.md rule 5), re-runs reuse the steps that succeeded
 * and only once at a time, cancel stops `queued`/`waiting` runs only, and
 * retention deletes finished runs older than the limit, organization by
 * organization.
 */
describe('automation run log (BACKLOG T518)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  let scopeA: OrgScope;
  let scopeB: OrgScope;
  let runs: AutomationRunsRepository;
  let steps: AutomationRunStepsRepository;
  let log: AutomationRunLog;
  let autA: Id<'aut'>;
  let autB: Id<'aut'>;

  async function automation(tenant: SeededTenant): Promise<Id<'aut'>> {
    const id = nextId('aut', 'RunLog');
    await new AutomationsRepository(db).insert(orgScope(tenant.orgId), {
      id,
      baseId: tenant.baseId,
      name: id,
      description: '',
      enabled: true,
      definition: DEFINITION,
      triggerType: 'schedule',
      triggerTableId: null,
      createdBy: tenant.userId,
    });
    return id;
  }

  async function run(
    scope: OrgScope,
    automationId: Id<'aut'>,
    status: AutomationRunStatusKind,
    options: { readonly daysAgo?: number; readonly error?: JsonObject } = {},
  ): Promise<Id<'run'>> {
    const id = nextId('run', 'RunLog');
    await runs.insert(scope, {
      id,
      automationId,
      automationVersion: 1,
      triggerEventId: null,
      triggerUnit: id,
      status: 'queued',
      depth: 0,
      input: {
        automation_version: 1,
        definition: DEFINITION,
        trigger: { event_id: null, type: 'schedule', table_id: null, record_id: null },
      },
    });
    await sql`
      UPDATE meta.automation_runs
         SET status = ${status},
             error = ${options.error === undefined ? null : JSON.stringify(options.error)}::jsonb,
             created_at = now() - make_interval(days => ${options.daysAgo ?? 0})
       WHERE id = ${id}
    `.execute(db.kysely);
    return id;
  }

  async function step(
    scope: OrgScope,
    runId: Id<'run'>,
    actionId: string,
    type: string,
    status: 'succeeded' | 'failed' | 'waiting',
  ): Promise<void> {
    const row = await runs.get(scope, runId);
    if (row === undefined) throw new Error('missing run');
    const stepId = nextId('stp', 'RunLog');
    await steps.begin(scope, {
      id: stepId,
      runId,
      actionId,
      idempotencyKey: stepIdempotencyKey(row, actionId),
      input: { type },
      at: new Date(),
    });
    await steps.finish(scope, stepId, {
      status,
      at: new Date(),
      ...(status === 'succeeded' ? { output: { id: 'rec_RunLogRecord0001' } } : {}),
    });
  }

  async function jobsFor(runId: Id<'run'>): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n
        FROM graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id)
       WHERE task_identifier = 'automation.run' AND payload->>'run_id' = ${runId}
    `.execute(db.kysely);
    return rows[0]?.n ?? 0;
  }

  const actor = (tenant: SeededTenant) => ({
    userId: tenant.userId,
    context: systemAuditContext(),
  });

  const conflict = (promise: Promise<unknown>) =>
    expect(promise).rejects.toMatchObject({
      code: 'RUN_STATE_CONFLICT',
    } satisfies Partial<AppError>);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    runs = new AutomationRunsRepository(db);
    steps = new AutomationRunStepsRepository(db);
    log = new AutomationRunLog(db);
    autA = await automation(a);
    autB = await automation(b);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('lists, reads and counts runs of the scope organization only', async () => {
    const failed = await run(scopeA, autA, 'failed', { error: { code: 'invalid_value' } });
    const ok = await run(scopeA, autA, 'succeeded');
    await run(scopeA, autA, 'succeeded', { daysAgo: 3 });
    await run(scopeB, autB, 'failed');

    const page = await runs.listPage(scopeA, { baseId: a.baseId }, { cursor: null, limit: 10 });
    expect(page.items.map((row) => row.automation_id)).not.toContain(autB);
    expect(
      (await runs.listPage(scopeB, { baseId: a.baseId }, { cursor: null, limit: 10 })).items,
    ).toEqual([]);
    expect(
      (
        await runs.listPage(
          scopeA,
          { baseId: a.baseId, statuses: ['failed'] },
          { cursor: null, limit: 10 },
        )
      ).items.map((row) => row.id),
    ).toContain(failed);
    expect(await runs.getForLog(scopeB, ok)).toBeUndefined();
    expect(await runs.automationIdOf(scopeB, ok)).toBeUndefined();
    expect(await runs.automationIdOf(scopeA, ok)).toBe(autA);
    expect(await log.detail(scopeB, ok)).toBeUndefined();

    const stats = await runs.statsOf(scopeA, [autA, autB]);
    expect(stats.get(autA)?.counts24h).toMatchObject({ failed: 1, succeeded: 1 });
    expect(stats.get(autA)?.counts7d).toMatchObject({ failed: 1, succeeded: 2 });
    expect(stats.get(autA)?.lastRun).toMatchObject({ status: expect.any(String) as unknown });
    // Org B's automation, asked through org A: nothing.
    expect(stats.get(autB)).toEqual({
      lastRun: null,
      counts24h: expect.objectContaining({ failed: 0 }) as unknown,
      counts7d: expect.objectContaining({ failed: 0 }) as unknown,
    });
  });

  it('re-runs a failed run with the current definition, reusing its succeeded steps once', async () => {
    const original = await run(scopeA, autA, 'failed', { error: { code: 'invalid_value' } });
    await step(scopeA, original, 'act_1', 'create_record', 'succeeded');
    await step(scopeA, original, 'act_2', 'find_records', 'failed');
    // Another organization cannot re-run it.
    await expect(log.rerun(scopeB, original, actor(b))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const rerun = await log.rerun(scopeA, original, actor(a));
    const row = await runs.get(scopeA, rerun);
    expect(row).toMatchObject({
      status: 'queued',
      rerun_of_run_id: original,
      rerun_by_user_id: a.userId,
      trigger_event_id: null,
      automation_version: 1,
    });
    expect(await jobsFor(rerun)).toBe(1);
    const copied = await steps.listByRun(scopeA, rerun);
    expect(copied).toEqual([
      expect.objectContaining({
        action_id: 'act_1',
        status: 'succeeded',
        idempotency_key: `${autA}:${rerun}:act_1`,
        input: expect.objectContaining({
          type: 'create_record',
          reused_from: expect.any(String) as unknown,
        }) as unknown,
        output: { id: 'rec_RunLogRecord0001' },
      }),
    ]);
    // One unfinished re-run at a time.
    await conflict(log.rerun(scopeA, original, actor(a)));
    expect(await runs.listReruns(scopeA, original)).toEqual([
      expect.objectContaining({ id: rerun, status: 'queued' }),
    ]);
    expect(await runs.listReruns(scopeB, original)).toEqual([]);

    const { rows } = await sql<{ action: string; after: Record<string, unknown> }>`
      SELECT action, after FROM meta.audit_logs WHERE entity_id = ${rerun}
    `.execute(db.kysely);
    expect(rows).toEqual([
      {
        action: 'automation.run.rerun',
        after: expect.objectContaining({ rerun_of: original, reused_steps: ['act_1'] }) as unknown,
      },
    ]);
  });

  it('refuses to re-run a run that did not fail or was not cancelled', async () => {
    for (const status of ['succeeded', 'queued', 'running', 'skipped'] as const) {
      await conflict(log.rerun(scopeA, await run(scopeA, autA, status), actor(a)));
    }
  });

  it('cancels a queued or waiting run, and nothing else', async () => {
    const waiting = await run(scopeA, autA, 'waiting');
    await step(scopeA, waiting, 'act_1', 'create_record', 'succeeded');
    await step(scopeA, waiting, 'act_2', 'delay', 'waiting');
    await expect(log.cancel(scopeB, waiting, actor(b))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await log.cancel(scopeA, waiting, actor(a));
    expect(await runs.get(scopeA, waiting)).toMatchObject({
      status: 'cancelled',
      error: { code: 'cancelled_by_user', params: { user_id: a.userId } },
    });
    expect((await steps.listByRun(scopeA, waiting)).map((row) => row.status)).toEqual([
      'succeeded',
      'cancelled',
    ]);
    await conflict(log.cancel(scopeA, waiting, actor(a)));

    const queued = await run(scopeA, autA, 'queued');
    await log.cancel(scopeA, queued, actor(a));
    expect(await runs.get(scopeA, queued)).toMatchObject({ status: 'cancelled' });
    for (const status of ['running', 'succeeded', 'failed'] as const) {
      await conflict(log.cancel(scopeA, await run(scopeA, autA, status), actor(a)));
    }
    // A cancelled run can be run again.
    const rerun = await log.rerun(scopeA, queued, actor(a));
    expect(await runs.get(scopeA, rerun)).toMatchObject({ rerun_of_run_id: queued });
  });

  it('copies steps between runs of the scope organization only', async () => {
    const from = await run(scopeA, autA, 'failed');
    await step(scopeA, from, 'act_1', 'create_record', 'succeeded');
    const to = await run(scopeB, autB, 'queued');
    await expect(
      steps.copySucceeded(scopeB, {
        steps: await steps.listByRun(scopeA, from),
        toRunId: to,
        keyOf: (actionId) => `${autB}:${to}:${actionId}`,
        newId: () => nextId('stp', 'RunLog'),
      }),
    ).resolves.toBe(1);
    // Copied into org B's run under org B: never into org A.
    expect(await steps.listByRun(scopeA, to)).toEqual([]);
    expect((await steps.listByRun(scopeB, to))[0]).toMatchObject({ organization_id: ORG_B });
    await steps.cancelWaiting(scopeB, from, new Date());
    expect((await steps.listByRun(scopeA, from))[0]).toMatchObject({ status: 'succeeded' });
  });

  it('retention deletes finished runs older than the limit, organization by organization', async () => {
    const old = await run(scopeA, autA, 'succeeded', { daysAgo: 91 });
    await step(scopeA, old, 'act_1', 'create_record', 'succeeded');
    const oldFailed = await run(scopeA, autA, 'failed', { daysAgo: 120 });
    const rerunOfOld = await log.rerun(scopeA, oldFailed, actor(a));
    const recent = await run(scopeA, autA, 'succeeded', { daysAgo: 89 });
    const oldWaiting = await run(scopeA, autA, 'waiting', { daysAgo: 200 });
    const oldB = await run(scopeB, autB, 'cancelled', { daysAgo: 95 });

    const now = new Date();
    const cutoff = new Date(now.getTime() - 90 * 86_400_000);
    expect(
      await listOrganizationsWithExpiredAutomationRuns(db.kysely, {
        before: cutoff,
        after: null,
        limit: 10,
      }),
    ).toEqual([ORG_A, ORG_B]);
    expect(
      await listOrganizationsWithExpiredAutomationRuns(db.kysely, {
        before: cutoff,
        after: ORG_A,
        limit: 10,
      }),
    ).toEqual([ORG_B]);
    // Org B's scope never deletes org A's runs.
    expect(await runs.deleteFinishedBefore(scopeB, cutoff, 100)).toBe(1);
    expect(await runs.get(scopeA, old)).toBeDefined();
    expect(await runs.get(scopeB, oldB)).toBeUndefined();

    const result = await purgeExpiredAutomationRuns(db, {
      now,
      retentionDays: 90,
      batchSize: 1,
      orgPageSize: 1,
    });
    expect(result).toEqual({ organizations: 1, runs: 2 });
    expect(await runs.get(scopeA, old)).toBeUndefined();
    expect(await runs.get(scopeA, oldFailed)).toBeUndefined();
    expect(await steps.listByRun(scopeA, old)).toEqual([]);
    expect(await runs.get(scopeA, recent)).toBeDefined();
    expect(await runs.get(scopeA, oldWaiting)).toMatchObject({ status: 'waiting' });
    // The re-run keeps running and only loses its link.
    expect(await runs.get(scopeA, rerunOfOld)).toMatchObject({
      rerun_of_run_id: null,
      rerun_by_user_id: a.userId,
    });
    expect(await purgeExpiredAutomationRuns(db, { now, retentionDays: 90 })).toEqual({
      organizations: 0,
      runs: 0,
    });
    await expect(purgeExpiredAutomationRuns(db, { now, retentionDays: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});
