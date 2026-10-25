import {
  OrganizationsRepository,
  UsersRepository,
  type AppConfig,
  type Db,
  type JsonValue,
  type Session,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { PasswordHasher } from '../../common/auth/password/password-hasher.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { SessionService } from '../../common/auth/session.service.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import { emailKey, LoginThrottle } from './login-throttle.js';
import { auditForUser } from './user-audit.js';

import type { Principal, SessionPrincipal } from '../../common/auth/principal.js';
import type { LoginRequest, MeResponse } from '@cellhive/contracts';

/** Sign-in attempts per client IP (SPEC §13.1: public endpoints, 429 + Retry-After). */
export const LOGIN_RATE_LIMIT = { limit: 20, windowSeconds: 60 } as const;

export interface LoginResult {
  readonly session: Session;
  /** Goes into the cookie only. */
  readonly token: string;
}

function invalidCredentials(): AppError {
  return new AppError('UNAUTHENTICATED', { detail: 'Wrong email or password.' });
}

function accountLocked(retryAfterSeconds: number): AppError {
  return new AppError('ACCOUNT_LOCKED', {
    detail: 'Too many failed sign-in attempts; try again later.',
    retryAfterSeconds,
  });
}

function settingOf(settings: JsonValue, key: string): string | undefined {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return undefined;
  }
  const value = settings[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Sign-in, sign-out and `GET /me` (SPEC §14.2, CONTRACTS §5A). */
@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(LoginThrottle) private readonly throttle: LoginThrottle,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
  ) {}

  /**
   * Checks the credentials and opens a new session. Order: per-IP rate
   * limit (429), email lock (423), attempt counted atomically (423 beyond
   * the threshold, so parallel requests cannot run more password checks),
   * password check. Unknown emails, users without a password and disabled
   * users all fail the same way, after the same argon2 work. A session sent
   * with the request (`previous`) is revoked: sessions rotate on sign-in.
   */
  async login(
    input: LoginRequest,
    meta: RequestMeta,
    previous: SessionPrincipal | undefined,
  ): Promise<LoginResult> {
    await this.rateLimiter.hit(`login:ip:${meta.ip ?? 'unknown'}`, LOGIN_RATE_LIMIT);
    const key = emailKey(input.email);
    const lockedFor = await this.throttle.lockedFor(key);
    if (lockedFor > 0) throw accountLocked(lockedFor);
    const attempt = await this.throttle.beginAttempt(key);
    if (!attempt.allowed) throw accountLocked(attempt.retryAfterSeconds);

    const user = await this.users.findByEmail(input.email);
    const valid =
      user !== undefined && user.status === 'active' && user.password_hash !== null
        ? await this.hasher.verify(user.password_hash, input.password)
        : await this.hasher.verifyDummy(input.password);

    if (!valid || user === undefined) {
      const failure = await this.throttle.recordFailure(key, attempt);
      await this.db.withTx(async (tx) => {
        // Nobody is authenticated: the attempt is recorded as a system entry
        // about the targeted user (`entity_id`), with the client IP.
        const actorContext = auditContextOf(meta, { type: 'system', id: null });
        await auditForUser(tx, this.organizations, user?.id ?? null, {
          action: 'auth.login_failed',
          entityType: 'user',
          entityId: user?.id ?? null,
          after: {
            reason: user === undefined ? 'unknown_email' : 'invalid_credentials',
            ...(failure.locked ? { locked: true } : {}),
          },
          context: actorContext,
        });
      });
      if (failure.locked) throw accountLocked(failure.retryAfterSeconds);
      throw invalidCredentials();
    }

    await this.throttle.reset(key);
    return this.db.withTx(async (tx) => {
      if (previous !== undefined) await this.sessions.revoke(previous.session, tx);
      const created = await this.sessions.create(user.id, meta, tx);
      await auditForUser(tx, this.organizations, user.id, {
        action: 'auth.login',
        entityType: 'session',
        entityId: created.session.id,
        after: { user_id: user.id },
        context: auditContextOf(meta, { type: 'user', id: user.id }),
      });
      return created;
    });
  }

  /** Revokes the current session. */
  async logout(principal: SessionPrincipal, meta: RequestMeta): Promise<void> {
    await this.db.withTx(async (tx) => {
      await this.sessions.revoke(principal.session, tx);
      await auditForUser(tx, this.organizations, principal.userId, {
        action: 'auth.logout',
        entityType: 'session',
        entityId: principal.session.id,
        after: { user_id: principal.userId },
        context: auditContextOf(meta, { type: 'user', id: principal.userId }),
      });
    });
  }

  /**
   * CONTRACTS §5A. `locale`/`timezone`: the user's own setting, else the
   * default of their oldest organization, else `DEFAULT_LOCALE` /
   * `DEFAULT_TIMEZONE`.
   */
  async me(principal: Principal): Promise<MeResponse> {
    const { user } = principal;
    // An API token only ever sees its own organization (ADR-36 §1).
    const memberships = (await this.organizations.listMembershipsOfUser(user.id)).filter(
      (membership) =>
        principal.kind === 'session' || membership.organizationId === principal.organizationId,
    );
    const first = memberships[0];
    return {
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
      },
      orgs: memberships.map((membership) => ({
        id: membership.organizationId,
        name: membership.name,
        slug: membership.slug,
        role: membership.role,
      })),
      locale:
        user.locale ??
        (first === undefined ? undefined : settingOf(first.settings, 'locale')) ??
        this.config.defaults.locale,
      timezone:
        user.timezone ??
        (first === undefined ? undefined : settingOf(first.settings, 'timezone')) ??
        this.config.defaults.timezone,
    };
  }
}
