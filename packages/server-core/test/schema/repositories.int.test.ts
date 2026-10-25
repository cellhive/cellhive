import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgScope, withTxScope, type Db, type OrgScope } from '../../src/db/index.js';
import { FieldsRepository, TablesRepository } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_SchemaRepoOrgA01';
const ORG_B = 'org_SchemaRepoOrgB01';
const TBL_A = 'tbl_SchemaRepoTblA01';
const TBL_B = 'tbl_SchemaRepoTblB01';
const FLD_A = 'fld_SchemaRepoFldA01';
const FLD_B = 'fld_SchemaRepoFldB01';

describe('TablesRepository / FieldsRepository tenant isolation', () => {
  let database: TestDatabase;
  let db: Db;
  let tables: TablesRepository;
  let fields: FieldsRepository;
  let a: SeededTenant;
  let b: SeededTenant;
  let scopeA: OrgScope;
  let scopeB: OrgScope;

  async function seed(
    scope: OrgScope,
    tenant: SeededTenant,
    tableId: Id<'tbl'>,
    fieldId: Id<'fld'>,
    short: string,
  ) {
    return db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      await tables.insert(txScope, {
        id: tableId,
        baseId: tenant.baseId,
        name: 'Same name',
        description: null,
        dbTableName: `t_${short}`,
        collation: 'und-x-icu',
        position: 0,
      });
      const field = await fields.insert(txScope, {
        id: fieldId,
        tableId,
        name: 'Name',
        type: 'text',
        dbColumnName: `f_${short}`,
        options: {},
        isPrimary: true,
        required: false,
        uniqueValues: false,
        description: null,
        position: 0,
      });
      const table = await tables.update(txScope, tableId, { primaryFieldId: fieldId });
      return { table: table as TableRow, field };
    });
  }

  let rowsA: { table: TableRow; field: FieldRow };

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    tables = new TablesRepository(db);
    fields = new FieldsRepository(db);
    rowsA = await seed(scopeA, a, TBL_A, FLD_A, 'aaaaaaaaaaaa');
    await seed(scopeB, b, TBL_B, FLD_B, 'bbbbbbbbbbbb');
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('reads only rows of the scope organization', async () => {
    expect(await tables.getById(scopeA, TBL_A)).toMatchObject({
      id: TBL_A,
      organization_id: ORG_A,
    });
    expect(await tables.getById(scopeB, TBL_A)).toBeUndefined();
    expect(await tables.listByBase(scopeB, a.baseId)).toEqual([]);
    // T469: the base trash of another organization is never read.
    await tables.update(scopeA, TBL_A, { deletedAt: new Date() });
    expect((await tables.listTrashByBase(scopeA, a.baseId)).map((row) => row.id)).toEqual([TBL_A]);
    expect(await tables.listTrashByBase(scopeB, a.baseId)).toEqual([]);
    expect(await tables.listTrashByBase(scopeB, b.baseId)).toEqual([]);
    await tables.update(scopeA, TBL_A, { deletedAt: null });
    expect(await tables.listTrashByBase(scopeA, a.baseId)).toEqual([]);
    expect(await tables.nameTaken(scopeB, a.baseId, 'Same name')).toBe(false);
    expect(await tables.nameTaken(scopeA, a.baseId, 'Same name')).toBe(true);
    expect(await tables.nextPosition(scopeB, a.baseId)).toBe(0);
    expect(await fields.getById(scopeA, FLD_A)).toMatchObject({ id: FLD_A, table_id: TBL_A });
    expect(await fields.getById(scopeB, FLD_A)).toBeUndefined();
    expect(await fields.listByTable(scopeB, TBL_A, { includeDeleted: true })).toEqual([]);
    expect((await fields.listByTables(scopeA, [TBL_A, TBL_B])).map((field) => field.id)).toEqual([
      FLD_A,
    ]);
    expect(await fields.listByTables(scopeB, [TBL_A])).toEqual([]);
    expect(await fields.listByTables(scopeA, [])).toEqual([]);
    expect(await fields.countActive(scopeB, TBL_A)).toBe(0);
    // nextPosition never counts fields of another organization's table.
    expect(await fields.nextPosition(scopeA, TBL_A)).toBe(1);
    expect(await fields.nextPosition(scopeB, TBL_A)).toBe(0);
    expect(await fields.countActive(scopeA, TBL_A)).toBe(1);
    expect(await fields.nameTaken(scopeB, TBL_A, 'Name')).toBe(false);
    expect((await fields.listActiveByBase(scopeA, a.baseId)).map((row) => row.id)).toEqual([FLD_A]);
    expect(await fields.listActiveByBase(scopeB, a.baseId)).toEqual([]);
  });

  it('never updates rows of another organization', async () => {
    expect(await tables.update(scopeB, TBL_A, { name: 'Hijacked' })).toBeUndefined();
    expect(await tables.setSchemaState(scopeB, TBL_A, 'compacting')).toBeUndefined();
    expect(await tables.markCompacted(scopeB, TBL_A)).toBeUndefined();
    expect(await fields.update(scopeB, FLD_A, { name: 'Hijacked' })).toBeUndefined();
    expect(await fields.markPurged(scopeB, TBL_A, [FLD_A])).toEqual([]);
    await tables.setPositions(scopeB, a.baseId, [{ id: TBL_A, position: 9 }]);
    await fields.setPositions(scopeB, TBL_A, [{ id: FLD_A, position: 9 }]);
    expect(await tables.getById(scopeA, TBL_A)).toMatchObject({
      name: rowsA.table.name,
      schema_state: 'ready',
      compacted_at: null,
    });
    expect(await fields.getById(scopeA, FLD_A)).toMatchObject({ name: 'Name', position: 0 });
    expect(await tables.getById(scopeA, TBL_A)).toMatchObject({ position: 0 });
  });

  it('rejects rows that point at another organization (composite foreign keys)', async () => {
    // A field of org B in org A's table.
    await expect(
      fields.insert(scopeB, {
        id: 'fld_SchemaRepoCross01',
        tableId: TBL_A,
        name: 'Cross',
        type: 'text',
        dbColumnName: 'f_cccccccccccc',
        options: {},
        isPrimary: false,
        required: false,
        uniqueValues: false,
        description: null,
        position: 1,
      }),
    ).rejects.toMatchObject({ code: '23503' });
    // A table of org B in org A's base.
    await expect(
      tables.insert(scopeB, {
        id: 'tbl_SchemaRepoCross01',
        baseId: a.baseId,
        name: 'Cross',
        description: null,
        dbTableName: 't_cccccccccccc',
        collation: 'und-x-icu',
        position: 1,
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps names unique per base / table outside the trash, and the primary field in its own table', async () => {
    await expect(
      tables.insert(scopeA, {
        id: 'tbl_SchemaRepoDupe001',
        baseId: a.baseId,
        name: 'Same name',
        description: null,
        dbTableName: 't_dddddddddddd',
        collation: 'und-x-icu',
        position: 1,
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'tables_base_name_key' });
    await expect(
      db.withTx(async (tx) => {
        await tables.update(withTxScope(scopeA, tx), TBL_A, { primaryFieldId: FLD_B });
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
