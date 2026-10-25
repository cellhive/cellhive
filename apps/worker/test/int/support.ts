import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import {
  createDb,
  loadConfig,
  migrateJobQueue,
  migrateToLatest,
  type AppConfig,
  type Db,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import pg from 'pg';
import { pino, type Logger } from 'pino';
import { inject } from 'vitest';

import { TEST_DB_OWNER } from './global-setup.js';

export interface TestDatabase {
  /** URL as the (non-superuser) database owner. */
  readonly url: string;
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

/** Empty database owned by the non-superuser role, migrated like `MODE=migrate` does. */
export async function createMigratedDatabase(): Promise<TestDatabase> {
  const name = `w_${randomBytes(6).toString('hex')}`;
  await withAdmin(async (client) => {
    await client.query(
      `CREATE DATABASE ${client.escapeIdentifier(name)} OWNER ${client.escapeIdentifier(TEST_DB_OWNER.user)}`,
    );
  });
  const url = new URL(inject('postgresAdminUrl'));
  url.pathname = `/${name}`;
  url.username = TEST_DB_OWNER.user;
  url.password = TEST_DB_OWNER.password;
  const database: TestDatabase = {
    url: url.toString(),
    drop: () =>
      withAdmin(async (client) => {
        // Let pools that are still closing (e.g. the job runner's) disconnect on
        // their own: FORCE would terminate them with 57P01, which surfaces as an
        // unhandled error in the test run.
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
  const db = createTestDb(database.url);
  try {
    await migrateToLatest(db.kysely);
  } finally {
    await db.destroy();
  }
  return database;
}

export function createTestDb(url: string): Db {
  return createDb({ url, poolMax: 4, applicationName: 'cellhive-worker-test' });
}

export function testConfig(databaseUrl: string, env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    MODE: 'worker',
    PUBLIC_URL: 'http://localhost:5173',
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: '4',
    // Not connected by the worker yet; only validated.
    CACHE_URL: 'redis://127.0.0.1:6379',
    APP_MASTER_KEY: Buffer.alloc(32, 3).toString('base64'),
    SESSION_SECRET: 'worker-test-session-secret-0123456789',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_PATH: '/tmp/cellhive-worker-test',
    WORKER_CONCURRENCY: '4',
    LOG_LEVEL: 'debug',
    ...env,
  });
}

export interface CapturedLogger {
  readonly logger: Logger;
  readonly lines: Record<string, unknown>[];
  readonly raw: () => string;
}

/** pino logger that keeps every line in memory. */
export function captureLogger(): CapturedLogger {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = pino({ level: 'debug', messageKey: 'msg' }, stream);
  return {
    logger,
    raw: () => chunks.join(''),
    get lines() {
      return chunks
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

/** Polls `check` until it returns a value other than `undefined`/`false`. */
export async function waitFor<T>(
  check: () => Promise<T | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 50, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface QueuedJob {
  readonly id: string;
  readonly task_identifier: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly locked_by: string | null;
  readonly run_at: Date;
  readonly last_error: string | null;
}

/** Jobs still in graphile-worker's queue (completed jobs are deleted). */
export async function queuedJobs(db: Db, task?: string): Promise<QueuedJob[]> {
  const { rows } = await sql<QueuedJob>`
    SELECT jobs.id::text AS id, jobs.task_identifier, p.payload, jobs.attempts, jobs.max_attempts,
           jobs.locked_by, jobs.run_at, jobs.last_error
      FROM graphile_worker.jobs
      JOIN graphile_worker._private_jobs p USING (id)
     WHERE ${task ?? null}::text IS NULL OR jobs.task_identifier = ${task ?? null}::text
     ORDER BY jobs.id
  `.execute(db.kysely);
  return rows;
}
