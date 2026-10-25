import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, type Id } from '@cellhive/contracts';
import {
  OrganizationsRepository,
  publishSessionsRevoked,
  SessionsRepository,
  type AppConfig,
  type Db,
  type Session,
  type Tx,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, DB } from '../tokens.js';

import { parseCookies, serializeCookie } from './cookies.js';
import {
  checkCsrf,
  createCsrfToken,
  deriveKey,
  generateToken,
  hashToken,
  isWellFormedToken,
  verifyCsrfToken,
} from './secrets.js';

import type { SessionPrincipal } from './principal.js';
import type { RequestMeta } from './request-meta.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Sessions expire after 30 days **without activity** (sliding): each
 * request more than `SESSION_TOUCH_INTERVAL_MS` after the last recorded
 * activity moves `expires_at` to now + 30 days and re-sends the cookie.
 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Throttle for `last_seen_at`/`expires_at` writes: at most one per session per interval. */
export const SESSION_TOUCH_INTERVAL_MS = 10 * 60 * 1000;

/** Methods that never change state: no CSRF token required. */
export const CSRF_SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ResolvedSession {
  readonly principal: SessionPrincipal;
  /** The expiry moved: the cookie must be sent again. */
  readonly refreshed: boolean;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Cookie sessions (SPEC §14.2): 32-byte random token in an HttpOnly cookie,
 * only its SHA-256 stored; signed double-submit CSRF token in a readable
 * cookie; `Secure` according to `COOKIE_SECURE`.
 */
@Injectable()
export class SessionService {
  private readonly csrfKey: Buffer;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
  ) {
    this.csrfKey = deriveKey(config.security.sessionSecret, 'csrf');
  }

  /**
   * Whether cookies get `Secure`: `COOKIE_SECURE=true|false`, or with
   * `auto` when the request arrived over HTTPS. Behind a proxy listed in
   * `TRUSTED_PROXIES`, Fastify takes the protocol from `X-Forwarded-Proto`;
   * from anyone else that header is ignored.
   */
  secureCookies(request: FastifyRequest): boolean {
    const setting = this.config.security.cookieSecure;
    return setting === 'auto' ? request.protocol === 'https' : setting;
  }

  /** Creates a session; the returned token goes into the cookie and is never stored. */
  async create(
    userId: Id<'usr'>,
    meta: RequestMeta,
    tx?: Tx,
  ): Promise<{ session: Session; token: string }> {
    const token = generateToken();
    const session = await this.sessions.create(
      {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx,
    );
    return { session, token };
  }

  /**
   * The session of a cookie token, sliding its expiry when due; `undefined`
   * if invalid. `touch: false` (the WebSocket re-checks of an open
   * connection) only checks: an open socket is not user activity, so it
   * never keeps a session alive.
   */
  async resolve(
    token: string,
    options: { readonly touch?: boolean } = {},
  ): Promise<ResolvedSession | undefined> {
    if (!isWellFormedToken(token)) return undefined;
    const active = await this.sessions.findActiveByTokenHash(hashToken(token));
    if (active === undefined) return undefined;
    let { session } = active;
    let refreshed = false;
    if (
      options.touch !== false &&
      Date.now() - session.last_seen_at.getTime() >= SESSION_TOUCH_INTERVAL_MS
    ) {
      const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
      await this.sessions.touch(session.id, expiresAt);
      session = { ...session, expires_at: expiresAt, last_seen_at: new Date() };
      refreshed = true;
    }
    return {
      principal: { kind: 'session', userId: active.user.id, user: active.user, session },
      refreshed,
    };
  }

  /**
   * Deletes a session; once `tx` commits, WebSocket connections opened with
   * it close on every instance (`session.revoked`, CONTRACTS §7).
   */
  async revoke(session: Pick<Session, 'id' | 'user_id'>, tx?: Tx): Promise<void> {
    await this.sessions.deleteById(session.id, tx);
    await this.publishRevoked(session.user_id, [session.id], tx);
  }

  /** Deletes every session of a user (and closes their WebSockets); returns how many. */
  async revokeAllOfUser(userId: Id<'usr'>, tx?: Tx): Promise<number> {
    const revoked = await this.sessions.deleteByUserId(userId, tx);
    if (revoked > 0) await this.publishRevoked(userId, undefined, tx);
    return revoked;
  }

  private async publishRevoked(
    userId: Id<'usr'>,
    sessionIds: readonly Id<'ses'>[] | undefined,
    tx: Tx | undefined,
  ): Promise<void> {
    const memberships = await this.organizations.listMembershipsOfUser(userId, tx);
    await publishSessionsRevoked(
      this.db,
      tx,
      memberships.map((membership) => membership.organizationId),
      userId,
      sessionIds,
    );
  }

  /** The session token sent with the request, if any. */
  tokenOf(request: FastifyRequest): string | undefined {
    return parseCookies(request.headers.cookie).get(SESSION_COOKIE);
  }

  /** The signed double-submit check for a state-changing request. */
  csrfValid(request: FastifyRequest, sessionId: Id<'ses'>): boolean {
    const cookie = parseCookies(request.headers.cookie).get(CSRF_COOKIE);
    return checkCsrf(this.csrfKey, sessionId, cookie, headerValue(request.headers[CSRF_HEADER]));
  }

  /** Whether the request already carries a CSRF cookie valid for this session. */
  hasCsrfCookie(request: FastifyRequest, sessionId: Id<'ses'>): boolean {
    const cookie = parseCookies(request.headers.cookie).get(CSRF_COOKIE);
    return cookie !== undefined && verifyCsrfToken(this.csrfKey, sessionId, cookie);
  }

  /** Sets the session cookie (HttpOnly) and a fresh CSRF cookie. */
  setCookies(
    reply: FastifyReply,
    request: FastifyRequest,
    token: string,
    sessionId: Id<'ses'>,
  ): void {
    this.setSessionCookie(reply, request, token);
    this.setCsrfCookie(reply, request, sessionId);
  }

  setSessionCookie(reply: FastifyReply, request: FastifyRequest, token: string): void {
    void reply.header(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: this.secureCookies(request),
        maxAgeSeconds: SESSION_TTL_SECONDS,
      }),
    );
  }

  /** The CSRF cookie is readable by scripts (the SPA copies it into `X-CSRF-Token`). */
  setCsrfCookie(reply: FastifyReply, request: FastifyRequest, sessionId: Id<'ses'>): void {
    void reply.header(
      'set-cookie',
      serializeCookie(CSRF_COOKIE, createCsrfToken(this.csrfKey, sessionId), {
        httpOnly: false,
        secure: this.secureCookies(request),
        maxAgeSeconds: SESSION_TTL_SECONDS,
      }),
    );
  }

  clearCookies(reply: FastifyReply, request: FastifyRequest): void {
    const secure = this.secureCookies(request);
    void reply.header(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, '', { httpOnly: true, secure, maxAgeSeconds: 0 }),
    );
    void reply.header(
      'set-cookie',
      serializeCookie(CSRF_COOKIE, '', { httpOnly: false, secure, maxAgeSeconds: 0 }),
    );
  }
}
