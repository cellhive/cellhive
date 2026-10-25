import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { cacheReady } from '../infra/connections.js';
import { CACHE_CLIENT } from '../tokens.js';

import type { Redis } from 'ioredis';

/** Prefix of every key the API writes to Valkey. */
export const CACHE_KEY_PREFIX = 'ob:';

export interface RateLimitRule {
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Wraps a Valkey failure: the security checks that depend on Valkey
 * (rate limits, lockout counters) fail closed with `503`.
 */
export function cacheUnavailable(cause: unknown): AppError {
  return new AppError('DEPENDENCY_UNAVAILABLE', {
    detail: 'A required service is temporarily unavailable.',
    cause,
  });
}

/**
 * Runs Valkey commands once the initial connection is up; any failure
 * becomes `503 DEPENDENCY_UNAVAILABLE`.
 */
export async function cacheCommand<T>(cache: Redis, run: (cache: Redis) => Promise<T>): Promise<T> {
  try {
    await cacheReady(cache);
    return await run(cache);
  } catch (error) {
    throw cacheUnavailable(error);
  }
}

/**
 * Fixed-window counter in Valkey: `INCR`, with the expiry set by the first
 * hit of the window. Returns the count and the milliseconds left in the
 * window.
 */
export async function incrementWindow(
  cache: Redis,
  key: string,
  windowSeconds: number,
): Promise<{ count: number; ttlMs: number }> {
  const results = await cacheCommand(cache, (client) =>
    client.multi().incr(key).expire(key, windowSeconds, 'NX').pttl(key).exec(),
  );
  const [incr, , pttl] = results ?? [];
  if (incr === undefined || pttl === undefined || incr[0] !== null || pttl[0] !== null) {
    throw cacheUnavailable(incr?.[0] ?? pttl?.[0] ?? new Error('empty MULTI result'));
  }
  const ttlMs = Number(pttl[1]);
  return { count: Number(incr[1]), ttlMs: ttlMs > 0 ? ttlMs : windowSeconds * 1000 };
}

/**
 * Per-key request limits (SPEC §13.1: 429 + `Retry-After`). Used for the
 * unauthenticated endpoints: login, setup, forgot/reset password.
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(CACHE_CLIENT) private readonly cache: Redis) {}

  /**
   * Counts one request for `key`; throws `429 RATE_LIMITED` with
   * `Retry-After` once more than `rule.limit` arrived in the window.
   * `key` must not contain secrets or raw emails (hash them).
   */
  async hit(key: string, rule: RateLimitRule): Promise<void> {
    const { count, ttlMs } = await incrementWindow(
      this.cache,
      `${CACHE_KEY_PREFIX}rl:${key}`,
      rule.windowSeconds,
    );
    if (count > rule.limit) {
      throw new AppError('RATE_LIMITED', {
        detail: 'Too many requests; try again later.',
        retryAfterSeconds: ttlMs / 1000,
      });
    }
  }

  /**
   * Throws `429 RATE_LIMITED` with `Retry-After` when `key` already used up
   * `rule.limit` in the current window, without counting this request: for
   * limits on failures, checked before the work that can fail (`hit` counts
   * each failure afterwards).
   */
  async ensureAvailable(key: string, rule: RateLimitRule): Promise<void> {
    const fullKey = `${CACHE_KEY_PREFIX}rl:${key}`;
    const results = await cacheCommand(this.cache, (client) =>
      client.multi().get(fullKey).pttl(fullKey).exec(),
    );
    const [count, pttl] = results ?? [];
    if (count === undefined || pttl === undefined || count[0] !== null || pttl[0] !== null) {
      throw cacheUnavailable(count?.[0] ?? pttl?.[0] ?? new Error('empty MULTI result'));
    }
    if (Number(count[1] ?? 0) >= rule.limit) {
      const ttlMs = Number(pttl[1]);
      throw new AppError('RATE_LIMITED', {
        detail: 'Too many requests; try again later.',
        retryAfterSeconds: (ttlMs > 0 ? ttlMs : rule.windowSeconds * 1000) / 1000,
      });
    }
  }
}
