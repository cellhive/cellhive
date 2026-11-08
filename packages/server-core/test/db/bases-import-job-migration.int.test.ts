import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigrator, orgScope, type Db } from '../../src/db/index.js';
import { BasesRepository } from '../../src/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG: Id<'org'> = 'org_T1018MigrationA1';
const JOB_1: Id<'job'> = 'job_T1018Migration01';
const JOB_2: Id<'job'> = 'job_T1018Migration02';

/**
 * BACKLOG T1018: migration 0059 on a database that already has bases —
 * one visible, one in the trash. Both keep every value with
 * `import_job_id = NULL`; afterwards a base with an import job is always
 * hidden, and one job builds one base.
 */
describe('migration 0059_bases_import_job (T1018)', () => {
  let database: TestDatabase;
  let db: Db;
  let tenant: SeededTenant;
  let trashed: Id<'bse'>;
  let before: unknown[];

  const rows = () => db.kysely.selectFrom('meta.bases').selectAll().orderBy('id').execute();

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    const migrator = createMigrator(db.kysely);
    expect((await migrator.migrateTo('0058_time_zone_offsets')).error).toBeUndefined();
    tenant = await seedTenant(db, ORG);
    trashed = (
      await new BasesRepository(db).create(orgScope(ORG), {
        workspaceId: tenant.workspaceId,
        ownerId: tenant.userId,
        name: 'Old',
      })
    ).id;
    await db.kysely
      .updateTable('meta.bases')
      .set({ deleted_at: new Date('2026-10-01T00:00:00Z') })
      .where('id', '=', trashed)
      .execute();
    before = await rows();
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('keeps every existing base as it was, with no import job', async () => {
    expect(await rows()).toEqual(
      (before as Record<string, unknown>[]).map((row) => ({ ...row, import_job_id: null })),
    );
  });

  it('refuses a visible base with an import job', async () => {
    await expect(
      db.kysely
        .updateTable('meta.bases')
        .set({ import_job_id: JOB_1 })
        .where('id', '=', tenant.baseId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('lets one job build one base only', async () => {
    const repo = new BasesRepository(db);
    const input = { workspaceId: tenant.workspaceId, ownerId: tenant.userId, name: 'Imported' };
    const first = await repo.create(orgScope(ORG), { ...input, importJobId: JOB_1 });
    expect(first.deleted_at).not.toBeNull();
    await expect(
      repo.create(orgScope(ORG), { ...input, importJobId: JOB_1 }),
    ).rejects.toMatchObject({ code: '23505' });
    expect((await repo.create(orgScope(ORG), { ...input, importJobId: JOB_2 })).import_job_id).toBe(
      JOB_2,
    );
  });
});
