import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigrator, migrateToLatest, type Db } from '../../src/db/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';

/** Migration 0006: backfill and constraint of `meta.password_resets.source`. */
describe('migration 0006_password_reset_source', () => {
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

  it('backfills admin links from created_by and everything else as self_service', async () => {
    const { error } = await createMigrator(db.kysely).migrateTo('0005_idempotency_claim_id');
    expect(error).toBeUndefined();
    await sql`
      INSERT INTO meta.users (id, email, display_name)
      VALUES ('usr_MigrUserA0000001', 'a@example.test', 'A'),
             ('usr_MigrAdmin000001', 'admin@example.test', 'Admin')
    `.execute(db.kysely);
    await sql`
      INSERT INTO meta.password_resets (id, user_id, token_hash, created_by, expires_at)
      VALUES ('pwr_MigrAdminLink001', 'usr_MigrUserA0000001', 'h-admin', 'usr_MigrAdmin000001', now()),
             ('pwr_MigrSelfLink0001', 'usr_MigrUserA0000001', 'h-self', NULL, now())
    `.execute(db.kysely);

    expect(await migrateToLatest(db.kysely)).toContain('0006_password_reset_source');

    const rows = await db.kysely
      .selectFrom('meta.password_resets')
      .select(['token_hash', 'source'])
      .orderBy('token_hash')
      .execute();
    expect(rows).toEqual([
      { token_hash: 'h-admin', source: 'admin' },
      { token_hash: 'h-self', source: 'self_service' },
    ]);
    // NOT NULL and limited to the three sources.
    for (const [source, code] of [
      [sql`NULL`, '23502'],
      [sql`'email'`, '23514'],
    ] as const) {
      await expect(
        sql`
          INSERT INTO meta.password_resets (id, user_id, token_hash, source, expires_at)
          VALUES ('pwr_MigrBadLink00001', 'usr_MigrUserA0000001', 'h-bad', ${source}, now())
        `.execute(db.kysely),
      ).rejects.toMatchObject({ code });
    }
  });
});
