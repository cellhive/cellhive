import { Inject, Injectable } from '@nestjs/common';

import { cacheReady } from '../../common/infra/connections.js';
import { CACHE_KEY_PREFIX } from '../../common/rate-limit/rate-limiter.js';
import { CACHE_CLIENT } from '../../common/tokens.js';

import type { WidgetCacheStore } from '@cellhive/server-core';
import type { Redis } from 'ioredis';

/** A Valkey command slower than this is treated as failed: the widget goes on without the cache. */
export const WIDGET_CACHE_COMMAND_TIMEOUT_MS = 500;

/** Compare-and-delete of a lock (only the holder of `token` frees it). */
const UNLOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * The widget cache on the shared Valkey client (BACKLOG T807, CONTRACTS
 * §28.5), keys under the instance prefix (`ob:dash:…`, `ob:dashlock:…`).
 * Every command fails fast — the client has no offline queue, and a
 * command that takes longer than {@link WIDGET_CACHE_COMMAND_TIMEOUT_MS}
 * rejects — so an outage only turns the cache off (`bypass`); it never
 * fails a widget. Tests swap `failing` on to simulate an outage.
 */
@Injectable()
export class ValkeyWidgetCacheStore implements WidgetCacheStore {
  /** Tests: every command rejects as if Valkey were down. */
  failing = false;

  constructor(@Inject(CACHE_CLIENT) private readonly cache: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.run((client) => client.get(`${CACHE_KEY_PREFIX}${key}`));
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.run((client) => client.set(`${CACHE_KEY_PREFIX}${key}`, value, 'PX', ttlMs));
  }

  async lock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.run((client) =>
      client.set(`${CACHE_KEY_PREFIX}${key}`, token, 'PX', ttlMs, 'NX'),
    );
    return result === 'OK';
  }

  async unlock(key: string, token: string): Promise<void> {
    await this.run((client) => client.eval(UNLOCK_SCRIPT, 1, `${CACHE_KEY_PREFIX}${key}`, token));
  }

  private async run<T>(command: (client: Redis) => Promise<T>): Promise<T> {
    if (this.failing) throw new Error('The widget cache is turned off (test)');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Valkey command timed out'));
      }, WIDGET_CACHE_COMMAND_TIMEOUT_MS);
      timer.unref();
    });
    try {
      return await Promise.race([
        (async () => {
          await cacheReady(this.cache);
          return command(this.cache);
        })(),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
