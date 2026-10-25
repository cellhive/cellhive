import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  CACHE_KEY_PREFIX,
  cacheCommand,
  incrementWindow,
} from '../../common/rate-limit/rate-limiter.js';
import { CACHE_CLIENT } from '../../common/tokens.js';

import type { Redis } from 'ioredis';

/** Consecutive failures that lock an email (SPEC §14.2). */
export const LOCKOUT_THRESHOLD = 10;
/** Failures count within this window, starting at the first failure. */
export const LOCKOUT_WINDOW_SECONDS = 15 * 60;
/** How long a locked email stays locked. */
export const LOCKOUT_DURATION_SECONDS = 15 * 60;

/**
 * Key material for an email: SHA-256 of the lower-cased address, so Valkey
 * never holds raw emails.
 */
export function emailKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

export interface FailureResult {
  /** This failure locked the email. */
  readonly locked: boolean;
  readonly retryAfterSeconds: number;
}

/** A sign-in attempt counted before the password is checked. */
export interface AttemptResult {
  /** `false`: the threshold is reached, do not check the password (423). */
  readonly allowed: boolean;
  /** Position of this attempt in the window (1-based). */
  readonly count: number;
  readonly retryAfterSeconds: number;
}

/**
 * Lockout counters in Valkey, per email (SPEC §14.2): 10 consecutive
 * failures within 15 minutes lock the email for 15 minutes. Unknown emails
 * are counted too, so a lock reveals nothing about existence. A successful
 * sign-in or a password reset clears both counter and lock.
 *
 * The counter is incremented atomically (`INCR`) **before** the password is
 * checked (`beginAttempt`), so parallel attempts cannot run more than
 * `LOCKOUT_THRESHOLD` password checks per window: attempts beyond it are
 * refused unchecked and lock the email.
 */
@Injectable()
export class LoginThrottle {
  constructor(@Inject(CACHE_CLIENT) private readonly cache: Redis) {}

  private failuresKey(key: string): string {
    return `${CACHE_KEY_PREFIX}auth:failures:${key}`;
  }

  private lockKey(key: string): string {
    return `${CACHE_KEY_PREFIX}auth:lock:${key}`;
  }

  /** Seconds the email stays locked; `0` when not locked. */
  async lockedFor(key: string): Promise<number> {
    const ttlMs = await cacheCommand(this.cache, (client) => client.pttl(this.lockKey(key)));
    return ttlMs > 0 ? Math.ceil(ttlMs / 1000) : 0;
  }

  /**
   * Counts an attempt before the password check. The first
   * `LOCKOUT_THRESHOLD` attempts of a window are allowed; any further one
   * locks the email and is refused without checking the password.
   */
  async beginAttempt(key: string): Promise<AttemptResult> {
    const { count } = await incrementWindow(
      this.cache,
      this.failuresKey(key),
      LOCKOUT_WINDOW_SECONDS,
    );
    if (count <= LOCKOUT_THRESHOLD) {
      // `lock` sets the lock and clears the counter atomically, so a parallel
      // attempt that passed the caller's lock check before the lock was set
      // can see a restarted counter here; the lock still refuses it.
      const lockedFor = await this.lockedFor(key);
      if (lockedFor > 0) return { allowed: false, count, retryAfterSeconds: lockedFor };
      return { allowed: true, count, retryAfterSeconds: 0 };
    }
    await this.lock(key);
    return { allowed: false, count, retryAfterSeconds: LOCKOUT_DURATION_SECONDS };
  }

  /**
   * The password check of `attempt` failed: the attempt that reached the
   * threshold locks the email.
   */
  async recordFailure(key: string, attempt: AttemptResult): Promise<FailureResult> {
    if (attempt.count < LOCKOUT_THRESHOLD) return { locked: false, retryAfterSeconds: 0 };
    await this.lock(key);
    return { locked: true, retryAfterSeconds: LOCKOUT_DURATION_SECONDS };
  }

  private async lock(key: string): Promise<void> {
    await cacheCommand(this.cache, (client) =>
      client
        .multi()
        .set(this.lockKey(key), '1', 'EX', LOCKOUT_DURATION_SECONDS)
        .del(this.failuresKey(key))
        .exec(),
    );
  }

  /** Clears failures and any lock of the email. */
  async reset(key: string): Promise<void> {
    await cacheCommand(this.cache, (client) =>
      client.del(this.failuresKey(key), this.lockKey(key)),
    );
  }
}
