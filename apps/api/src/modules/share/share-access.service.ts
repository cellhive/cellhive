import { SHARE_CSRF_HEADER, UNLOCK_REQUIRED } from '@cellhive/contracts';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService } from '../../common/access/access.service.js';
import { parseCookies } from '../../common/auth/cookies.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { CSRF_SAFE_METHODS } from '../../common/auth/session.service.js';
import { ShareRateLimits } from '../../common/rate-limit/share-rate-limits.js';
import {
  isDashboardLink,
  ShareLinkResolver,
  type AnyResolvedShareLink,
  type ResolvedDashboardShareLink,
  type ResolvedShareLink,
} from '../share-link/share-link-resolver.service.js';

import { ShareUnlockCookies } from './share-unlock-cookies.js';

import type { FastifyRequest } from 'fastify';

/** A link opened by a request that passed every access check of CONTRACTS §16A. */
export interface OpenedShare<L extends AnyResolvedShareLink = ResolvedShareLink> {
  readonly link: L;
  /**
   * `false` only with `allowLocked` (unlock, meta of T306 forms…): the link
   * has a password and the request carries no valid unlock cookie.
   */
  readonly unlocked: boolean;
  /** CSRF token of the unlock cookie of the request; `null` without password or cookie. */
  readonly csrfToken: string | null;
}

export interface OpenShareOptions {
  /** Return a locked link instead of `403 SHARE_PASSWORD_REQUIRED` (the unlock endpoint). */
  readonly allowLocked?: boolean;
  /** Count the request against the per-IP read limit (default `true`; T306 has its own limit). */
  readonly rateLimit?: boolean;
}

function noSuchLink(): AppError {
  return new AppError('NOT_FOUND', { detail: 'The link does not exist.' });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Checks a request to `/shares/:token/*` (CONTRACTS §16A), in this order:
 *
 * 1. per-IP rate limit (`429` + `Retry-After`);
 * 2. the token (`ShareLinkResolver`: unknown → `404`; revoked, off, expired,
 *    blocked, target deleted, creator without access → `410`);
 * 3. audience `org`: a session of a member of the link's organization —
 *    no session → `401 UNAUTHENTICATED`, a session of anyone else → `404`;
 * 4. password: a valid unlock cookie of this link, else `403
 *    SHARE_PASSWORD_REQUIRED`; a non-GET request carrying a valid cookie
 *    must send its CSRF token in `X-Share-CSRF-Token` (`403 CSRF_INVALID`).
 *
 * Shared with the form submission of T306.
 */
@Injectable()
export class ShareAccessService {
  constructor(
    @Inject(ShareLinkResolver) private readonly resolver: ShareLinkResolver,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ShareRateLimits) private readonly limits: ShareRateLimits,
    @Inject(ShareUnlockCookies) private readonly cookies: ShareUnlockCookies,
  ) {}

  /** A view or form link (a dashboard link is `404` after the checks: no such route for it). */
  async open(
    token: string,
    request: FastifyRequest,
    options: OpenShareOptions = {},
  ): Promise<OpenedShare> {
    const opened = await this.openAny(token, request, options);
    if (isDashboardLink(opened.link)) throw noSuchLink();
    return opened as OpenedShare;
  }

  /** A dashboard link (T809); a view or form link is `404` after the checks. */
  async openDashboard(
    token: string,
    request: FastifyRequest,
    options: OpenShareOptions = {},
  ): Promise<OpenedShare<ResolvedDashboardShareLink>> {
    const opened = await this.openAny(token, request, options);
    if (!isDashboardLink(opened.link)) throw noSuchLink();
    return opened as OpenedShare<ResolvedDashboardShareLink>;
  }

  /** A link of any target (`unlock`, `meta`). */
  async openAny(
    token: string,
    request: FastifyRequest,
    options: OpenShareOptions = {},
  ): Promise<OpenedShare<AnyResolvedShareLink>> {
    if (options.rateLimit !== false) await this.limits.hitRead(requestMetaOf(request).ip);
    const link = await this.resolver.resolveAny(token);

    if (link.link.audience === 'org') {
      const principal = request.principal;
      if (principal === undefined) {
        throw new AppError('UNAUTHENTICATED', { detail: 'Sign in to open this link.' });
      }
      const member = await this.access.findOrg(principal, link.scope.organizationId);
      if (member === undefined) throw noSuchLink();
    }

    return this.checkUnlock(link, request, options);
  }

  /**
   * Step 4 alone (password, unlock cookie, its CSRF token), for routes that
   * resolve the link themselves (T306 form submission). Throws `403
   * SHARE_PASSWORD_REQUIRED` (detail `UNLOCK_REQUIRED`) unless
   * `allowLocked`.
   */
  checkUnlock<L extends AnyResolvedShareLink>(
    link: L,
    request: FastifyRequest,
    options: Pick<OpenShareOptions, 'allowLocked'> = {},
  ): OpenedShare<L> {
    if (link.link.password_hash === null) return { link, unlocked: true, csrfToken: null };
    const value = parseCookies(request.headers.cookie).get(this.cookies.nameOf(link.link.id));
    if (value === undefined || !this.cookies.verify(link.link, value)) {
      if (options.allowLocked === true) return { link, unlocked: false, csrfToken: null };
      throw new AppError('SHARE_PASSWORD_REQUIRED', {
        detail: 'This link needs its password: unlock it first.',
        errors: [{ path: '', code: UNLOCK_REQUIRED, message: 'The link needs its password' }],
      });
    }
    if (
      options.allowLocked !== true &&
      !CSRF_SAFE_METHODS.has(request.method) &&
      !this.cookies.csrfValid(value, headerValue(request.headers[SHARE_CSRF_HEADER]))
    ) {
      throw new AppError('CSRF_INVALID', {
        detail: `Missing or invalid ${SHARE_CSRF_HEADER} header.`,
      });
    }
    return { link, unlocked: true, csrfToken: this.cookies.csrfTokenOf(value) };
  }
}
