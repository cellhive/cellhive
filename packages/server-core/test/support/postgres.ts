import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { inject } from 'vitest';

import { createDb, migrateToLatest, type Db, type DbConfig } from '../../src/db/index.js';
import { migrateJobQueue } from '../../src/jobs/index.js';

import { TEST_DB_OWNER } from './postgres-global-setup.js';

export interface TestDatabase {
  /** Connection URL as the (non-superuser) database owner. */
  readonly url: string;
  /** Superuser URL of the same database, for assertions only. */
  readonly adminUrl: string;
  drop(): Promise<void>;
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('postgresAdminUrl') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates an empty database owned by `TEST_DB_OWNER`. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  await withAdmin(async (client) => {
    await client.query(
      `CREATE DATABASE ${client.escapeIdentifier(name)} OWNER ${client.escapeIdentifier(TEST_DB_OWNER.user)}`,
    );
  });
  const adminUrl = new URL(inject('postgresAdminUrl'));
  adminUrl.pathname = `/${name}`;
  const url = new URL(adminUrl);
  url.username = TEST_DB_OWNER.user;
  url.password = TEST_DB_OWNER.password;
  return {
    url: url.toString(),
    adminUrl: adminUrl.toString(),
    drop: () =>
      withAdmin(async (client) => {
        // Let pools that are still closing disconnect on their own: FORCE would
        // terminate them with 57P01, which surfaces as an unhandled test error.
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const { rows } = await client.query<{ count: string }>(
            'SELECT count(*) FROM pg_stat_activity WHERE datname = $1',
            [name],
          );
          if (rows[0]?.count === '0') break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`);
      }),
  };
}

export function createTestDb(url: string, overrides: Partial<DbConfig> = {}): Db {
  return createDb({ url, poolMax: 4, applicationName: 'cellhive-test', ...overrides });
}

/** graphile-worker's schema, then the meta migrations: what `MODE=migrate` does. */
export async function migrateAll(url: string, db: Db): Promise<void> {
  await migrateJobQueue({ connectionString: url });
  await migrateToLatest(db.kysely);
}
