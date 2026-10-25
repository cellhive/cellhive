import { orgScope, ShareLinksRepository } from '@cellhive/server-core';
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import { AppLogger } from '../../common/logging/app-logger.js';

import type { Id } from '@cellhive/contracts';

/** How often pending accesses are written. */
export const SHARE_STATS_FLUSH_INTERVAL_MS = 10_000;
/** Links with pending accesses that trigger an early write. */
export const SHARE_STATS_MAX_PENDING_LINKS = 1_000;

interface Pending {
  readonly organizationId: Id<'org'>;
  /** Page opens (`GET meta`). */
  count: number;
  /** Latest successful request of any kind. */
  at: Date;
}

/**
 * Access statistics of share links (SPEC §15A.4, CONTRACTS §16A), batched
 * in memory instead of one database write per request: `access_count` and
 * the daily count grow by one per page open (`GET /shares/:token/meta`);
 * `last_accessed_at` follows every successful share request. Each API
 * process writes its batch every 10 s (or once 1 000 links are pending) and
 * on shutdown; a crash loses at most that interval of statistics, never
 * data. No IP is recorded.
 */
@Injectable()
export class ShareAccessStats implements OnModuleInit, OnApplicationShutdown {
  private pending = new Map<Id<'shl'>, Pending>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    @Inject(ShareLinksRepository) private readonly links: ShareLinksRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, SHARE_STATS_FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  /** Notes a successful request; `visit` for a page open. */
  record(
    organizationId: Id<'org'>,
    linkId: Id<'shl'>,
    visit: boolean,
    at: Date = new Date(),
  ): void {
    const entry = this.pending.get(linkId);
    if (entry === undefined) {
      this.pending.set(linkId, { organizationId, count: visit ? 1 : 0, at });
    } else {
      if (visit) entry.count += 1;
      if (at > entry.at) entry.at = at;
    }
    if (this.pending.size >= SHARE_STATS_MAX_PENDING_LINKS) void this.flush();
  }

  /** Links with accesses not written yet (tests). */
  get pendingLinks(): number {
    return this.pending.size;
  }

  /** Writes every pending access; flushes never overlap. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.write());
    return this.flushing;
  }

  private async write(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    for (const [linkId, entry] of batch) {
      try {
        await this.links.recordAccess(orgScope(entry.organizationId), linkId, {
          count: entry.count,
          at: entry.at,
        });
      } catch (err) {
        // Statistics are best effort: a failed write is logged, not retried.
        this.logger.warn({ err, share_link_id: linkId }, 'share link access stats not written');
      }
    }
  }
}
