import { SHARE_UNLOCK_MAX_FAILURES, SHARE_UNLOCK_WINDOW_SECONDS } from '@cellhive/contracts';
import { Inject, Injectable } from '@nestjs/common';

import {
  CACHE_KEY_PREFIX,
  cacheCommand,
  incrementWindow,
} from '../../common/rate-limit/rate-limiter.js';
import { CACHE_CLIENT } from '../../common/tokens.js';

import type { Redis } from 'ioredis';

export interface UnlockAttempt {
  /** `false`: the lock is on; the password is not checked (`429`). */
  readonly allowed: boolean;
  /** Position of this attempt in the window (1-based). */
  readonly count: number;
  readonly retryAfterSeconds: number;
}

/**
 * Wrong-password lock of `POST /shares/:token/unlock` (SPEC §15A.3, BACKLOG
 * S3 decision 5): per link and client IP, 5 wrong passwords within 15
 * minutes lock that IP out of the link for 15 minutes (`429` with
 * `Retry-After`). Attempts are counted atomically **before** the password
 * check, like the sign-in lock, so parallel guesses cannot exceed the
 * threshold. A correct password clears the counter. Keys expire with the
 * window: no IP is kept longer than 15 minutes.
 */
@Injectable()
export class ShareUnlockThrottle {
  constructor(@Inject(CACHE_CLIENT) private readonly cache: Redis) {}

  private failuresKey(key: string): string {
    return `${CACHE_KEY_PREFIX}share:unlock:failures:${key}`;
  }

  private lockKey(key: string): string {
    return `${CACHE_KEY_PREFIX}share:unlock:lock:${key}`;
  }

  /** Seconds the key stays locked; `0` when not locked. */
  async lockedFor(key: string): Promise<number> {
    const ttlMs = await cacheCommand(this.cache, (client) => client.pttl(this.lockKey(key)));
    return ttlMs > 0 ? Math.ceil(ttlMs / 1000) : 0;
  }

  async beginAttempt(key: string): Promise<UnlockAttempt> {
    const { count } = await incrementWindow(
      this.cache,
      this.failuresKey(key),
      SHARE_UNLOCK_WINDOW_SECONDS,
    );
    if (count <= SHARE_UNLOCK_MAX_FAILURES) return { allowed: true, count, retryAfterSeconds: 0 };
    await this.lock(key);
    return { allowed: false, count, retryAfterSeconds: SHARE_UNLOCK_WINDOW_SECONDS };
  }

  /** The password of `attempt` was wrong; returns whether this failure locked the key. */
  async recordFailure(key: string, attempt: UnlockAttempt): Promise<boolean> {
    if (attempt.count < SHARE_UNLOCK_MAX_FAILURES) return false;
    await this.lock(key);
    return true;
  }

  async reset(key: string): Promise<void> {
    await cacheCommand(this.cache, (client) =>
      client.del(this.failuresKey(key), this.lockKey(key)),
    );
  }

  private async lock(key: string): Promise<void> {
    await cacheCommand(this.cache, (client) =>
      client
        .multi()
        .set(this.lockKey(key), '1', 'EX', SHARE_UNLOCK_WINDOW_SECONDS)
        .del(this.failuresKey(key))
        .exec(),
    );
  }
}
