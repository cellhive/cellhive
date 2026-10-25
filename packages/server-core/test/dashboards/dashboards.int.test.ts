import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DashboardsRepository, DashboardWidgetsRepository } from '../../src/dashboards/index.js';
import {
  createMigrator,
  migrateToLatest,
  orgScope,
  withTxScope,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import { purgeExpiredOperationalRows } from '../../src/jobs/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_DashRepoOrgA0001';
const ORG_B = 'org_DashRepoOrgB0001';
const DSH_A = 'dsh_DashRepoDshA0001';
const DSH_B = 'dsh_DashRepoDshB0001';
const WGT_A = 'wgt_DashRepoWgtA0001';
const WGT_B = 'wgt_DashRepoWgtB0001';
const LAYOUT = { x: 0, y: 0, w: 6, h: 4 };

describe('Dashboards repositories: tenant isolation (T805)', () => {
  let database: TestDatabase;
  let db: Db;
  let dashboards: DashboardsRepository;
  let widgets: DashboardWidgetsRepository;
  let a: SeededTenant;
  let b: SeededTenant;
  let scopeA: OrgScope;
  let scopeB: OrgScope;

  const insertDashboard = (scope: OrgScope, tenant: SeededTenant, id: Id<'dsh'>, name: string) =>
    dashboards.insert(scope, {
      id,
      baseId: tenant.baseId,
      name,
      icon: null,
      description: null,
      theme: {},
      globalFilters: sql`'[]'::jsonb`,
      position: 0,
      createdBy: tenant.userId,
    });

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    dashboards = new DashboardsRepository(db);
    widgets = new DashboardWidgetsRepository(db);
    await insertDashboard(scopeA, a, DSH_A, 'Same name');
    await insertDashboard(scopeB, b, DSH_B, 'Same name');
    for (const [scope, id, dashboardId] of [
      [scopeA, WGT_A, DSH_A],
      [scopeB, WGT_B, DSH_B],
    ] as const) {
      await widgets.insert(scope, {
        id,
        dashboardId,
        type: 'text',
        title: 'Notes',
        config: { markdown: 'hi' },
        layout: LAYOUT,
      });
    }
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('reads only rows of the scope organization', async () => {
    expect(await dashboards.getById(scopeA, DSH_A)).toMatchObject({
      id: DSH_A,
      organization_id: ORG_A,
      version: 1,
      theme: {},
      global_filters: [],
    });
    expect(await dashboards.getById(scopeB, DSH_A)).toBeUndefined();
    expect(await dashboards.getById(scopeB, DSH_A, { includeDeleted: true })).toBeUndefined();
    expect(await dashboards.listByBase(scopeB, a.baseId)).toEqual([]);
    expect((await dashboards.listByBase(scopeA, a.baseId)).map((row) => row.widget_count)).toEqual([
      1,
    ]);
    expect(await dashboards.activeIdsByBase(scopeB, a.baseId)).toEqual([]);
    expect(await dashboards.activeIdsByBase(scopeA, a.baseId)).toEqual([DSH_A]);
    expect(await dashboards.countActive(scopeB, a.baseId)).toBe(0);
    expect(await dashboards.nameTaken(scopeB, a.baseId, 'SAME NAME')).toBe(false);
    expect(await dashboards.nameTaken(scopeA, a.baseId, 'SAME NAME')).toBe(true);
    expect(await dashboards.nameTaken(scopeA, a.baseId, 'same name', DSH_A)).toBe(false);
    expect(await dashboards.nextPosition(scopeB, a.baseId)).toBe(0);
    expect(await dashboards.nextPosition(scopeA, a.baseId)).toBe(1);
    expect(await dashboards.listTrash(scopeB, a.baseId)).toEqual([]);

    expect(await widgets.getById(scopeA, WGT_A)).toMatchObject({ id: WGT_A, layout: LAYOUT });
    expect(await widgets.getById(scopeB, WGT_A)).toBeUndefined();
    expect(await widgets.dashboardIdOf(scopeB, WGT_A)).toBeUndefined();
    expect(await widgets.dashboardIdOf(scopeA, WGT_A)).toBe(DSH_A);
    expect(await widgets.listByDashboard(scopeB, DSH_A)).toEqual([]);
    expect(await widgets.countByDashboard(scopeB, DSH_A)).toBe(0);
    expect(await widgets.countByDashboard(scopeA, DSH_A)).toBe(1);
  });

  it('never changes rows of another organization', async () => {
    expect(await dashboards.update(scopeB, DSH_A, { name: 'Hijacked' })).toBeUndefined();
    await dashboards.setPositions(scopeB, a.baseId, [{ id: DSH_A, position: 7 }]);
    expect(await dashboards.softDelete(scopeB, DSH_A, b.userId)).toBeUndefined();
    expect(await dashboards.restore(scopeB, DSH_A, 0)).toBeUndefined();
    expect(await widgets.update(scopeB, WGT_A, { title: 'Hijacked' })).toBeUndefined();
    expect(await widgets.delete(scopeB, WGT_A)).toBeUndefined();
    await db.withTx(async (tx) => {
      expect(await dashboards.lockById(withTxScope(scopeB, tx), DSH_A)).toBeUndefined();
    });
    expect(await dashboards.getById(scopeA, DSH_A)).toMatchObject({
      name: 'Same name',
      position: 0,
      version: 1,
      deleted_at: null,
    });
    expect(await widgets.getById(scopeA, WGT_A)).toMatchObject({ title: 'Notes' });
  });

  it('keeps names unique per base ignoring case, outside the trash', async () => {
    const id = 'dsh_DashRepoDup00001';
    await expect(insertDashboard(scopeA, a, id, 'SAME name')).rejects.toMatchObject({
      code: '23505',
    });
    const trashed = await insertDashboard(scopeA, a, id, 'Trashed one');
    expect((await dashboards.softDelete(scopeA, trashed.id, a.userId))?.version).toBe(2);
    // A trashed dashboard frees its name, and is listed in the trash only.
    await insertDashboard(scopeA, a, 'dsh_DashRepoDup00002', 'trashed ONE');
    expect((await dashboards.listTrash(scopeA, a.baseId)).map((row) => row.id)).toEqual([id]);
    expect(await dashboards.getById(scopeA, id)).toBeUndefined();
    expect(await dashboards.getById(scopeA, id, { includeDeleted: true })).toMatchObject({
      deleted_by: a.userId,
    });
    // Its name is taken again: restoring needs the other one renamed.
    await expect(dashboards.restore(scopeA, id, 9)).rejects.toMatchObject({ code: '23505' });
    await dashboards.update(scopeA, 'dsh_DashRepoDup00002', { name: 'Another' });
    const restored = await dashboards.restore(scopeA, id, 9);
    expect(restored).toMatchObject({ deleted_at: null, deleted_by: null, position: 9, version: 3 });
  });

  it('bumps the version on every update and checks the stored shapes', async () => {
    const updated = await dashboards.update(scopeA, DSH_A, { name: 'Renamed' });
    expect(updated).toMatchObject({ name: 'Renamed', version: 2 });
    expect((await dashboards.update(scopeA, DSH_A, {}))?.version).toBe(3);
    await expect(
      sql`UPDATE meta.dashboards SET theme = '[]'::jsonb WHERE id = ${DSH_A}`.execute(db.kysely),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`UPDATE meta.dashboard_widgets SET type = 'scatter' WHERE id = ${WGT_A}`.execute(
        db.kysely,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('deletes widgets with their dashboard, and dashboards with their base', async () => {
    const dashboard = await insertDashboard(scopeA, a, 'dsh_DashRepoCascade1', 'Cascade');
    await widgets.insert(scopeA, {
      id: 'wgt_DashRepoCascade1',
      dashboardId: dashboard.id,
      type: 'text',
      title: '',
      config: {},
      layout: LAYOUT,
    });
    await sql`DELETE FROM meta.dashboards WHERE id = ${dashboard.id}`.execute(db.kysely);
    expect(await widgets.getById(scopeA, 'wgt_DashRepoCascade1')).toBeUndefined();
  });

  it('purges dashboards trashed more than 30 days ago (maintenance.cleanup)', async () => {
    const old = await insertDashboard(scopeB, b, 'dsh_DashRepoOldTrash', 'Old');
    const recent = await insertDashboard(scopeB, b, 'dsh_DashRepoNewTrash', 'Recent');
    await widgets.insert(scopeB, {
      id: 'wgt_DashRepoOldTrash',
      dashboardId: old.id,
      type: 'text',
      title: '',
      config: {},
      layout: LAYOUT,
    });
    await dashboards.softDelete(scopeB, old.id, b.userId);
    await dashboards.softDelete(scopeB, recent.id, b.userId);
    await sql`UPDATE meta.dashboards SET deleted_at = now() - interval '31 days'
               WHERE id = ${old.id}`.execute(db.kysely);
    const result = await purgeExpiredOperationalRows(db, { now: new Date() });
    expect(result.dashboards).toBe(1);
    expect(await dashboards.getById(scopeB, old.id, { includeDeleted: true })).toBeUndefined();
    expect(await widgets.getById(scopeB, 'wgt_DashRepoOldTrash')).toBeUndefined();
    expect(await dashboards.getById(scopeB, recent.id, { includeDeleted: true })).toBeDefined();
    expect(await dashboards.getById(scopeB, DSH_B)).toBeDefined();
  });
});

describe('migration 0053_dashboards', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('applies on a database with data and leaves the data alone', async () => {
    const { error } = await createMigrator(db.kysely).migrateTo('0052_audit_logs_actor_action_idx');
    expect(error).toBeUndefined();
    const tenant = await seedTenant(db, 'org_DashMigrOrg00001');
    const before = await sql<{
      count: number;
    }>`SELECT count(*)::int AS count FROM meta.bases`.execute(db.kysely);

    expect(await migrateToLatest(db.kysely)).toContain('0053_dashboards');

    const after = await sql<{
      count: number;
    }>`SELECT count(*)::int AS count FROM meta.bases`.execute(db.kysely);
    expect(after.rows).toEqual(before.rows);
    const scope = orgScope(tenant.orgId);
    const created = await new DashboardsRepository(db).insert(scope, {
      id: 'dsh_DashMigrDsh00001',
      baseId: tenant.baseId,
      name: 'After migration',
      icon: null,
      description: null,
      theme: {},
      globalFilters: sql`'[]'::jsonb`,
      position: 0,
      createdBy: tenant.userId,
    });
    expect(created).toMatchObject({ version: 1, deleted_at: null });
    // A second run has nothing to do (forward-only, no `down`).
    expect(await migrateToLatest(db.kysely)).toEqual([]);
  });
});
