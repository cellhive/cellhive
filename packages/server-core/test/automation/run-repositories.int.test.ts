import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AutomationRunStepsRepository,
  AutomationRunsRepository,
  AutomationsRepository,
} from '../../src/automation/index.js';
import { orgScope, withTxScope, type Db, type OrgScope } from '../../src/db/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_RunRepoOrgA00001';
const ORG_B = 'org_RunRepoOrgB00001';
const AUT_A: Id<'aut'> = 'aut_RunRepoAutA00001';
const AUT_B: Id<'aut'> = 'aut_RunRepoAutB00001';
const RUN_A: Id<'run'> = 'run_RunRepoRunA00001';
const RUN_B: Id<'run'> = 'run_RunRepoRunB00001';

async function seedRun(
  db: Db,
  tenant: SeededTenant,
  automationId: Id<'aut'>,
  runId: Id<'run'>,
): Promise<void> {
  const scope = orgScope(tenant.orgId);
  await new AutomationsRepository(db).insert(scope, {
    id: automationId,
    baseId: tenant.baseId,
    name: automationId,
    description: '',
    enabled: true,
    definition: { trigger: { type: 'schedule', cron: '0 9 * * *' } },
    triggerType: 'schedule',
    triggerTableId: null,
    createdBy: tenant.userId,
  });
  await new AutomationRunsRepository(db).insert(scope, {
    id: runId,
    automationId,
    automationVersion: 1,
    triggerEventId: null,
    triggerUnit: runId,
    status: 'queued',
    depth: 0,
    input: {},
  });
}

/**
 * BACKLOG T505: the run engine's repository methods — run segments and the
 * slot count, steps by idempotency key — stay inside their organization
 * (AGENTS.md rule 5) and implement SPEC §11.7 (a succeeded step is never
 * started again, attempts count up).
 */
describe('run engine repositories (BACKLOG T505)', () => {
  let database: TestDatabase;
  let db: Db;
  let runs: AutomationRunsRepository;
  let steps: AutomationRunStepsRepository;
  let scopeA: OrgScope;
  let scopeB: OrgScope;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    const a = await seedTenant(db, ORG_A);
    const b = await seedTenant(db, ORG_B);
    await seedRun(db, a, AUT_A, RUN_A);
    await seedRun(db, b, AUT_B, RUN_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    runs = new AutomationRunsRepository(db);
    steps = new AutomationRunStepsRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('reads, locks and times runs of the scope organization only', async () => {
    expect(await runs.get(scopeB, RUN_A)).toBeUndefined();
    await db.withTx(async (tx) => {
      expect(await runs.lockById(withTxScope(scopeB, tx), RUN_A)).toBeUndefined();
      expect(await runs.lockById(withTxScope(scopeA, tx), RUN_A)).toMatchObject({ id: RUN_A });
    });
    const started = new Date();
    const running = await runs.startSegment(scopeA, RUN_A, started);
    expect(running).toMatchObject({ status: 'running', running_since: started });
    expect(await runs.countRunning(scopeA, 60_000)).toBe(1);
    expect(await runs.countRunning(scopeB, 60_000)).toBe(0);
    await runs.endSegment(scopeB, RUN_A, { status: 'failed', at: new Date() });
    expect(await runs.get(scopeA, RUN_A)).toMatchObject({ status: 'running' });

    await runs.endSegment(scopeA, RUN_A, {
      status: 'queued',
      at: new Date(started.getTime() + 1_500),
      error: { code: 'temporary_error' },
    });
    const queued = await runs.get(scopeA, RUN_A);
    expect(queued).toMatchObject({ status: 'queued', running_since: null, finished_at: null });
    expect(Number(queued?.active_ms)).toBe(1_500);

    // A second segment adds up; a final status sets finished_at and keeps the first start.
    const again = new Date(started.getTime() + 60_000);
    expect(await runs.startSegment(scopeA, RUN_A, again)).toMatchObject({ started_at: started });
    await runs.endSegment(scopeA, RUN_A, {
      status: 'succeeded',
      at: new Date(again.getTime() + 500),
      error: null,
    });
    const done = await runs.get(scopeA, RUN_A);
    expect(done).toMatchObject({ status: 'succeeded', error: null });
    expect(Number(done?.active_ms)).toBe(2_000);
    expect(done?.finished_at).not.toBeNull();
  });

  it('a run running for longer than the timeout holds no slot', async () => {
    await runs.startSegment(scopeB, RUN_B, new Date());
    expect(await runs.countRunning(scopeB, 60_000)).toBe(1);
    await sql`UPDATE meta.automation_runs SET running_since = now() - interval '2 minutes'
               WHERE id = ${RUN_B}`.execute(db.kysely);
    expect(await runs.countRunning(scopeB, 60_000)).toBe(0);
  });

  it('starts a step once per key, counts attempts, never restarts a succeeded step', async () => {
    const key = `${AUT_A}:${RUN_A}:act_1`;
    const at = new Date();
    const first = await steps.begin(scopeA, {
      id: 'stp_RunRepoStep00001',
      runId: RUN_A,
      actionId: 'act_1',
      idempotencyKey: key,
      input: { type: 'create_record' },
      at,
    });
    expect(first).toMatchObject({ status: 'running', attempt: 1, organization_id: ORG_A });
    await steps.finish(scopeA, 'stp_RunRepoStep00001', {
      status: 'failed',
      at,
      error: { code: 'temporary_error' },
    });
    const second = await steps.begin(scopeA, {
      id: 'stp_RunRepoStep00002',
      runId: RUN_A,
      actionId: 'act_1',
      idempotencyKey: key,
      at,
    });
    expect(second).toMatchObject({
      id: 'stp_RunRepoStep00001',
      status: 'running',
      attempt: 2,
      error: null,
    });
    // Another organization cannot take over the key.
    expect(
      await steps.begin(scopeB, {
        id: 'stp_RunRepoStep00003',
        runId: RUN_B,
        actionId: 'act_1',
        idempotencyKey: key,
        at,
      }),
    ).toBeUndefined();
    await steps.finish(scopeB, 'stp_RunRepoStep00001', { status: 'succeeded', at });
    expect(await steps.findByKey(scopeA, key)).toMatchObject({ status: 'running' });

    await steps.finish(scopeA, 'stp_RunRepoStep00001', {
      status: 'succeeded',
      at,
      output: { id: 'rec_RunRepoRecord001' },
    });
    expect(
      await steps.begin(scopeA, {
        id: 'stp_RunRepoStep00004',
        runId: RUN_A,
        actionId: 'act_1',
        idempotencyKey: key,
        at,
      }),
    ).toBeUndefined();
    expect(await steps.findByKey(scopeB, key)).toBeUndefined();
    expect(await steps.listByRun(scopeB, RUN_A)).toEqual([]);
    expect(await steps.listByRun(scopeA, RUN_A)).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        attempt: 2,
        output: { id: 'rec_RunRepoRecord001' },
      }),
    ]);
  });
});
