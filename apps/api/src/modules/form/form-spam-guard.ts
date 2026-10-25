import { createHash } from 'node:crypto';

import {
  DEFAULT_FORM_MIN_FILL_SECONDS,
  FORM_SUBMISSIONS_PER_MINUTE,
  FORM_SUBMIT_TOKEN_TTL_SECONDS,
  SUBMIT_TOKEN_INVALID,
  SUBMITTED_TOO_FAST,
  type FormSubmitTokenDto,
  type Id,
} from '@cellhive/contracts';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { deriveKey } from '../../common/auth/secrets.js';
import {
  CACHE_KEY_PREFIX,
  cacheCommand,
  RateLimiter,
  type RateLimitRule,
} from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG, CACHE_CLIENT } from '../../common/tokens.js';

import { checkSubmitToken, issueSubmitToken } from './submit-token.js';

import type { AppConfig } from '@cellhive/server-core';
import type { Redis } from 'ioredis';

/** A claimed submit token: released when the submission fails, so it can be sent again. */
export interface ClaimedSubmitToken {
  readonly key: string;
  /** The upload session of the token (T410): files uploaded with it. */
  readonly session: string;
}

/**
 * The upload session of a submit token (T410): SHA-256 (hex) of the link id
 * and the token's nonce, stored with each file uploaded with the token.
 */
export function uploadSessionOf(linkId: Id<'shl'>, nonce: string): string {
  return createHash('sha256').update(`${linkId}.${nonce}`, 'utf8').digest('hex');
}

function tokenProblem(code: string, message: string, params?: Record<string, unknown>): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: 'The form could not be accepted; reload it and try again.',
    errors: [{ path: 'submit_token', code, message, ...(params === undefined ? {} : { params }) }],
  });
}

function nonceKey(nonce: string): string {
  return `${CACHE_KEY_PREFIX}form:nonce:${nonce}`;
}

/**
 * Anti-spam of form submissions without any outside service (SPEC §8,
 * CONTRACTS §17, ADR-0030):
 *
 * - rate limit: 10 submissions/minute per client IP through a link (IP as
 *   resolved by Fastify behind `TRUSTED_PROXIES`), per user on the member
 *   route (people behind one office NAT share an IP);
 * - submit token: signed, bound to the link, at least the minimum fill time
 *   old, at most 24 h, single use (nonce claimed in Valkey);
 * - honeypot: handled by the caller.
 *
 * The limits are plain fields so that tests (and embedding deployments) can
 * tune them. A Valkey outage fails closed (`503`).
 */
@Injectable()
export class FormSpamGuard {
  perMinute: RateLimitRule = { limit: FORM_SUBMISSIONS_PER_MINUTE, windowSeconds: 60 };
  minFillMs = DEFAULT_FORM_MIN_FILL_SECONDS * 1000;
  tokenTtlMs = FORM_SUBMIT_TOKEN_TTL_SECONDS * 1000;
  now: () => Date = () => new Date();

  private readonly key: Buffer;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(CACHE_CLIENT) private readonly cache: Redis,
  ) {
    this.key = deriveKey(config.security.sessionSecret, 'form-submit-token');
  }

  /** Counts a submission through a link from `ip` (`429` past the limit). */
  hitIp(ip: string | null): Promise<void> {
    return this.limiter.hit(`form:ip:${ip ?? 'unknown'}`, this.perMinute);
  }

  /** Counts a submission of a member (`429` past the limit). */
  hitUser(userId: Id<'usr'>): Promise<void> {
    return this.limiter.hit(`form:usr:${userId}`, this.perMinute);
  }

  /** A new submit token for the link. */
  issue(linkId: Id<'shl'>): FormSubmitTokenDto {
    const { token, issuedAt } = issueSubmitToken(this.key, linkId, this.now());
    return {
      submit_token: token,
      not_before: new Date(issuedAt.getTime() + this.minFillMs).toISOString(),
      expires_at: new Date(issuedAt.getTime() + this.tokenTtlMs).toISOString(),
    };
  }

  /**
   * Checks `token` for the link and claims its nonce: `422
   * VALIDATION_FAILED` with `SUBMIT_TOKEN_INVALID` (missing, forged, for
   * another link, expired or already used) or `SUBMITTED_TOO_FAST`
   * (`params.retry_after_ms`).
   */
  async claim(linkId: Id<'shl'>, token: string | undefined): Promise<ClaimedSubmitToken> {
    const check = checkSubmitToken(this.key, linkId, token, this.now(), {
      minAgeMs: this.minFillMs,
      maxAgeMs: this.tokenTtlMs,
    });
    if (!check.ok) {
      if (check.reason === 'too_fast') {
        throw tokenProblem(SUBMITTED_TOO_FAST, 'The form was sent too quickly', {
          retry_after_ms: check.retryAfterMs,
        });
      }
      throw tokenProblem(SUBMIT_TOKEN_INVALID, 'The submit token is not valid');
    }
    const key = nonceKey(check.nonce);
    const claimed = await cacheCommand(this.cache, (client) =>
      client.set(key, '1', 'PX', this.tokenTtlMs, 'NX'),
    );
    if (claimed !== 'OK') throw tokenProblem(SUBMIT_TOKEN_INVALID, 'The submit token was used');
    return { key, session: uploadSessionOf(linkId, check.nonce) };
  }

  /**
   * The upload session of a submit token not used yet (T410, uploads while
   * the form is filled in): signed for the link and not expired — the
   * minimum fill time does not apply —, else `422 VALIDATION_FAILED` /
   * `SUBMIT_TOKEN_INVALID`. Nothing is claimed.
   */
  async uploadSession(linkId: Id<'shl'>, token: string | undefined): Promise<string> {
    const check = checkSubmitToken(this.key, linkId, token, this.now(), {
      minAgeMs: 0,
      maxAgeMs: this.tokenTtlMs,
    });
    if (!check.ok) throw tokenProblem(SUBMIT_TOKEN_INVALID, 'The submit token is not valid');
    const used = await cacheCommand(this.cache, (client) => client.exists(nonceKey(check.nonce)));
    if (used > 0) throw tokenProblem(SUBMIT_TOKEN_INVALID, 'The submit token was used');
    return uploadSessionOf(linkId, check.nonce);
  }

  /** Makes a claimed token usable again (the submission failed). Best effort. */
  async release(claimed: ClaimedSubmitToken): Promise<void> {
    try {
      await cacheCommand(this.cache, (client) => client.del(claimed.key));
    } catch {
      // The token stays used; the person fetches a new one.
    }
  }
}
