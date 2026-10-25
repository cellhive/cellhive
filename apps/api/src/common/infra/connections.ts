import { createDb, type AppConfig, type Db, type DbConfig } from '@cellhive/server-core';
import { Redis } from 'ioredis';

import type { Logger } from 'pino';

/**
 * Kysely + `pg` pool for the API. Connections open lazily, run in UTC and
 * default to the request `statement_timeout` (SPEC §14.2).
 */
export function createApiDb(
  config: AppConfig,
  logger: Logger,
  overrides: Partial<DbConfig> = {},
): Db {
  return createDb({
    url: config.database.url,
    poolMax: config.database.poolMax,
    applicationName: 'cellhive-api',
    onIdleError: (err) => {
      logger.warn({ err, dependency: 'database' }, 'idle database client failed');
    },
    ...overrides,
  });
}

/**
 * Valkey client. Commands fail fast while disconnected (no offline queue), so
 * `/readyz` reports an outage instead of hanging; the client keeps
 * reconnecting in the background.
 */
export function createCacheClient(config: AppConfig, logger: Logger): Redis {
  const client = new Redis(config.cache.url, {
    connectionName: 'cellhive-api',
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
  // Log transitions only, not every reconnect attempt.
  let healthy = true;
  client.on('error', (err: Error) => {
    if (healthy) {
      healthy = false;
      logger.warn({ err, dependency: 'cache' }, 'cache connection failed');
    }
  });
  client.on('ready', () => {
    if (!healthy) logger.info({ dependency: 'cache' }, 'cache connection restored');
    healthy = true;
  });
  return client;
}

/**
 * PING that waits for an initial connection in progress (right after start)
 * but fails immediately while the client is disconnected or reconnecting.
 */
export async function pingCache(client: Redis): Promise<void> {
  await cacheReady(client);
  await client.ping();
}

/**
 * Waits for a connection in progress (right after start, since commands are
 * not queued while offline); resolves at once when ready, and lets commands
 * fail fast while the client is disconnected or reconnecting.
 */
export async function cacheReady(client: Redis): Promise<void> {
  if (client.status === 'connecting' || client.status === 'connect') {
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        client.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        client.off('ready', onReady);
        reject(err);
      };
      client.once('ready', onReady);
      client.once('error', onError);
    });
  }
}

export async function closeCacheClient(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
