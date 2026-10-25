import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listExpiredImportUploads, orgScope, type Db, type OrgScope } from '../../src/db/index.js';
import { ImportsRepository } from '../../src/import/index.js';
import { JobsRepository } from '../../src/jobs/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_ImportRepoOrgA01';
const ORG_B = 'org_ImportRepoOrgB01';
const IMP_A: Id<'imp'> = 'imp_ImportRepoImpA01';
const IMP_B: Id<'imp'> = 'imp_ImportRepoImpB01';

describe('ImportsRepository tenant isolation (T308)', () => {
  let database: TestDatabase;
  let db: Db;
  let imports: ImportsRepository;
  let jobs: JobsRepository;
  let a: SeededTenant;
  let b: SeededTenant;
  let scopeA: OrgScope;
  let scopeB: OrgScope;
  const future = new Date(Date.now() + 3_600_000);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    imports = new ImportsRepository(db);
    jobs = new JobsRepository(db);
    for (const [scope, id, tenant] of [
      [scopeA, IMP_A, a],
      [scopeB, IMP_B, b],
    ] as const) {
      await imports.create(scope, {
        id,
        baseId: tenant.baseId,
        createdBy: tenant.userId,
        filename: 'data.csv',
        format: 'csv',
        size: 10,
        options: { columns: ['a'] },
        expiresAt: future,
      });
    }
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('never reads, changes, claims or deletes an upload of another organization', async () => {
    expect(await imports.getById(scopeA, IMP_B)).toBeUndefined();
    expect(
      await imports.getUsable(scopeA, { id: IMP_B, baseId: b.baseId, userId: b.userId }),
    ).toBeUndefined();
    expect(await imports.setOptions(scopeA, IMP_B, { x: 1 })).toBeUndefined();
    expect(await imports.mergeOptions(scopeA, IMP_B, { x: 1 })).toBeUndefined();
    const job = await jobs.create(scopeA, { type: 'table.import', createdBy: a.userId });
    expect(
      await imports.claim(scopeA, { id: IMP_B, baseId: b.baseId, userId: b.userId }, job.id),
    ).toBeUndefined();
    expect(await imports.delete(scopeA, IMP_B)).toBe(false);
    expect((await imports.getById(scopeB, IMP_B))?.options).toEqual({ columns: ['a'] });
  });

  it('uses an upload once, for its owner, in its base only', async () => {
    const other: Id<'usr'> = b.userId;
    const job = await jobs.create(scopeA, { type: 'table.import', createdBy: a.userId });
    const ref = { id: IMP_A, baseId: a.baseId, userId: a.userId };
    expect(await imports.getUsable(scopeA, { ...ref, userId: other })).toBeUndefined();
    expect(await imports.getUsable(scopeA, ref)).toBeDefined();
    expect((await imports.claim(scopeA, ref, job.id))?.job_id).toBe(job.id);
    expect(await imports.claim(scopeA, ref, job.id)).toBeUndefined();
    expect(await imports.getUsable(scopeA, ref)).toBeUndefined();
    expect((await imports.getByJob(scopeA, job.id))?.id).toBe(IMP_A);
    expect(await imports.getByJob(scopeB, job.id)).toBeUndefined();
    expect(
      (await imports.mergeOptions(scopeA, IMP_A, { created_table_id: 'tbl_x' }))?.options,
    ).toEqual({
      columns: ['a'],
      created_table_id: 'tbl_x',
    });
  });

  it('lists expired uploads whose job is not running (cleanup)', async () => {
    const past = new Date(Date.now() - 1000);
    const running = await jobs.create(scopeB, { type: 'table.import', createdBy: b.userId });
    await jobs.markRunning(scopeB, running.id);
    const busy = await imports.create(scopeB, {
      baseId: b.baseId,
      createdBy: b.userId,
      filename: 'busy.csv',
      format: 'csv',
      size: 1,
      options: {},
      expiresAt: past,
    });
    await imports.claim(scopeB, { id: busy.id, baseId: b.baseId, userId: b.userId }, running.id);
    // `claim` refuses expired uploads: attach the job directly for the test.
    await db.kysely
      .updateTable('meta.imports')
      .set({ job_id: running.id })
      .where('id', '=', busy.id)
      .execute();
    const idle = await imports.create(scopeA, {
      baseId: a.baseId,
      createdBy: a.userId,
      filename: 'idle.csv',
      format: 'csv',
      size: 1,
      options: {},
      expiresAt: past,
    });
    const expired = await listExpiredImportUploads(db.kysely, { now: new Date(), limit: 10 });
    expect(expired).toEqual([{ organizationId: ORG_A, id: idle.id }]);
    await jobs.markSucceeded(scopeB, running.id, {});
    expect(
      (await listExpiredImportUploads(db.kysely, { now: new Date(), limit: 10 })).map((u) => u.id),
    ).toEqual(expect.arrayContaining([idle.id, busy.id]));
  });
});
