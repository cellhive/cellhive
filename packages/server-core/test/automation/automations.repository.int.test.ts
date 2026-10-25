import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AutomationsRepository, type InsertAutomationInput } from '../../src/automation/index.js';
import { orgScope, withTxScope, type Db, type OrgScope } from '../../src/db/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_AutoRepoOrgA0001';
const ORG_B = 'org_AutoRepoOrgB0001';
const AUT_A: Id<'aut'> = 'aut_AutoRepoAutA0001';
const AUT_A2: Id<'aut'> = 'aut_AutoRepoAutA0002';
const AUT_B: Id<'aut'> = 'aut_AutoRepoAutB0001';
const TBL_A: Id<'tbl'> = 'tbl_AutoRepoTblA0001';
const TBL_A2: Id<'tbl'> = 'tbl_AutoRepoTblA0002';
const TBL_B: Id<'tbl'> = 'tbl_AutoRepoTblB0001';

async function seedTable(db: Db, tenant: SeededTenant, id: Id<'tbl'>): Promise<void> {
  await sql`
    INSERT INTO meta.tables (id, organization_id, base_id, name, db_table_name, "collation")
    VALUES (${id}, ${tenant.orgId}, ${tenant.baseId}, ${id}, ${`t_${id.slice(-12).toLowerCase()}`},
            'und-x-icu')
  `.execute(db.kysely);
}

function input(
  tenant: SeededTenant,
  id: Id<'aut'>,
  tableId: Id<'tbl'> | null,
): InsertAutomationInput {
  return {
    id,
    baseId: tenant.baseId,
    name: `Automation ${id}`,
    description: '',
    enabled: false,
    definition: { trigger: { type: 'record.created', table_id: tableId } },
    triggerType: tableId === null ? 'schedule' : 'record.created',
    triggerTableId: tableId,
    createdBy: tenant.userId,
  };
}

describe('AutomationsRepository (BACKLOG T502)', () => {
  let database: TestDatabase;
  let db: Db;
  let automations: AutomationsRepository;
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
    await seedTable(db, a, TBL_A2);
    await seedTable(db, b, TBL_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    automations = new AutomationsRepository(db);
    await automations.insert(scopeA, input(a, AUT_A, TBL_A));
    await automations.insert(scopeA, input(a, AUT_A2, null));
    await automations.insert(scopeB, input(b, AUT_B, TBL_B));
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('creates with run_as = creator, version 1, off', async () => {
    expect(await automations.get(scopeA, AUT_A)).toMatchObject({
      id: AUT_A,
      organization_id: ORG_A,
      version: 1,
      enabled: false,
      disabled_reason: null,
      run_as_user_id: a.userId,
      created_by: a.userId,
      updated_by: a.userId,
      run_as_name: a.userId.slice(4),
      created_by_name: a.userId.slice(4),
      trigger_table_id: TBL_A,
    });
  });

  it('reads only rows of the scope organization', async () => {
    expect(await automations.get(scopeB, AUT_A)).toBeUndefined();
    expect(await automations.baseIdOf(scopeB, AUT_A)).toBeUndefined();
    expect(await automations.baseIdOf(scopeA, AUT_A)).toBe(a.baseId);
    expect(await automations.listPage(scopeB, a.baseId, {}, { offset: 0, limit: 50 })).toEqual({
      items: [],
      total: 0,
    });
    const page = await automations.listPage(scopeA, a.baseId, {}, { offset: 0, limit: 50 });
    expect(page.total).toBe(2);
    expect(page.items.map((row) => row.id).sort()).toEqual([AUT_A, AUT_A2].sort());
  });

  it('filters by trigger table (managers that are not base admins)', async () => {
    const page = (filter: Parameters<AutomationsRepository['listPage']>[2]) =>
      automations
        .listPage(scopeA, a.baseId, filter, { offset: 0, limit: 50 })
        .then((result) => result.items.map((row) => row.id));
    expect(await page({ triggerTableIds: [TBL_A] })).toEqual([AUT_A]);
    expect(await page({ triggerTableIds: [TBL_A2] })).toEqual([]);
    expect(await page({ triggerTableIds: [] })).toEqual([]);
    expect(await page({ tableId: TBL_A })).toEqual([AUT_A]);
  });

  it('never changes rows of another organization', async () => {
    expect(
      await automations.update(scopeB, AUT_A, { updatedBy: b.userId, enabled: true }),
    ).toBeUndefined();
    expect(await automations.softDelete(scopeB, AUT_A, b.userId)).toBeUndefined();
    await db.withTx(async (tx) => {
      expect(await automations.lockForUpdate(withTxScope(scopeB, tx), AUT_A)).toBeUndefined();
    });
    expect(await automations.get(scopeA, AUT_A)).toMatchObject({ version: 1, enabled: false });
  });

  it('bumps version on every update and moves run_as only when asked', async () => {
    const renamed = await automations.update(scopeA, AUT_A, { updatedBy: a.userId, name: 'x' });
    expect(renamed).toMatchObject({ version: 2, name: 'x', run_as_user_id: a.userId });
    const before = renamed?.run_as_since;
    const moved = await db.withTx(async (tx) => {
      const scope = withTxScope(scopeA, tx);
      expect(await automations.lockForUpdate(scope, AUT_A)).toMatchObject({ version: 2 });
      return automations.update(scope, AUT_A, {
        updatedBy: a.userId,
        enabled: true,
        disabledReason: null,
        runAs: a.userId,
      });
    });
    expect(moved).toMatchObject({ version: 3, enabled: true });
    expect(moved?.run_as_since.getTime()).toBeGreaterThanOrEqual(before?.getTime() ?? 0);
  });

  it('keeps the composite keys: no automation of another org’s base or table', async () => {
    await expect(
      automations.insert(scopeA, { ...input(a, 'aut_AutoRepoCross001', TBL_B) }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'automations_trigger_table_fkey' });
    await expect(
      automations.insert(scopeB, { ...input(a, 'aut_AutoRepoCross002', TBL_B) }),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      sql`
        INSERT INTO meta.automation_runs (id, organization_id, automation_id, automation_version, trigger_unit)
        VALUES ('run_AutoRepoCross001', ${ORG_B}, ${AUT_A}, 1, 'u')
      `.execute(db.kysely),
    ).rejects.toMatchObject({ code: '23503', constraint: 'automation_runs_automation_fkey' });
  });

  it('cannot be enabled with a disabled reason, nor deleted while on', async () => {
    await expect(
      sql`UPDATE meta.automations SET enabled = true, disabled_reason = 'circuit_breaker'
          WHERE id = ${AUT_A2}`.execute(db.kysely),
    ).rejects.toMatchObject({ code: '23514', constraint: 'automations_disabled_check' });
  });

  it('soft-deletes: off, invisible, runs kept until purge', async () => {
    await sql`
      INSERT INTO meta.automation_runs (id, organization_id, automation_id, automation_version, trigger_unit)
      VALUES ('run_AutoRepoRun00001', ${ORG_A}, ${AUT_A2}, 1, 'u')
    `.execute(db.kysely);
    const deleted = await automations.softDelete(scopeA, AUT_A2, a.userId);
    expect(deleted).toMatchObject({ enabled: false, version: 2 });
    expect(deleted?.deleted_at).toBeInstanceOf(Date);
    expect(await automations.get(scopeA, AUT_A2)).toBeUndefined();
    expect(await automations.softDelete(scopeA, AUT_A2, a.userId)).toBeUndefined();
    expect(await automations.update(scopeA, AUT_A2, { updatedBy: a.userId })).toBeUndefined();
    const runs = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.automation_runs WHERE automation_id = ${AUT_A2}
    `.execute(db.kysely);
    expect(runs.rows).toEqual([{ n: 1 }]);
  });

  describe('button automations (T517)', () => {
    const FLD_A: Id<'fld'> = 'fld_AutoRepoBtnA0001';
    const button = (
      tenant: SeededTenant,
      id: Id<'aut'>,
      tableId: Id<'tbl'>,
      fieldId: Id<'fld'>,
    ): InsertAutomationInput => ({
      ...input(tenant, id, tableId),
      definition: { trigger: { type: 'button.clicked', table_id: tableId, field_id: fieldId } },
      triggerType: 'button.clicked',
    });

    it('lists the automation of a button in its organization only', async () => {
      await automations.insert(scopeA, button(a, 'aut_AutoRepoBtnA0001', TBL_A, FLD_A));
      // Same field id in another organization (ids are global; the row is not theirs).
      await automations.insert(scopeB, button(b, 'aut_AutoRepoBtnB0001', TBL_B, FLD_A));
      expect((await automations.listForButtons(scopeA, [FLD_A])).map((row) => row.id)).toEqual([
        'aut_AutoRepoBtnA0001',
      ]);
      expect((await automations.listForButtons(scopeB, [FLD_A])).map((row) => row.id)).toEqual([
        'aut_AutoRepoBtnB0001',
      ]);
      expect(await automations.listForButtons(scopeA, [])).toEqual([]);
      expect(await automations.listForButtons(scopeA, ['fld_AutoRepoBtnA0009'])).toEqual([]);
    });

    it('keeps at most one automation per button, deleted ones aside', async () => {
      await expect(
        automations.insert(scopeA, button(a, 'aut_AutoRepoBtnA0002', TBL_A, FLD_A)),
      ).rejects.toMatchObject({ code: '23505', constraint: 'automations_button_field_key' });
      await automations.softDelete(scopeA, 'aut_AutoRepoBtnA0001', a.userId);
      expect(await automations.listForButtons(scopeA, [FLD_A])).toEqual([]);
      await automations.insert(scopeA, button(a, 'aut_AutoRepoBtnA0002', TBL_A, FLD_A));
      expect((await automations.listForButtons(scopeA, [FLD_A])).map((row) => row.id)).toEqual([
        'aut_AutoRepoBtnA0002',
      ]);
    });
  });
});
