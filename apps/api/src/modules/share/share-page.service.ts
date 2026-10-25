import {
  embedOriginOf,
  SHARE_EMBED_PAGE_PATH,
  webContentSecurityPolicy,
} from '@cellhive/contracts';
import { type AppConfig } from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { requestMetaOf } from '../../common/auth/request-meta.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { ShareRateLimits } from '../../common/rate-limit/share-rate-limits.js';
import { APP_CONFIG } from '../../common/tokens.js';
import { ShareLinkResolver } from '../share-link/share-link-resolver.service.js';

import type { FastifyRequest } from 'fastify';

/** Headers of `/s/{token}?embed=1`, sent to nginx with `X-Accel-Redirect`. */
export interface SharePageHeaders {
  readonly 'content-security-policy': string;
  /** `DENY` unless the link may be framed (no header then: `frame-ancestors` decides). */
  readonly 'x-frame-options'?: string;
  readonly 'x-accel-redirect': string;
}

function storageOriginOf(config: AppConfig): string {
  if (config.storage.driver !== 's3' || config.storage.publicEndpoint === null) return '';
  try {
    return new URL(config.storage.publicEndpoint).origin;
  } catch {
    return '';
  }
}

/**
 * The headers of an embedded share page (BACKLOG T809, S7 decisions 14–16):
 * `frame-ancestors` lists the link's allowed origins when the link works
 * now, is `public`, has no password and has embedding on; anything else —
 * unknown, revoked, expired link, the creator without access, a rate limit,
 * an error — is `frame-ancestors 'none'` + `X-Frame-Options: DENY`. The
 * page itself then reads the link through `/shares/:token/*`, which applies
 * every check; this answer carries no data of the link.
 */
@Injectable()
export class SharePageService {
  private readonly storageOrigin: string;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ShareLinkResolver) private readonly resolver: ShareLinkResolver,
    @Inject(ShareRateLimits) private readonly limits: ShareRateLimits,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.storageOrigin = storageOriginOf(config);
  }

  async headers(token: string, request: FastifyRequest): Promise<SharePageHeaders> {
    const origins = await this.frameAncestors(token, request);
    const csp = webContentSecurityPolicy(this.storageOrigin, origins);
    return origins.length === 0
      ? {
          'content-security-policy': csp,
          'x-frame-options': 'DENY',
          'x-accel-redirect': SHARE_EMBED_PAGE_PATH,
        }
      : { 'content-security-policy': csp, 'x-accel-redirect': SHARE_EMBED_PAGE_PATH };
  }

  private async frameAncestors(token: string, request: FastifyRequest): Promise<string[]> {
    try {
      await this.limits.hitRead(requestMetaOf(request).ip);
      const resolved = await this.resolver.resolveAny(token);
      const { link, settings } = resolved;
      if (!settings.embed.enabled || link.audience !== 'public' || link.password_hash !== null) {
        return [];
      }
      // Stored origins were checked on write; check again so that nothing
      // but an origin ever reaches the header.
      const allowLocalHttp = this.config.nodeEnv !== 'production';
      const origins = settings.embed.allowed_origins
        .map((value) => embedOriginOf(value, { allowLocalHttp }))
        .filter((origin): origin is string => origin !== null);
      return [...new Set(origins)];
    } catch (err) {
      // 404/410/429…: the page is shown unframed and reads the error itself.
      this.logger.debug({ err }, 'share page not embeddable');
      return [];
    }
  }
}
