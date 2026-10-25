import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createMigrator,
  migrateToLatest,
  orgScope,
  withTxScope,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import { TablesRepository } from '../../src/schema/index.js';
import { ViewsRepository } from '../../src/views/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_ViewsRepoOrgA001';
const ORG_B = 'org_ViewsRepoOrgB001';
const TBL_A = 'tbl_ViewsRepoTblA001';
const TBL_B = 'tbl_ViewsRepoTblB001';
const VIW_A = 'viw_ViewsRepoViwA001';
const VIW_B = 'viw_ViewsRepoViwB001';

async function insertTable(
  db: Db,
  scope: OrgScope,
  tenant: SeededTenant,
  tableId: Id<'tbl'>,
  short: string,
): Promise<void> {
  // Meta row only: these tests never touch the data table.
  await new TablesRepository(db).insert(scope, {
    id: tableId,
    baseId: tenant.baseId,
    name: `Table ${short}`,
    description: null,
    dbTableName: `t_${short}`,
    collation: 'und-x-icu',
    position: 0,
  });
}

describe('ViewsRepository tenant isolation (T301)', () => {
  let database: TestDatabase;
  let db: Db;
  let views: ViewsRepository;
  let a: SeededTenant;
  let scopeA: OrgScope;
  let scopeB: OrgScope;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    const b = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    views = new ViewsRepository(db);
    await insertTable(db, scopeA, a, TBL_A, 'aaaaaaaaaaaa');
    await insertTable(db, scopeB, b, TBL_B, 'bbbbbbbbbbbb');
    for (const [scope, id, tableId] of [
      [scopeA, VIW_A, TBL_A],
      [scopeB, VIW_B, TBL_B],
    ] as const) {
      await views.insert(scope, {
        id,
        tableId,
        type: 'grid',
        name: 'Same name',
        config: {},
        position: 0,
        ownerId: null,
      });
    }
    await views.insert(scopeA, {
      id: 'viw_ViewsRepoMine001',
      tableId: TBL_A,
      type: 'grid',
      name: 'Mine',
      config: {},
      position: 0,
      ownerId: a.userId,
    });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('reads only rows of the scope organization', async () => {
    expect(await views.getById(scopeA, VIW_A)).toMatchObject({ id: VIW_A, organization_id: ORG_A });
    expect(await views.getById(scopeB, VIW_A)).toBeUndefined();
    expect(await views.listByTable(scopeB, TBL_A, a.userId)).toEqual([]);
    expect(await views.listGroup(scopeB, TBL_A, { ownerId: null })).toEqual([]);
    expect(await views.sharedIdsByBase(scopeB, a.baseId)).toEqual(new Map());
    expect(await views.sharedIdsByBase(scopeA, a.baseId)).toEqual(new Map([[TBL_A, [VIW_A]]]));
    expect(await views.counts(scopeB, TBL_A, a.userId)).toEqual({
      total: 0,
      shared: 0,
      personal: 0,
    });
    expect(await views.counts(scopeA, TBL_A, a.userId)).toEqual({
      total: 2,
      shared: 1,
      personal: 1,
    });
    expect(await views.nameTaken(scopeB, TBL_A, { ownerId: null }, 'same NAME')).toBe(false);
    expect(await views.nameTaken(scopeA, TBL_A, { ownerId: null }, 'same NAME')).toBe(true);
    expect(await views.nextPosition(scopeB, TBL_A, { ownerId: null })).toBe(0);
    expect(await views.nextPosition(scopeA, TBL_A, { ownerId: null })).toBe(1);
    expect(await views.existingIds(scopeB, [VIW_A])).toEqual(new Set());
    expect(await views.existingIds(scopeA, [VIW_A, 'viw_0000000000000000'])).toEqual(
      new Set([VIW_A]),
    );
  });

  it('reads saved filters of a table only in the scope organization (T313)', async () => {
    const filter = {
      op: 'and',
      items: [{ field: 'fld_ViewsRepoCost001', operator: 'gt', value: 1 }],
    };
    await views.insert(scopeA, {
      id: 'viw_ViewsRepoFilt001',
      tableId: TBL_A,
      type: 'grid',
      name: 'Filtered',
      config: { filter },
      position: 1,
      ownerId: null,
    });
    expect(await views.filtersByTable(scopeA, TBL_A)).toEqual([filter]);
    expect(await views.filtersByTable(scopeB, TBL_A)).toEqual([]);
    await views.delete(scopeA, 'viw_ViewsRepoFilt001');
  });

  it('lists shared views first, then only the given owner’s personal views', async () => {
    expect((await views.listByTable(scopeA, TBL_A, a.userId)).map((view) => view.id)).toEqual([
      VIW_A,
      'viw_ViewsRepoMine001',
    ]);
    expect((await views.listByTable(scopeA, TBL_A, null)).map((view) => view.id)).toEqual([VIW_A]);
  });

  it('never changes rows of another organization', async () => {
    expect(await views.update(scopeB, VIW_A, { name: 'Hijacked' })).toBeUndefined();
    await views.setPositions(scopeB, TBL_A, [{ id: VIW_A, position: 7 }]);
    expect(await views.delete(scopeB, VIW_A)).toBeUndefined();
    await db.withTx(async (tx) => {
      expect(await views.lockById(withTxScope(scopeB, tx), VIW_A)).toBeUndefined();
    });
    expect(await views.getById(scopeA, VIW_A)).toMatchObject({ name: 'Same name', position: 0 });
  });

  it('keeps names unique per group, ignoring case, and owners on personal views only', async () => {
    const insert = (id: Id<'viw'>, name: string, ownerId: Id<'usr'> | null) =>
      views.insert(scopeA, {
        id,
        tableId: TBL_A,
        type: 'grid',
        name,
        config: {},
        position: 5,
        ownerId,
      });
    await expect(insert('viw_ViewsRepoDup00001', 'SAME name', null)).rejects.toMatchObject({
      code: '23505',
    });
    // A personal view may reuse a shared view's name.
    await insert('viw_ViewsRepoDup00002', 'Same name', a.userId);
    await expect(insert('viw_ViewsRepoDup00003', 'mine', a.userId)).rejects.toMatchObject({
      code: '23505',
    });
    await expect(
      sql`UPDATE meta.views SET locked = true WHERE id = 'viw_ViewsRepoMine001'`.execute(db.kysely),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('migration 0007_views', () => {
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

  it('gives every existing table, trash included, exactly one default grid view', async () => {
    const { error } = await createMigrator(db.kysely).migrateTo('0006_password_reset_source');
    expect(error).toBeUndefined();
    const tenant = await seedTenant(db, ORG_A);
    const scope = orgScope(ORG_A);
    await insertTable(db, scope, tenant, TBL_A, 'aaaaaaaaaaaa');
    await insertTable(db, scope, tenant, TBL_B, 'bbbbbbbbbbbb');
    await new TablesRepository(db).update(scope, TBL_B, { deletedAt: new Date() });

    expect(await migrateToLatest(db.kysely)).toContain('0007_views');

    const rows = await new ViewsRepository(db).listByTable(scope, TBL_A, null);
    const trashed = await new ViewsRepository(db).listByTable(scope, TBL_B, null);
    for (const list of [rows, trashed]) {
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        organization_id: ORG_A,
        type: 'grid',
        name: 'Grid view',
        position: 0,
        is_personal: false,
        owner_id: null,
        locked: false,
        config: expect.objectContaining({
          filter: null,
          sort: [],
          row_height: 'short',
        }) as unknown,
      });
      expect(list[0]?.id).toMatch(/^viw_[0-9A-Za-z]{16}$/);
    }
    expect(rows[0]?.id).not.toBe(trashed[0]?.id);
  });
});
