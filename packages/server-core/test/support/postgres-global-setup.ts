import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import type { TestProject } from 'vitest/node';

/** Non-superuser role owning every test database. */
export const TEST_DB_OWNER = { user: 'cellhive_owner', password: 'cellhive-test-password' };

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser URL of the shared PostgreSQL 18 container (no init.sql). */
    postgresAdminUrl: string;
  }
}

/**
 * One PostgreSQL 18 container for all integration test files; each file
 * creates its own database (`createTestDatabase`).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgres:18').start();
  const adminUrl = container.getConnectionUri();

  // Databases are owned by a plain role, as on managed PostgreSQL: the
  // migrations must not need superuser.
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(
      `CREATE ROLE ${client.escapeIdentifier(TEST_DB_OWNER.user)} LOGIN NOSUPERUSER NOCREATEROLE PASSWORD ${client.escapeLiteral(TEST_DB_OWNER.password)}`,
    );
  } finally {
    await client.end();
  }

  project.provide('postgresAdminUrl', adminUrl);
  return async () => {
    await container.stop();
  };
}
