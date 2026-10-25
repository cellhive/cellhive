import {
  attachRealtimePublisher,
  ValkeyRealtimeBus,
  type AppConfig,
  type Db,
  type RealtimePublisher,
} from '@cellhive/server-core';
import { Redis } from 'ioredis';

import type { Logger } from 'pino';

/**
 * Valkey connection of the worker, used to publish on the realtime bus.
 * Commands fail fast while disconnected (no offline queue): a job never
 * waits for realtime; the client keeps reconnecting in the background.
 */
export function createWorkerCacheClient(config: AppConfig, logger: Logger): Redis {
  const client = new Redis(config.cache.url, {
    connectionName: 'cellhive-worker',
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
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
 * The realtime bus of the worker (SPEC §15), attached to its `Db`: job
 * state (`JobsRepository`), permission versions and schema changes made by
 * jobs reach WebSocket clients through the api instances. Failures are
 * logged and never fail a job.
 */
export function createWorkerRealtimeBus(db: Db, cache: Redis, logger: Logger): RealtimePublisher {
  const bus = new ValkeyRealtimeBus(cache, (err, envelope) => {
    logger.warn(
      { err, envelope_type: envelope.type, org_id: envelope.organization_id },
      'realtime publish failed',
    );
  });
  attachRealtimePublisher(db, bus);
  return bus;
}

export async function closeWorkerCacheClient(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
