import {
  INCOMING_WEBHOOK_BASE_RATE_PER_SEC,
  INCOMING_WEBHOOK_BURST_FACTOR,
  INCOMING_WEBHOOK_IP_RATE_PER_SEC,
  type Id,
} from '@cellhive/contracts';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { cacheReady } from '../infra/connections.js';
import { CACHE_CLIENT } from '../tokens.js';

import { CACHE_KEY_PREFIX, RateLimiter, type RateLimitRule } from './rate-limiter.js';

import type { Redis } from 'ioredis';

/** SPEC §13.1: 20 requests/s per client IP on `POST /hooks/:token`. */
export const DEFAULT_HOOK_IP_RATE_LIMIT: RateLimitRule = {
  limit: INCOMING_WEBHOOK_IP_RATE_PER_SEC,
  windowSeconds: 1,
};

/** A token bucket: `ratePerSec` tokens per second, at most `burst`. */
export interface TokenBucketRule {
  readonly ratePerSec: number;
  readonly burst: number;
}

/** ADR-35 §1: every hook of a base together, 50 requests/s (bursts of one second). */
export const DEFAULT_HOOK_BASE_BUCKET: TokenBucketRule = {
  ratePerSec: INCOMING_WEBHOOK_BASE_RATE_PER_SEC,
  burst: INCOMING_WEBHOOK_BASE_RATE_PER_SEC,
};

/** `Retry-After` when Valkey cannot be reached (BACKLOG "Quyết định S5c" #17). */
const UNAVAILABLE_RETRY_AFTER_S = 1;

/**
 * Two token buckets taken together, atomically: one token from the hook's
 * bucket **and** one from the base's, or none (a request refused by one
 * does not use the other). KEYS: hook bucket, base bucket. ARGV: hook
 * rate/s, hook burst, base rate/s, base burst. Returns `{1, 0}` or
 * `{0, ms until a token is back in the bucket that refused}`. Times are
 * Valkey's (`TIME`) so every API instance agrees. Constant script: no
 * value is ever concatenated into it.
 */
const TAKE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local function level(key, rate, burst)
  local state = redis.call('HMGET', key, 'tokens', 'at')
  local tokens = tonumber(state[1]) or burst
  local at = tonumber(state[2]) or now
  if now > at then tokens = math.min(burst, tokens + (now - at) * rate / 1000) end
  return tokens
end
local hookRate, hookBurst = tonumber(ARGV[1]), tonumber(ARGV[2])
local baseRate, baseBurst = tonumber(ARGV[3]), tonumber(ARGV[4])
local hookTokens = level(KEYS[1], hookRate, hookBurst)
local baseTokens = level(KEYS[2], baseRate, baseBurst)
local wait = 0
if hookTokens < 1 then wait = math.ceil((1 - hookTokens) * 1000 / hookRate) end
if baseTokens < 1 then wait = math.max(wait, math.ceil((1 - baseTokens) * 1000 / baseRate)) end
if wait > 0 then return {0, wait} end
redis.call('HSET', KEYS[1], 'tokens', tostring(hookTokens - 1), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(hookBurst * 1000 / hookRate) + 1000)
redis.call('HSET', KEYS[2], 'tokens', tostring(baseTokens - 1), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[2], math.ceil(baseBurst * 1000 / baseRate) + 1000)
return {1, 0}
`;

function unavailable(cause: unknown): AppError {
  return new AppError('DEPENDENCY_UNAVAILABLE', {
    detail: 'A required service is temporarily unavailable.',
    retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_S,
    cause,
  });
}

/**
 * Limits of the public incoming webhook route (BACKLOG T603, ADR-35 §1):
 *
 * - `hitIp`: 20 requests/s per client IP (the address Fastify derives
 *   through `TRUSTED_PROXIES`), before the token is even looked at;
 * - `takeHook`: the hook's bucket — `min(rate_limit_per_sec,
 *   WEBHOOK_MAX_RATE_PER_SEC)` per second, bursts of 4× — and the base's
 *   50 requests/s, taken atomically in one Lua script.
 *
 * Over a limit → `429 RATE_LIMITED` with `Retry-After`. Valkey unreachable
 * → `503 DEPENDENCY_UNAVAILABLE` with `Retry-After: 1` (fail closed: a
 * webhook sender retries; BACKLOG "Quyết định S5c" #17). Keys carry ids,
 * never the URL token. The rules are plain fields so tests can tune them.
 */
@Injectable()
export class IncomingWebhookRateLimits {
  ip: RateLimitRule = DEFAULT_HOOK_IP_RATE_LIMIT;
  base: TokenBucketRule = DEFAULT_HOOK_BASE_BUCKET;

  constructor(
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(CACHE_CLIENT) private readonly cache: Redis,
  ) {}

  /** Counts a request of `ip` on the public route. */
  async hitIp(ip: string | null): Promise<void> {
    const rule = this.ip;
    try {
      await this.limiter.hit(`hook-ip:${String(rule.windowSeconds)}:${ip ?? 'unknown'}`, rule);
    } catch (error) {
      if (error instanceof AppError && error.code === 'DEPENDENCY_UNAVAILABLE') {
        throw unavailable(error);
      }
      throw error;
    }
  }

  /**
   * Takes one token of hook `hookId` (`ratePerSec` = its effective rate)
   * and one of base `baseId`.
   */
  async takeHook(baseId: Id<'bse'>, hookId: Id<'hok'>, ratePerSec: number): Promise<void> {
    const rate = Math.max(1, Math.floor(ratePerSec));
    const base = this.base;
    let result: unknown;
    try {
      await cacheReady(this.cache);
      result = await this.cache.eval(
        TAKE_SCRIPT,
        2,
        `${CACHE_KEY_PREFIX}hook:bucket:${hookId}`,
        `${CACHE_KEY_PREFIX}hook:base:${baseId}`,
        rate,
        rate * INCOMING_WEBHOOK_BURST_FACTOR,
        base.ratePerSec,
        base.burst,
      );
    } catch (error) {
      throw unavailable(error);
    }
    const [ok, waitMs] = Array.isArray(result) ? result.map(Number) : [Number.NaN, 0];
    if (ok === 1) return;
    if (ok !== 0) throw unavailable(new Error('unexpected rate limit script result'));
    throw new AppError('RATE_LIMITED', {
      detail: 'Too many requests; try again later.',
      retryAfterSeconds: Math.max(1, (waitMs ?? 1000) / 1000),
    });
  }
}
