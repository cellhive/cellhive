import { runMigrations } from 'graphile-worker';

import { createQueueLogger, type LogSink } from './queue-logger.js';
import { JOB_QUEUE_SCHEMA } from './tasks.js';

export interface MigrateJobQueueOptions {
  readonly connectionString: string;
  readonly logger?: LogSink;
}

/**
 * Installs or upgrades graphile-worker's own schema (`graphile_worker`).
 *
 * This is deliberately not a meta migration file: the DDL belongs to the
 * installed graphile-worker version, which tracks it in
 * `graphile_worker.migrations` (forward-only, serialised against concurrent
 * runs). A file in `src/db/migrations` could not pin that DDL in
 * `migrations.lock.json`. The migrate step (`MODE=migrate`) runs this before
 * the meta migrations, so a meta migration may reference `graphile_worker.*`;
 * the worker also runs it on start, which is a no-op when up to date.
 */
export async function migrateJobQueue(options: MigrateJobQueueOptions): Promise<void> {
  await runMigrations({
    connectionString: options.connectionString,
    schema: JOB_QUEUE_SCHEMA,
    maxPoolSize: 2,
    noPreparedStatements: false,
    ...(options.logger === undefined ? {} : { logger: createQueueLogger(options.logger) }),
  });
}
