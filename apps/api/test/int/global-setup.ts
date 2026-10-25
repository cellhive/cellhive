import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    cacheUrl: string;
  }
}

/**
 * `max_connections` of the shared PostgreSQL container. Every test file runs
 * the API (pool of `DATABASE_POOL_MAX` = 10), a test pool (4) and often a
 * worker (graphile-worker pool `WORKER_CONCURRENCY` + 2 = 7, its LISTEN
 * client and a `Db` pool of 10): up to ~32 connections, times the files
 * Vitest runs at once (`availableParallelism() - 1`, 7 on an 8-CPU machine).
 * The image default of 100 was reached in full runs under load (T560: 101 to
 * 108 backends sampled): a worker then cannot get a connection ("too many
 * clients already", logged only to the captured test logger) while the
 * API's warm pool still answers, so tests waiting for a job time out.
 */
const POSTGRES_MAX_CONNECTIONS = 300;

/** Starts the containers shared by all API integration tests. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [postgres, valkey] = await Promise.all([
    new PostgreSqlContainer('postgres:18')
      .withCommand(['postgres', '-c', `max_connections=${String(POSTGRES_MAX_CONNECTIONS)}`])
      .start(),
    startValkey(),
  ]);
  project.provide('databaseUrl', postgres.getConnectionUri());
  project.provide('cacheUrl', `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`);
  return async () => {
    await Promise.all([postgres.stop(), valkey.stop()]);
  };
}

export function startValkey() {
  return new GenericContainer('valkey/valkey:8')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
}
