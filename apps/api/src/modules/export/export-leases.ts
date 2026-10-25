import { randomUUID } from 'node:crypto';

import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { CACHE_KEY_PREFIX, cacheCommand } from '../../common/rate-limit/rate-limiter.js';
import { CACHE_CLIENT } from '../../common/tokens.js';

import type { Id } from '@cellhive/contracts';
import type { Redis } from 'ioredis';

/** Lifetime of a lease without refresh: a crashed instance frees the user after this. */
export const EXPORT_LEASE_TTL_MS = 60_000;
/** How often a running export extends its lease. */
const EXPORT_LEASE_REFRESH_MS = 20_000;

/**
 * Who holds an "export running" slot: a user (`GET /tables/:id/export`), or
 * a share link and a client IP (`GET /shares/:token/export`, T810).
 */
export type ExportSlot = Id<'usr'> | Id<'shl'> | `ip:${string}`;

/** A held "export running" slot; `release` is idempotent and never throws. */
export interface ExportLease {
  release(): Promise<void>;
}

/**
 * At most one running table export per user across API instances
 * (CONTRACTS §18, BACKLOG S3 decision 2) — and per share link and per IP
 * for exports through links (T810): a Valkey key per slot holding a
 * random token, set with `NX` and a TTL that a running export keeps
 * extending. A second export meanwhile is `429 RATE_LIMITED` with
 * `Retry-After` = what is left of the lease. Valkey unreachable → `503`
 * (fails closed like the rate limits).
 */
@Injectable()
export class ExportLeases {
  constructor(@Inject(CACHE_CLIENT) private readonly cache: Redis) {}

  async acquire(
    slot: ExportSlot,
    detail = 'Another export of yours is still running; try again when it has finished.',
  ): Promise<ExportLease> {
    const key = `${CACHE_KEY_PREFIX}export:running:${slot}`;
    const token = randomUUID();
    const set = await cacheCommand(this.cache, (client) =>
      client.set(key, token, 'PX', EXPORT_LEASE_TTL_MS, 'NX'),
    );
    if (set !== 'OK') {
      const left = await cacheCommand(this.cache, (client) => client.pttl(key));
      throw new AppError('RATE_LIMITED', {
        detail,
        retryAfterSeconds: Math.max(1, Math.ceil((left > 0 ? left : EXPORT_LEASE_TTL_MS) / 1000)),
      });
    }
    const ours = async () => (await this.cache.get(key)) === token;
    const timer = setInterval(() => {
      void (async () => {
        if (await ours()) await this.cache.pexpire(key, EXPORT_LEASE_TTL_MS);
      })().catch(() => undefined);
    }, EXPORT_LEASE_REFRESH_MS);
    timer.unref();
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        try {
          if (await ours()) await this.cache.del(key);
        } catch {
          // The key expires on its own.
        }
      },
    };
  }
}
