import {
  assertSupportedPostgres,
  migrateJobQueue,
  migrateToLatest,
  type AppConfig,
} from '@cellhive/server-core';

import { createApiDb } from './common/infra/connections.js';

import type { Logger } from 'pino';

/**
 * `MODE=migrate` (and `pnpm db:migrate`): checks the server version, installs
 * or upgrades graphile-worker's schema (versioned by graphile-worker itself),
 * applies every pending meta migration, and closes the pools. Safe to run
 * again or from several containers at once (advisory locks; no-op when up to
 * date). The job queue goes first so meta migrations may reference it.
 */
export async function runMigrations(config: AppConfig, logger: Logger): Promise<readonly string[]> {
  // DDL may legitimately exceed the request timeout; one connection is enough.
  const db = createApiDb(config, logger, {
    poolMax: 1,
    statementTimeoutMs: 0,
    applicationName: 'cellhive-migrate',
  });
  try {
    const version = await assertSupportedPostgres(db.kysely);
    logger.info({ postgres: version.version }, 'running meta migrations');
    await migrateJobQueue({
      connectionString: config.database.url,
      logger: logger.child({ component: 'job-queue' }),
    });
    logger.info('job queue schema is up to date');
    const applied = await migrateToLatest(db.kysely);
    for (const name of applied) logger.info({ migration: name }, 'migration applied');
    logger.info({ applied: applied.length }, 'database is up to date');
    return applied;
  } finally {
    await db.destroy();
  }
}
