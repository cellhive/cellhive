import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AutomationBatchCountersRepository,
  AutomationRunsRepository,
  AutomationsRepository,
  BREAKER_MAX_FAILED_UNITS,
  tripOnConsecutiveFailures,
  type AutomationNotifier,
} from '../../src/automation/index.js';
import { orgScope, withTxScope, type Db, type OrgScope } from '../../src/db/index.js';
import { purgeExpiredOperationalRows } from '../../src/jobs/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_DispRepoOrgA0001';
const ORG_B = 'org_DispRepoOrgB0001';
const TBL_A: Id<'tbl'> = 'tbl_DispRepoTblA0001';
const TBL_B: Id<'tbl'> = 'tbl_DispRepoTblB0001';
const AUT_A: Id<'aut'> = 'aut_DispRepoAutA0001';
const AUT_A_OFF: Id<'aut'> = 'aut_DispRepoAutA0002';
const AUT_B: Id<'aut'> = 'aut_DispRepoAutB0001';
const AUT_FAIL: Id<'aut'> = 'aut_DispRepoAutA0003';

async function seedTable(db: Db, tenant: SeededTenant, id: Id<'tbl'>): Promise<void> {
  await sql`
    INSERT INTO meta.tables (id, organization_id, base_id, name, db_table_name, "collation")
    VALUES (${id}, ${tenant.orgId}, ${tenant.baseId}, ${id}, ${`t_${id.slice(-12).toLowerCase()}`},
            'und-x-icu')
  `.execute(db.kysely);
}

async function seedAutomation(
  repo: AutomationsRepository,
  tenant: SeededTenant,
  id: Id<'aut'>,
  tableId: Id<'tbl'>,
  enabled: boolean,
): Promise<void> {
  await repo.insert(orgScope(tenant.orgId), {
    id,
    baseId: tenant.baseId,
    name: id,
    description: '',
    enabled,
    definition: { trigger: { type: 'record.created', table_id: tableId } },
    triggerType: 'record.created',
    triggerTableId: tableId,
    createdBy: tenant.userId,
  });
}

/**
 * BACKLOG T503: the repositories of `events.dispatch` — runs, fan-out
 * counters, dispatch lookups of automations — stay inside their
 * organization (AGENTS.md rule 5), the fan-out cap is exact under
 * concurrency, and the "50 failed units in a row" breaker rule.
 */
describe('dispatch repositories (BACKLOG T503)', () => {
  let database: TestDatabase;
  let db: Db;
  let automations: AutomationsRepository;
  let runs: AutomationRunsRepository;
  let counters: AutomationBatchCountersRepository;
  let a: SeededTenant;
  let b: SeededTenant;
  let scopeA: OrgScope;
  let scopeB: OrgScope;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    await seedTable(db, a, TBL_A);
    await seedTable(db, b, TBL_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    automations = new AutomationsRepository(db);
    runs = new AutomationRunsRepository(db);
    counters = new AutomationBatchCountersRepository(db);
    await seedAutomation(automations, a, AUT_A, TBL_A, true);
    await seedAutomation(automations, a, AUT_A_OFF, TBL_A, false);
    await seedAutomation(automations, b, AUT_B, TBL_B, true);
    await seedAutomation(automations, a, AUT_FAIL, TBL_A, true);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('lists enabled automations of a trigger in the scope organization only', async () => {
    const ids = async (scope: OrgScope, table: Id<'tbl'>) =>
      (await automations.listEnabledForTrigger(scope, 'record.created', table)).map(
        (row) => row.id,
      );
    expect((await ids(scopeA, TBL_A)).sort()).toEqual([AUT_A, AUT_FAIL].sort());
    expect(await ids(scopeB, TBL_A)).toEqual([]);
    expect(await ids(scopeB, TBL_B)).toEqual([AUT_B]);
    expect(await automations.listEnabledForTrigger(scopeA, 'record.updated', TBL_A)).toEqual([]);
  });

  it('T617: lists the enabled automations of a hook in the scope organization only', async () => {
    // The hook id lives in the definition (no FK): even the same id in two
    // organizations must not cross.
    const hook: Id<'hok'> = 'hok_DispRepoHookA0001';
    const webhookAutomation = async (tenant: SeededTenant, id: Id<'aut'>, enabled: boolean) =>
      automations.insert(orgScope(tenant.orgId), {
        id,
        baseId: tenant.baseId,
        name: id,
        description: '',
        enabled,
        definition: { trigger: { type: 'webhook.received', incoming_webhook_id: hook } },
        triggerType: 'webhook.received',
        triggerTableId: null,
        createdBy: tenant.userId,
      });
    await webhookAutomation(a, 'aut_DispRepoHookA0001', true);
    await webhookAutomation(a, 'aut_DispRepoHookA0002', false);
    await webhookAutomation(b, 'aut_DispRepoHookB0001', true);
    const ids = async (scope: OrgScope) =>
      (await automations.listEnabledForWebhook(scope, hook)).map((row) => row.id);
    expect(await ids(scopeA)).toEqual(['aut_DispRepoHookA0001']);
    expect(await ids(scopeB)).toEqual(['aut_DispRepoHookB0001']);
    expect(await automations.listEnabledForWebhook(scopeA, 'hok_DispRepoHookZ0001')).toEqual([]);
  });

  it('locks and disables only enabled automations of the scope organization', async () => {
    await db.withTx(async (tx) => {
      expect(await automations.lockEnabled(withTxScope(scopeB, tx), AUT_A)).toBeUndefined();
      expect(await automations.lockEnabled(withTxScope(scopeA, tx), AUT_A_OFF)).toBeUndefined();
      expect(await automations.lockEnabled(withTxScope(scopeA, tx), AUT_A)).toMatchObject({
        id: AUT_A,
      });
    });
    expect(await automations.disableBySystem(scopeB, AUT_A, 'circuit_breaker')).toBeUndefined();
    expect(await automations.get(scopeA, AUT_A)).toMatchObject({ enabled: true, version: 1 });
  });

  it('creates one run per (automation, event) and reads runs of its organization only', async () => {
    const input = {
      automationId: AUT_A,
      automationVersion: 1,
      triggerEventId: 'evt_DispRepoEvent001',
      triggerUnit: 'evt_DispRepoEvent001',
      status: 'queued',
      depth: 0,
      input: {},
    } as const;
    const first = await runs.insert(scopeA, { ...input, id: 'run_DispRepoRun00001' });
    expect(first).toMatchObject({ status: 'queued', organization_id: ORG_A });
    expect(await runs.insert(scopeA, { ...input, id: 'run_DispRepoRun00002' })).toBeUndefined();
    expect(await runs.findByEvent(scopeA, AUT_A, 'evt_DispRepoEvent001')).toMatchObject({
      id: 'run_DispRepoRun00001',
    });
    expect(await runs.findByEvent(scopeB, AUT_A, 'evt_DispRepoEvent001')).toBeUndefined();
    // A run of org A's automation cannot be written under org B (composite FK).
    await expect(
      runs.insert(scopeB, { ...input, id: 'run_DispRepoRun00003', triggerEventId: null }),
    ).rejects.toMatchObject({ code: '23503' });
    expect(await runs.recentUnits(scopeA, AUT_A, 60, 'evt_DispRepoEvent001')).toEqual({
      distinct: 1,
      includesUnit: true,
    });
    expect(await runs.recentUnits(scopeB, AUT_A, 60, 'evt_DispRepoEvent001')).toEqual({
      distinct: 0,
      includesUnit: false,
    });
    expect(await runs.recentUnits(scopeA, AUT_A, 60, 'req_Other')).toEqual({
      distinct: 1,
      includesUnit: false,
    });
  });

  it('finds and updates the fan-out stand-in run within its organization', async () => {
    await runs.insert(scopeA, {
      id: 'run_DispRepoFanout01',
      automationId: AUT_A,
      automationVersion: 1,
      triggerEventId: 'evt_DispRepoEvent002',
      triggerUnit: 'job_DispRepoBatch001',
      status: 'skipped',
      depth: 0,
      input: {},
      error: {
        code: 'batch_fanout_exceeded',
        batch_id: 'job_DispRepoBatch001',
        limit: 2,
        skipped: 1,
      },
    });
    expect(await runs.findFanoutRun(scopeB, AUT_A, 'job_DispRepoBatch001')).toBeUndefined();
    const found = await runs.findFanoutRun(scopeA, AUT_A, 'job_DispRepoBatch001');
    expect(found).toMatchObject({ id: 'run_DispRepoFanout01', status: 'skipped' });
    expect(found?.finished_at).toBeInstanceOf(Date);
    await runs.setFanoutSkipped(scopeB, 'run_DispRepoFanout01', 99);
    await runs.setFanoutSkipped(scopeA, 'run_DispRepoFanout01', 7);
    expect((await runs.findFanoutRun(scopeA, AUT_A, 'job_DispRepoBatch001'))?.error).toEqual({
      code: 'batch_fanout_exceeded',
      batch_id: 'job_DispRepoBatch001',
      limit: 2,
      skipped: 7,
    });
  });

  it('caps the runs of a batch exactly, even under concurrent claims', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.withTx((tx) =>
          counters.claimRun(withTxScope(scopeA, tx), AUT_A, 'req_DispRepoBatch01', 5),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await counters.addSkipped(scopeA, AUT_A, 'req_DispRepoBatch01')).toBe(1);
    expect(await counters.get(scopeA, AUT_A, 'req_DispRepoBatch01')).toEqual({
      runs: 5,
      skipped: 1,
      events: 0,
    });
  });

  it('keeps counters inside their organization', async () => {
    expect(await counters.get(scopeB, AUT_A, 'req_DispRepoBatch01')).toBeUndefined();
    expect(await counters.addSkipped(scopeB, AUT_A, 'req_DispRepoBatch01')).toBe(0);
    // Org B cannot take a slot of org A's automation: the row is org A's.
    expect(await counters.claimRun(scopeB, AUT_A, 'req_DispRepoBatch01', 100)).toBe(false);
    // Nor create a counter for it (composite FK).
    await expect(
      counters.claimRun(scopeB, AUT_A, 'req_DispRepoBatch02', 100),
    ).rejects.toMatchObject({ code: '23503' });
    expect(await counters.get(scopeA, AUT_A, 'req_DispRepoBatch01')).toEqual({
      runs: 5,
      skipped: 1,
      events: 0,
    });
  });

  it('counts the events of a recompute job within the organization (T509)', async () => {
    const job = 'job_DispRepoRecomp01';
    expect(
      await counters.addRecomputeEvents(scopeA, AUT_A, job, { events: 1001, skipped: 0 }),
    ).toEqual({ runs: 0, skipped: 0, events: 1001 });
    // events.dispatch takes run slots on the same row.
    expect(await counters.claimRun(scopeA, AUT_A, job, 1000)).toBe(true);
    expect(
      await counters.addRecomputeEvents(scopeA, AUT_A, job, { events: 0, skipped: 4000 }),
    ).toEqual({ runs: 1, skipped: 4000, events: 1001 });
    // Org B can neither change nor create a counter of org A's automation.
    expect(
      await counters.addRecomputeEvents(scopeB, AUT_A, job, { events: 5, skipped: 5 }),
    ).toBeUndefined();
    expect(
      await counters.addRecomputeEvents(scopeB, AUT_A, 'job_DispRepoRecomp02', {
        events: 1,
        skipped: 0,
      }),
    ).toBeUndefined();
    expect(await counters.get(scopeB, AUT_A, job)).toBeUndefined();
    expect(await counters.get(scopeA, AUT_A, job)).toEqual({
      runs: 1,
      skipped: 4000,
      events: 1001,
    });
    expect(await counters.get(scopeA, AUT_A, 'job_DispRepoRecomp02')).toBeUndefined();
  });

  it('maintenance purges counters older than 24 hours in every organization, by age only (T528)', async () => {
    // The cross-tenant delete of `purgeExpiredOperationalRows` (S§14.1).
    for (const [scope, automation] of [
      [scopeA, AUT_A],
      [scopeB, AUT_B],
    ] as const) {
      expect(await counters.claimRun(scope, automation, 'req_DispRepoPurgeOld', 10)).toBe(true);
      expect(await counters.claimRun(scope, automation, 'req_DispRepoPurgeNew', 10)).toBe(true);
    }
    await sql`
      UPDATE meta.automation_batch_counters
         SET created_at = now() - interval '25 hours'
       WHERE batch_id = 'req_DispRepoPurgeOld'
    `.execute(db.kysely);
    const before = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.automation_batch_counters
       WHERE created_at < now() - interval '24 hours'
    `.execute(db.kysely);
    const result = await purgeExpiredOperationalRows(db, { now: new Date(), batchSize: 1 });
    expect(result.automationBatchCounters).toBe(before.rows[0]?.n);
    expect(result.automationBatchCounters).toBeGreaterThanOrEqual(2);
    for (const [scope, automation] of [
      [scopeA, AUT_A],
      [scopeB, AUT_B],
    ] as const) {
      expect(await counters.get(scope, automation, 'req_DispRepoPurgeOld')).toBeUndefined();
      expect(await counters.get(scope, automation, 'req_DispRepoPurgeNew')).toEqual({
        runs: 1,
        skipped: 0,
        events: 0,
      });
    }
  });

  describe('50 failed trigger units in a row (ADR-26 §5)', () => {
    async function addUnits(count: number, status: 'failed' | 'succeeded', from: number) {
      for (let i = 0; i < count; i += 1) {
        const n = String(from + i).padStart(4, '0');
        await sql`
          INSERT INTO meta.automation_runs
                 (id, organization_id, automation_id, automation_version, trigger_event_id,
                  trigger_unit, status, created_at)
          VALUES (${`run_DispRepoFail${n}`}, ${ORG_A}, ${AUT_FAIL}, 1, ${`evt_DispRepoFail${n}`},
                  ${`evt_DispRepoFail${n}`}, ${status},
                  now() - make_interval(secs => ${10_000 - from - i}))
        `.execute(db.kysely);
      }
    }

    it('does not trip before 50 units, nor on another organization’s scope', async () => {
      const notices: string[] = [];
      const notifier: AutomationNotifier = {
        automationDisabled: (_tx, notice) => {
          notices.push(notice.automationId);
          return Promise.resolve();
        },
        batchOverflow: () => Promise.resolve(),
      };
      await addUnits(1, 'succeeded', 0);
      await addUnits(BREAKER_MAX_FAILED_UNITS - 1, 'failed', 1);
      expect(
        await db.withTx((tx) => tripOnConsecutiveFailures(db, tx, scopeA, AUT_FAIL, notifier)),
      ).toBe(false);
      await addUnits(1, 'failed', BREAKER_MAX_FAILED_UNITS);
      expect(
        await db.withTx((tx) => tripOnConsecutiveFailures(db, tx, scopeB, AUT_FAIL, notifier)),
      ).toBe(false);
      expect(notices).toEqual([]);
      expect(
        await db.withTx((tx) => tripOnConsecutiveFailures(db, tx, scopeA, AUT_FAIL, notifier)),
      ).toBe(true);
      expect(notices).toEqual([AUT_FAIL]);
      expect(await automations.get(scopeA, AUT_FAIL)).toMatchObject({
        enabled: false,
        disabled_reason: 'circuit_breaker',
        run_as_user_id: a.userId,
        version: 2,
      });
      const { rows } = await sql<{ action: string; actor_type: string; after: unknown }>`
        SELECT action, actor_type, after FROM meta.audit_logs
         WHERE organization_id = ${ORG_A} AND entity_id = ${AUT_FAIL}
      `.execute(db.kysely);
      expect(rows).toEqual([
        {
          action: 'automation.disabled',
          actor_type: 'system',
          after: { enabled: false, disabled_reason: 'circuit_breaker' },
        },
      ]);
      const events = await sql<{ type: string }>`
        SELECT type FROM meta.events WHERE organization_id = ${ORG_A} AND entity_id = ${AUT_FAIL}
      `.execute(db.kysely);
      expect(events.rows).toEqual([{ type: 'automation.disabled' }]);
      // Already off: nothing more.
      expect(
        await db.withTx((tx) => tripOnConsecutiveFailures(db, tx, scopeA, AUT_FAIL, notifier)),
      ).toBe(false);
    });
  });
});
