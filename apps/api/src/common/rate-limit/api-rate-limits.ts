import { API_TOKEN_BEARER_FAILURES_PER_IP, type Id } from '@cellhive/contracts';
import { hashApiToken, parseApiToken } from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { CACHE_CLIENT } from '../tokens.js';

import { CACHE_KEY_PREFIX, cacheCommand, RateLimiter, type RateLimitRule } from './rate-limiter.js';

import type { Redis } from 'ioredis';

/** SPEC §13.1: 60 requests/s per API token, and per signed-in user for sessions. */
export const DEFAULT_PRINCIPAL_RATE_LIMIT: RateLimitRule = { limit: 60, windowSeconds: 1 };
/** SPEC §13.1: 20 requests/s per base and token (per base and user for sessions). */
export const DEFAULT_BASE_RATE_LIMIT: RateLimitRule = { limit: 20, windowSeconds: 1 };

/**
 * How long a token that authenticated stays "recently valid" (QA S6): an
 * IP over its failed-Bearer limit still lets such a token through.
 */
export const BEARER_RECENTLY_VALID_MS = 10 * 60_000;
/** Re-marked at most this often per token and API process (one Valkey write). */
const BEARER_REMARK_MS = 5 * 60_000;
const BEARER_MARKS_MAX = 10_000;

/**
 * Request limits of every authenticated route (SPEC §13.1), counted in
 * Valkey with fixed windows: per principal, and per principal and base.
 * Exceeding one is `429 RATE_LIMITED` with `Retry-After`. A Valkey outage
 * fails closed (`503`), like the other limits.
 *
 * The rules are plain fields so that deployments embedding the API (and
 * tests) can tune them; SPEC §20 keeps the environment variable list closed.
 * Counter keys include the window length, so a changed rule starts fresh.
 */
@Injectable()
export class ApiRateLimits {
  perPrincipal: RateLimitRule = DEFAULT_PRINCIPAL_RATE_LIMIT;
  perBase: RateLimitRule = DEFAULT_BASE_RATE_LIMIT;
  /** Failed Bearer authentications per client IP (CONTRACTS §26.1). */
  bearerFailures: RateLimitRule = API_TOKEN_BEARER_FAILURES_PER_IP;

  /** Token hash (hex) → when this process last marked it recently valid. */
  readonly #marked = new Map<string, number>();

  constructor(
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(CACHE_CLIENT) private readonly cache: Redis,
  ) {}

  /** Counts a request of `principalKey` (`usr_…` for sessions, `tok_…` for API tokens). */
  hitPrincipal(principalKey: string): Promise<void> {
    const rule = this.perPrincipal;
    return this.limiter.hit(`api:${String(rule.windowSeconds)}:${principalKey}`, rule);
  }

  /**
   * `429` when `ip` already used up its failed Bearer authentications,
   * without counting — before any database lookup. A token that
   * authenticated in the last {@link BEARER_RECENTLY_VALID_MS} (from any IP)
   * still goes through: someone failing from a shared IP (NAT, CI, a proxy
   * without `TRUSTED_PROXIES`) cannot lock the working integrations of that
   * IP out (QA S6). A guess never is recently valid, so guessing stays
   * limited and costs no lookup.
   */
  async ensureBearerAttemptAllowed(ip: string, token?: string): Promise<void> {
    try {
      await this.limiter.ensureAvailable(this.bearerFailureKey(ip), this.bearerFailures);
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.code !== 'RATE_LIMITED' ||
        token === undefined ||
        parseApiToken(token) !== 'ok'
      ) {
        throw error;
      }
      const key = this.recentlyValidKey(token);
      const known = await cacheCommand(this.cache, (client) => client.exists(key));
      if (known !== 1) throw error;
    }
  }

  /** Marks `token` (just authenticated) recently valid; at most every 5 min per process. */
  async rememberValidBearer(token: string): Promise<void> {
    const key = this.recentlyValidKey(token);
    const now = Date.now();
    const last = this.#marked.get(key);
    if (last !== undefined && now - last < BEARER_REMARK_MS) return;
    if (this.#marked.size >= BEARER_MARKS_MAX) this.#marked.clear();
    this.#marked.set(key, now);
    try {
      await cacheCommand(this.cache, (client) =>
        client.set(key, '1', 'PX', BEARER_RECENTLY_VALID_MS),
      );
    } catch {
      // Bookkeeping only: the request goes on; the next one marks it again.
      this.#marked.delete(key);
    }
  }

  /** A hash of the token (never the token): only a valid token can put it there. */
  private recentlyValidKey(token: string): string {
    return `${CACHE_KEY_PREFIX}bearer_ok:${hashApiToken(token).toString('hex')}`;
  }

  /** Counts one failed Bearer authentication of `ip`. */
  hitBearerFailure(ip: string): Promise<void> {
    return this.limiter.hit(this.bearerFailureKey(ip), this.bearerFailures);
  }

  private bearerFailureKey(ip: string): string {
    return `bearer_fail:${String(this.bearerFailures.windowSeconds)}:ip:${ip}`;
  }

  /** Counts a request of `principalKey` on `baseId`. */
  hitBase(principalKey: string, baseId: Id<'bse'>): Promise<void> {
    const rule = this.perBase;
    return this.limiter.hit(`api:${String(rule.windowSeconds)}:${principalKey}:${baseId}`, rule);
  }
}
