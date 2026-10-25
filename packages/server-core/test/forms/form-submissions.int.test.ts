import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgScope, withTxScope, type Db, type OrgScope } from '../../src/db/index.js';
import { FormSubmissionsRepository } from '../../src/forms/index.js';
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

const ORG_A = 'org_FormSubsOrgA0001';
const ORG_B = 'org_FormSubsOrgB0001';
const TBL_A = 'tbl_FormSubsTblA0001';
const TBL_B = 'tbl_FormSubsTblB0001';
const VIW_A = 'viw_FormSubsViwA0001';
const VIW_B = 'viw_FormSubsViwB0001';

async function insertForm(
  db: Db,
  scope: OrgScope,
  tenant: SeededTenant,
  tableId: Id<'tbl'>,
  viewId: Id<'viw'>,
  short: string,
): Promise<void> {
  await new TablesRepository(db).insert(scope, {
    id: tableId,
    baseId: tenant.baseId,
    name: `Table ${short}`,
    description: null,
    dbTableName: `t_${short}`,
    collation: 'und-x-icu',
    position: 0,
  });
  await new ViewsRepository(db).insert(scope, {
    id: viewId,
    tableId,
    type: 'form',
    name: 'Form',
    config: {},
    position: 0,
    ownerId: null,
  });
}

describe('FormSubmissionsRepository (T306)', () => {
  let database: TestDatabase;
  let db: Db;
  let submissions: FormSubmissionsRepository;
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
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    submissions = new FormSubmissionsRepository(db);
    await insertForm(db, scopeA, a, TBL_A, VIW_A, 'aaaaaaaaaaaa');
    await insertForm(db, scopeB, b, TBL_B, VIW_B, 'bbbbbbbbbbbb');
    await submissions.insert(scopeA, {
      baseId: a.baseId,
      viewId: VIW_A,
      userId: a.userId,
      shareLinkId: null,
      recordId: 'rec_FormSubsRecA0001',
      submittedAt: new Date('2026-09-24T10:00:00.000Z'),
    });
    await submissions.insert(scopeA, {
      baseId: a.baseId,
      viewId: VIW_A,
      userId: a.userId,
      shareLinkId: 'shl_FormSubsLinkA001',
      recordId: 'rec_FormSubsRecA0002',
      submittedAt: new Date('2026-09-25T10:00:00.000Z'),
    });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('counts the submissions of one person to one form from an instant on', async () => {
    const since = (iso: string) => new Date(iso);
    expect(
      await submissions.countSince(scopeA, VIW_A, a.userId, since('1970-01-01T00:00:00Z')),
    ).toBe(2);
    expect(
      await submissions.countSince(scopeA, VIW_A, a.userId, since('2026-09-25T00:00:00Z')),
    ).toBe(1);
    expect(
      await submissions.countSince(scopeA, VIW_A, a.userId, since('2026-09-25T10:00:00Z')),
    ).toBe(1);
    expect(
      await submissions.countSince(scopeA, VIW_A, a.userId, since('2026-09-25T10:00:00.001Z')),
    ).toBe(0);
    expect(
      await submissions.countSince(scopeA, VIW_A, b.userId, since('1970-01-01T00:00:00Z')),
    ).toBe(0);
  });

  it('never reads or counts rows of another organization', async () => {
    expect(await submissions.countSince(scopeB, VIW_A, a.userId, new Date(0))).toBe(0);
    await submissions.insert(scopeB, {
      baseId: b.baseId,
      viewId: VIW_B,
      userId: b.userId,
      shareLinkId: null,
      recordId: 'rec_FormSubsRecB0001',
    });
    expect(await submissions.countSince(scopeB, VIW_B, b.userId, new Date(0))).toBe(1);
    expect(await submissions.countSince(scopeA, VIW_B, b.userId, new Date(0))).toBe(0);
  });

  it('cannot attach a row of one organization to the base of another', async () => {
    await expect(
      submissions.insert(scopeB, {
        baseId: a.baseId,
        viewId: VIW_A,
        userId: b.userId,
        shareLinkId: null,
        recordId: 'rec_FormSubsRecX0001',
      }),
    ).rejects.toThrow(/form_submissions_base_fkey/);
  });

  it('locks one person and form per transaction only', async () => {
    await expect(submissions.lockPerson(scopeA, VIW_A, a.userId)).rejects.toThrow(TypeError);
    await db.withTx(async (tx) => {
      await submissions.lockPerson(withTxScope(scopeA, tx), VIW_A, a.userId);
    });
  });

  it('goes with the form view', async () => {
    expect(await submissions.countSince(scopeB, VIW_B, b.userId, new Date(0))).toBe(1);
    await new ViewsRepository(db).delete(scopeB, VIW_B);
    expect(await submissions.countSince(scopeB, VIW_B, b.userId, new Date(0))).toBe(0);
  });
});
