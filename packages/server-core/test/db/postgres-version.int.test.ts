import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertSupportedPostgres,
  MIN_SERVER_VERSION_NUM,
  UnsupportedPostgresVersionError,
  type Db,
} from '../../src/db/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';

describe('PostgreSQL version check (ADR-0019)', () => {
  it('accepts PostgreSQL 18', async () => {
    const database: TestDatabase = await createTestDatabase();
    const db = createTestDb(database.url);
    try {
      const version = await assertSupportedPostgres(db.kysely);
      expect(version.versionNum).toBeGreaterThanOrEqual(MIN_SERVER_VERSION_NUM);
      expect(version.version).toMatch(/^18\./);
    } finally {
      await db.destroy();
      await database.drop();
    }
  });

  describe('against postgres:17', () => {
    let container: StartedPostgreSqlContainer;
    let db: Db;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      db = createTestDb(container.getConnectionUri());
    });

    afterAll(async () => {
      await db.destroy();
      await container.stop();
    });

    it('rejects the server with an actionable message', async () => {
      const error: unknown = await assertSupportedPostgres(db.kysely).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(UnsupportedPostgresVersionError);
      const { message, serverVersionNum } = error as UnsupportedPostgresVersionError;
      expect(serverVersionNum).toBeGreaterThanOrEqual(170_000);
      expect(serverVersionNum).toBeLessThan(180_000);
      expect(message).toMatch(
        /^PostgreSQL 17\.\d+.* is not supported: Cellhive requires PostgreSQL 18 or newer/,
      );
      expect(message).toContain('docs/adr/0019-postgresql-18.md');
    });
  });
});
