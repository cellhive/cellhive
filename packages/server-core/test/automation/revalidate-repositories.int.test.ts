import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AutomationRunsRepository,
  AutomationsRepository,
  requestRunAsRevalidation,
  revalidateRunAsJobKey,
} from '../../src/automation/index.js';
import { BasesRepository, orgScope, withTxScope, type Db } from '../../src/db/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A: Id<'org'> = 'org_RevalRepoOrgA001';
const ORG_B: Id<'org'> = 'org_RevalRepoOrgB001';
const AUT_A1: Id<'aut'> = 'aut_RevalRepoAutA001';
const AUT_A2: Id<'aut'> = 'aut_RevalRepoAutA002';
const AUT_A_OFF: Id<'aut'> = 'aut_RevalRepoAutA003';
const AUT_B: Id<'aut'> = 'aut_RevalRepoAutB001';

async function seedAutomation(
  db: Db,
  tenant: SeededTenant,
  id: Id<'aut'>,
  enabled: boolean,
): Promise<void> {
  await new AutomationsRepository(db).insert(orgScope(tenant.orgId), {
    id,
    baseId: tenant.baseId,
    name: id,
    description: '',
    enabled,
    definition: { trigger: { type: 'schedule', cron: '0 9 * * *' } },
    triggerType: 'schedule',
    triggerTableId: null,
    createdBy: tenant.userId,
  });
}

async function revalidationJobs(db: Db): Promise<{ key: string | null; payload: unknown }[]> {
  const { rows } = await sql<{ key: string | null; payload: unknown }>`
    SELECT p.key, p.payload
      FROM graphile_worker._private_jobs AS p
      JOIN graphile_worker._private_tasks AS k ON k.id = p.task_id
     WHERE k.identifier = 'automation.revalidate_run_as'
     ORDER BY p.key
  `.execute(db.kysely);
  return rows;
}

/**
 * BACKLOG T507: the repository methods of the `run_as` check and the job
 * request stay inside their organization (AGENTS.md rule 5) — bases with
 * enabled automations, the keyset page of enabled automations, cancelling
 * queued runs — and a `permission_version` bump queues one debounced job
 * per base with enabled automations, none for the others.
 */
describe('run_as check repositories (BACKLOG T507)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    await seedAutomation(db, a, AUT_A1, true);
    await seedAutomation(db, a, AUT_A2, true);
    await seedAutomation(db, a, AUT_A_OFF, false);
    await seedAutomation(db, b, AUT_B, true);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('lists bases and enabled automations of the scope organization only', async () => {
    const automations = new AutomationsRepository(db);
    expect(await automations.baseIdsWithEnabled(orgScope(ORG_A), [a.baseId, b.baseId])).toEqual([
      a.baseId,
    ]);
    expect(await automations.baseIdsWithEnabled(orgScope(ORG_B), [a.baseId])).toEqual([]);
    expect(await automations.baseIdsWithEnabled(orgScope(ORG_A), [])).toEqual([]);

    const page = (scope: Id<'org'>, baseId: Id<'bse'> | null, after: Id<'aut'> | null) =>
      automations
        .listEnabledPage(orgScope(scope), { baseId, after, limit: 1 })
        .then((rows) => rows.map((row) => row.id));
    expect(await page(ORG_A, null, null)).toEqual([AUT_A1]);
    expect(await page(ORG_A, null, AUT_A1)).toEqual([AUT_A2]);
    expect(await page(ORG_A, null, AUT_A2)).toEqual([]);
    expect(await page(ORG_A, a.baseId, null)).toEqual([AUT_A1]);
    // Another organization's base: nothing.
    expect(await page(ORG_A, b.baseId, null)).toEqual([]);
    expect(await page(ORG_B, null, null)).toEqual([AUT_B]);
  });

  it('cancels the queued runs of an automation of the scope organization only', async () => {
    const runs = new AutomationRunsRepository(db);
    const insert = (tenant: SeededTenant, automationId: Id<'aut'>, id: Id<'run'>) =>
      runs.insert(orgScope(tenant.orgId), {
        id,
        automationId,
        automationVersion: 1,
        triggerEventId: null,
        triggerUnit: id,
        status: 'queued',
        depth: 0,
        input: {},
      });
    await insert(a, AUT_A1, 'run_RevalRepoRunA001');
    await insert(a, AUT_A1, 'run_RevalRepoRunA002');
    await insert(b, AUT_B, 'run_RevalRepoRunB001');
    await runs.startSegment(orgScope(ORG_A), 'run_RevalRepoRunA002', new Date());
    const at = new Date();
    const error = { code: 'automation_disabled' };

    expect(await runs.cancelQueuedOf(orgScope(ORG_B), AUT_A1, { at, error })).toEqual([]);
    expect(await runs.cancelQueuedOf(orgScope(ORG_A), AUT_A1, { at, error })).toEqual([
      'run_RevalRepoRunA001',
    ]);
    expect(await runs.get(orgScope(ORG_A), 'run_RevalRepoRunA001')).toMatchObject({
      status: 'cancelled',
      error,
      finished_at: at,
    });
    // A running run is left to the engine; another organization's run untouched.
    expect(await runs.get(orgScope(ORG_A), 'run_RevalRepoRunA002')).toMatchObject({
      status: 'running',
    });
    expect(await runs.get(orgScope(ORG_B), 'run_RevalRepoRunB001')).toMatchObject({
      status: 'queued',
    });
  });

  it('a permission_version bump queues one debounced check per base with enabled automations', async () => {
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
    const bases = new BasesRepository(db);
    // Organization B has another base without automations: no job for it.
    const empty = await bases.create(orgScope(ORG_B), {
      workspaceId: b.workspaceId,
      ownerId: b.userId,
      name: 'Empty',
    });
    await db.withTx((tx) =>
      bases.bumpPermissionVersion(withTxScope(orgScope(ORG_B), tx), { baseIds: [empty.id] }),
    );
    expect(await revalidationJobs(db)).toEqual([]);

    await db.withTx((tx) =>
      bases.bumpPermissionVersion(withTxScope(orgScope(ORG_A), tx), { all: true }),
    );
    // Twice in a row: still one pending job (job key).
    await db.withTx((tx) =>
      bases.bumpPermissionVersion(withTxScope(orgScope(ORG_A), tx), { all: true }),
    );
    expect(await revalidationJobs(db)).toEqual([
      {
        key: revalidateRunAsJobKey(a.baseId),
        payload: { organization_id: ORG_A, base_id: a.baseId, after: null },
      },
    ]);

    // A rolled back change queues nothing.
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
    await db
      .withTx(async (tx) => {
        await requestRunAsRevalidation(db, tx, withTxScope(orgScope(ORG_B), tx), [b.baseId]);
        throw new RangeError('rollback');
      })
      .catch(() => undefined);
    expect(await revalidationJobs(db)).toEqual([]);
  });
});
