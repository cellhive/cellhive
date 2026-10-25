import { randomBytes } from 'node:crypto';

import { createDb, migrateJobQueue, migrateToLatest, type Db } from '@cellhive/server-core';
import pg from 'pg';
import { inject } from 'vitest';

export interface TestDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('databaseUrl') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * A fresh database in the shared container, migrated like `MODE=migrate`
 * (job queue schema, then the meta migrations). One per test file, so that
 * files running in parallel never see each other's users.
 */
export async function createMigratedDatabase(): Promise<TestDatabase> {
  const name = `a_${randomBytes(6).toString('hex')}`;
  await withAdmin(async (client) => {
    await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
  });
  const url = new URL(inject('databaseUrl'));
  url.pathname = `/${name}`;
  const database: TestDatabase = {
    url: url.toString(),
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
  await migrateJobQueue({ connectionString: database.url });
  const db = createDb({ url: database.url, poolMax: 1 });
  try {
    await migrateToLatest(db.kysely);
  } finally {
    await db.destroy();
  }
  return database;
}

export function createTestDb(url: string): Db {
  return createDb({ url, poolMax: 4, applicationName: 'cellhive-api-test' });
}
