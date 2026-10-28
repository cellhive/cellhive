import {
  ApiTokensRepository,
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
import { assertPasswordPolicy } from '../../common/auth/password/password-policy.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { SessionService } from '../../common/auth/session.service.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';
import { revokeUserApiTokens } from '../api-token/revoke-user-tokens.js';

import { emailKey, LoginThrottle } from './login-throttle.js';
import { auditForUser } from './user-audit.js';

import type { Principal, SessionPrincipal } from '../../common/auth/principal.js';
import type {
  ChangePasswordRequest,
  LoginRequest,
  MeResponse,
  UpdateMeRequest,
} from '@cellhive/contracts';

/** Sign-in attempts per client IP (SPEC §13.1: public endpoints, 429 + Retry-After). */
export const LOGIN_RATE_LIMIT = { limit: 20, windowSeconds: 60 } as const;
/** `POST /me/password` attempts per user: bounds guessing the current password from a session. */
export const PASSWORD_CHANGE_RATE_LIMIT = { limit: 10, windowSeconds: 60 * 60 } as const;

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

function currentPasswordInvalid(): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: 'The current password is wrong.',
    errors: [
      {
        path: 'current_password',
        code: 'CURRENT_PASSWORD_INVALID',
        message: 'The current password is wrong',
      },
    ],
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
    @Inject(ApiTokensRepository) private readonly apiTokens: ApiTokensRepository,
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
   * `PATCH /me` (CONTRACTS §12.0): sets the given keys and returns the
   * caller as `GET /me`. Audited as `user.updated` with the changed keys
   * only; nothing changed → nothing written.
   */
  async updateProfile(
    principal: SessionPrincipal,
    input: UpdateMeRequest,
    meta: RequestMeta,
  ): Promise<MeResponse> {
    const user = await this.db.withTx(async (tx) => {
      const current = await this.users.lockById(principal.userId, tx);
      if (current === undefined) throw new AppError('UNAUTHENTICATED');
      const before: Record<string, string | null> = {};
      const after: Record<string, string> = {};
      for (const key of ['display_name', 'locale', 'timezone'] as const) {
        const value = input[key];
        if (value === undefined || value === current[key]) continue;
        before[key] = current[key];
        after[key] = value;
      }
      if (Object.keys(after).length === 0) return current;
      const updated = await this.users.updateProfile(principal.userId, after, tx);
      await auditForUser(tx, this.organizations, principal.userId, {
        action: 'user.updated',
        entityType: 'user',
        entityId: principal.userId,
        before,
        after,
        context: auditContextOf(meta, { type: 'user', id: principal.userId }),
      });
      return updated ?? current;
    });
    return this.me({ ...principal, user });
  }

  /**
   * `POST /me/password` (CONTRACTS §12.0): checks the current password,
   * sets the new one, signs out every other session of the caller and,
   * with `revoke_tokens`, revokes their API tokens in every organization —
   * in one transaction. No password (external sign-in only) → `NO_PASSWORD`.
   */
  async changePassword(
    principal: SessionPrincipal,
    input: ChangePasswordRequest,
    meta: RequestMeta,
  ): Promise<void> {
    const userId = principal.userId;
    await this.rateLimiter.hit(`password-change:user:${userId}`, PASSWORD_CHANGE_RATE_LIMIT);
    const passwordHash = principal.user.password_hash;
    if (passwordHash === null) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'This account signs in with an external identity provider and has no password.',
        errors: [
          {
            path: 'current_password',
            code: 'NO_PASSWORD',
            message: 'The account has no password; set one with a reset link',
          },
        ],
      });
    }
    if (!(await this.hasher.verify(passwordHash, input.current_password))) {
      throw currentPasswordInvalid();
    }
    assertPasswordPolicy(input.new_password, 'new_password');
    const newHash = await this.hasher.hash(input.new_password);

    await this.db.withTx(async (tx) => {
      // Changed by another request since it was checked: that check no longer holds.
      const locked = await this.users.lockById(userId, tx);
      if (locked?.password_hash !== passwordHash) throw currentPasswordInvalid();
      await this.users.setPasswordHash(userId, newHash, tx);
      const revoked = await this.sessions.revokeOthersOfUser(userId, principal.session.id, tx);
      const context = auditContextOf(meta, { type: 'user', id: userId });
      const revokedTokens = input.revoke_tokens
        ? await revokeUserApiTokens(
            { db: this.db, organizations: this.organizations, apiTokens: this.apiTokens },
            tx,
            { userId, reason: 'password_change', context },
          )
        : 0;
      await auditForUser(tx, this.organizations, userId, {
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: userId,
        after: { revoked_sessions: revoked, revoked_tokens: revokedTokens },
        context,
      });
      if (revoked > 0) {
        // CONTRACTS §8: every session revocation other than sign-out is audited.
        await auditForUser(tx, this.organizations, userId, {
          action: 'auth.session_revoked',
          entityType: 'user',
          entityId: userId,
          after: { reason: 'password_change', revoked_sessions: revoked },
          context,
        });
      }
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
