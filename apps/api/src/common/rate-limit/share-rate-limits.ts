import {
  SHARE_FILE_RATE_LIMIT,
  SHARE_FILE_RATE_WINDOW_SECONDS,
  SHARE_FORM_UPLOAD_RATE_LIMIT,
  SHARE_FORM_UPLOAD_RATE_WINDOW_SECONDS,
  SHARE_READ_RATE_LIMIT_PER_SECOND,
  SHARE_WIDGET_RATE_LIMIT,
  SHARE_WIDGET_RATE_WINDOW_SECONDS,
} from '@cellhive/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { RateLimiter, type RateLimitRule } from './rate-limiter.js';

/** BACKLOG S3 decision 5, SPEC §15A.3: 20 read requests/s per IP on `/shares/*`. */
export const DEFAULT_SHARE_READ_RATE_LIMIT: RateLimitRule = {
  limit: SHARE_READ_RATE_LIMIT_PER_SECOND,
  windowSeconds: 1,
};

/** T409: file downloads and thumbnails per IP, apart from reads (a page loads many thumbnails). */
export const DEFAULT_SHARE_FILE_RATE_LIMIT: RateLimitRule = {
  limit: SHARE_FILE_RATE_LIMIT,
  windowSeconds: SHARE_FILE_RATE_WINDOW_SECONDS,
};

/** T809: widget data, control values and CSV of dashboard links per IP, apart from reads. */
export const DEFAULT_SHARE_WIDGET_RATE_LIMIT: RateLimitRule = {
  limit: SHARE_WIDGET_RATE_LIMIT,
  windowSeconds: SHARE_WIDGET_RATE_WINDOW_SECONDS,
};

/** T410: uploads of form links per IP (BACKLOG S4 open question #14: 20 per 10 minutes). */
export const DEFAULT_SHARE_UPLOAD_RATE_LIMIT: RateLimitRule = {
  limit: SHARE_FORM_UPLOAD_RATE_LIMIT,
  windowSeconds: SHARE_FORM_UPLOAD_RATE_WINDOW_SECONDS,
};

/**
 * Per-IP limits of the public share endpoints (SPEC §13.1, §15A.3). The IP
 * is the client address Fastify derives through `TRUSTED_PROXIES`
 * (`X-Forwarded-For` only from a trusted proxy). Exceeding a limit is
 * `429 RATE_LIMITED` with `Retry-After`; a Valkey outage fails closed
 * (`503`). The rule is a plain field so tests and embedders can tune it.
 */
@Injectable()
export class ShareRateLimits {
  read: RateLimitRule = DEFAULT_SHARE_READ_RATE_LIMIT;
  file: RateLimitRule = DEFAULT_SHARE_FILE_RATE_LIMIT;
  upload: RateLimitRule = DEFAULT_SHARE_UPLOAD_RATE_LIMIT;
  widget: RateLimitRule = DEFAULT_SHARE_WIDGET_RATE_LIMIT;

  constructor(@Inject(RateLimiter) private readonly limiter: RateLimiter) {}

  /** Counts a read request (`meta`, `records/*`, `unlock`) of `ip`. */
  hitRead(ip: string | null): Promise<void> {
    const rule = this.read;
    return this.limiter.hit(`share:${String(rule.windowSeconds)}:${ip ?? 'unknown'}`, rule);
  }

  /** Counts a file request (`files/:id`, `files/:id/thumbnail`, T409) of `ip`. */
  hitFile(ip: string | null): Promise<void> {
    const rule = this.file;
    return this.limiter.hit(`share-file:${String(rule.windowSeconds)}:${ip ?? 'unknown'}`, rule);
  }

  /** Counts a widget request of a dashboard link (`widgets/:id/data|options|export`, T809). */
  hitWidget(ip: string | null): Promise<void> {
    const rule = this.widget;
    return this.limiter.hit(`share-widget:${String(rule.windowSeconds)}:${ip ?? 'unknown'}`, rule);
  }

  /** Counts a new upload through a form link (`POST /shares/:token/uploads`, T410) of `ip`. */
  hitUpload(ip: string | null): Promise<void> {
    const rule = this.upload;
    return this.limiter.hit(`share-upload:${String(rule.windowSeconds)}:${ip ?? 'unknown'}`, rule);
  }
}
