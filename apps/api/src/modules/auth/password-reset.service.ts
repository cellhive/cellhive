import { toIsoDateTime, type Id, type PasswordResetLink } from '@cellhive/contracts';
import {
  ApiTokensRepository,
  AuditWriter,
  enqueue,
  lockUserMemberships,
  OrganizationsRepository,
  OrgMembersRepository,
  orgScope,
  PasswordResetsRepository,
  UsersRepository,
  type AppConfig,
  type AuditContext,
  type Db,
  type Tx,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { PasswordHasher } from '../../common/auth/password/password-hasher.js';
import { assertPasswordPolicy } from '../../common/auth/password/password-policy.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { hashToken, isWellFormedToken } from '../../common/auth/secrets.js';
import { SessionService } from '../../common/auth/session.service.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';
import { revokeUserApiTokens } from '../api-token/revoke-user-tokens.js';

import { emailKey, LoginThrottle } from './login-throttle.js';
import { PasswordResetLinks } from './password-reset-links.js';
import { auditForUser } from './user-audit.js';

import type { Principal } from '../../common/auth/principal.js';

/** SPEC §14.2: forgot-password is limited to 5 per hour per email… */
export const FORGOT_EMAIL_RATE_LIMIT = { limit: 5, windowSeconds: 60 * 60 } as const;
/** …and 20 per hour per IP. */
export const FORGOT_IP_RATE_LIMIT = { limit: 20, windowSeconds: 60 * 60 } as const;
/** Attempts of the `auth.password_reset_email` job (SMTP failures are retried). */
export const FORGOT_EMAIL_MAX_ATTEMPTS = 3;
/** Redemption attempts per IP (tokens are unguessable; this bounds hashing work). */
export const RESET_IP_RATE_LIMIT = { limit: 20, windowSeconds: 60 } as const;

function resetTokenInvalid(): AppError {
  return new AppError('RESET_TOKEN_INVALID', {
    detail: 'This password reset link is invalid, used or expired.',
  });
}

/**
 * Password reset (SPEC §14.2, CONTRACTS §12.1): admin links, forgot
 * password by email, and redemption. Tokens and links are never logged.
 */
@Injectable()
export class PasswordResetService {
  private readonly links: PasswordResetLinks;
  private readonly audit = new AuditWriter();

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(PasswordResetsRepository) private readonly passwordResets: PasswordResetsRepository,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(OrgMembersRepository) private readonly orgMembers: OrgMembersRepository,
    @Inject(ApiTokensRepository) private readonly apiTokens: ApiTokensRepository,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(LoginThrottle) private readonly throttle: LoginThrottle,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
  ) {
    this.links = new PasswordResetLinks(passwordResets, config.publicUrl);
  }

  /**
   * `POST /orgs/:orgId/members/:userId/password-reset`. The caller must be
   * owner/admin of the organization (not a member at all → 404). The target
   * must be a member of this organization **only** and own no organization;
   * otherwise an admin of org A could take over an account that also
   * matters elsewhere (SPEC §14.2) → 403, use the CLI. With `revokeTokens`
   * (default) the member's API tokens are revoked with the link (T802).
   */
  async createForMember(
    principal: Principal,
    organizationId: Id<'org'>,
    userId: Id<'usr'>,
    options: { readonly revokeTokens: boolean },
    meta: RequestMeta,
  ): Promise<PasswordResetLink> {
    const scope = orgScope(organizationId);
    const callerRole = await this.orgMembers.roleOf(scope, principal.userId);
    if (callerRole === undefined) throw new AppError('NOT_FOUND');
    if (callerRole !== 'owner' && callerRole !== 'admin') {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'Only organization owners and admins can create password reset links.',
      });
    }
    const target = await this.orgMembers.get(scope, userId);
    const user = target === undefined ? undefined : await this.users.findById(userId);
    if (user === undefined) throw new AppError('NOT_FOUND');

    const memberships = await this.organizations.listMembershipsOfUser(userId);
    if (memberships.length !== 1 || memberships.some((m) => m.role === 'owner')) {
      throw new AppError('PERMISSION_DENIED', {
        detail:
          'This user owns an organization or belongs to several; reset the password with ' +
          'the server CLI (cellhive user reset-password).',
      });
    }
    if (user.password_hash === null) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'This user signs in with an external identity provider and has no password.',
        errors: [
          {
            path: 'userId',
            code: 'NO_PASSWORD',
            message: 'The user has no password to reset',
          },
        ],
      });
    }

    const link = await this.db.withTx(async (tx) => {
      const created = await this.links.create(tx, userId, {
        source: 'admin',
        adminId: principal.userId,
      });
      const context = auditContextOf(meta, { type: 'user', id: principal.userId });
      const revokedTokens = options.revokeTokens
        ? await this.revokeTokens(tx, userId, context, principal.userId)
        : 0;
      await this.audit.write(tx, {
        action: 'auth.password_reset_requested',
        organizationId,
        entityType: 'user',
        entityId: userId,
        after: { method: 'admin_link', reset_id: created.resetId, revoked_tokens: revokedTokens },
        context,
      });
      return created;
    });
    return { reset_url: link.url, expires_at: toIsoDateTime(link.expiresAt) };
  }

  /**
   * `POST /auth/forgot-password`: always `202`, after the same work for
   * every address (rate limits, then one `auth.password_reset_email` job),
   * so neither the response nor its timing reveals whether an account
   * exists. The worker decides whether to email a link
   * (`sendForgotPasswordEmail`). Requests for the same address within the
   * window share one pending job.
   */
  async forgot(email: string, meta: RequestMeta): Promise<void> {
    await this.rateLimiter.hit(`forgot:ip:${meta.ip ?? 'unknown'}`, FORGOT_IP_RATE_LIMIT);
    const key = emailKey(email);
    await this.rateLimiter.hit(`forgot:email:${key}`, FORGOT_EMAIL_RATE_LIMIT);
    const context = auditContextOf(meta, { type: 'system', id: null });
    await this.db.withTx((tx) =>
      enqueue(
        tx,
        'auth.password_reset_email',
        {
          email,
          request_id: context.request_id,
          ip: context.ip,
          user_agent: context.user_agent,
        },
        { jobKey: `auth.password_reset_email:${key}`, maxAttempts: FORGOT_EMAIL_MAX_ATTEMPTS },
      ),
    );
  }

  /**
   * `POST /auth/password-reset/:token`: sets the new password, marks the
   * link used, revokes every session of the user — and, with
   * `revokeTokens` (the default), every API token of the user in every
   * organization (T802) — and clears the sign-in lock, in one transaction.
   * Wrong, used and expired tokens, and links of an account that is no
   * longer active (any source), all answer `410 RESET_TOKEN_INVALID`.
   */
  async redeem(
    token: string,
    input: { readonly password: string; readonly revokeTokens: boolean },
    meta: RequestMeta,
  ): Promise<void> {
    const { password } = input;
    await this.rateLimiter.hit(`reset:ip:${meta.ip ?? 'unknown'}`, RESET_IP_RATE_LIMIT);
    if (!isWellFormedToken(token)) throw resetTokenInvalid();
    const tokenHash = hashToken(token);
    // Reject bad links before spending argon2 work; re-checked under a row lock.
    const pending = await this.db.withTx((tx) =>
      this.passwordResets.findUsableForUpdate(tokenHash, tx),
    );
    if (pending === undefined) throw resetTokenInvalid();
    assertPasswordPolicy(password);
    const passwordHash = await this.hasher.hash(password);

    const user = await this.db.withTx(async (tx) => {
      const reset = await this.passwordResets.findUsableForUpdate(tokenHash, tx);
      if (reset === undefined) throw resetTokenInvalid();
      const target = await this.users.findById(reset.user_id, tx);
      // Every source: a disabled account cannot sign in, so it cannot set a
      // password with a link issued while it was active either. The link is
      // not used up (it works again once the account is active).
      if (target?.status !== 'active') throw resetTokenInvalid();
      switch (reset.source) {
        case 'admin':
          // The issuing admin was deleted: the link no longer holds.
          if (reset.created_by === null) throw resetTokenInvalid();
          await this.assertAdminLinkStillAllowed(tx, target.id, reset.created_by);
          break;
        case 'cli':
        case 'self_service':
          // Issued by the server operator / mailed to the account itself.
          break;
      }
      await this.users.setPasswordHash(target.id, passwordHash, tx);
      await this.passwordResets.markUsed(reset.id, tx);
      // Open WebSockets of these sessions close once this commits.
      const revoked = await this.sessions.revokeAllOfUser(target.id, tx);
      const context = auditContextOf(meta, { type: 'user', id: target.id });
      const revokedTokens = input.revokeTokens
        ? await this.revokeTokens(tx, target.id, context)
        : 0;
      await auditForUser(tx, this.organizations, target.id, {
        action: 'auth.password_reset',
        entityType: 'user',
        entityId: target.id,
        after: { reset_id: reset.id, revoked_sessions: revoked, revoked_tokens: revokedTokens },
        context,
      });
      if (revoked > 0) {
        // CONTRACTS §8: every session revocation other than sign-out is audited.
        await auditForUser(tx, this.organizations, target.id, {
          action: 'auth.session_revoked',
          entityType: 'user',
          entityId: target.id,
          after: { reason: 'password_reset', reset_id: reset.id, revoked_sessions: revoked },
          context,
        });
      }
      return target;
    });
    await this.throttle.reset(emailKey(user.email));
  }

  /** Every API token of the user, in every organization (T802). */
  private revokeTokens(
    tx: Tx,
    userId: Id<'usr'>,
    context: AuditContext,
    revokedBy: Id<'usr'> = userId,
  ): Promise<number> {
    return revokeUserApiTokens(
      { db: this.db, organizations: this.organizations, apiTokens: this.apiTokens },
      tx,
      { userId, reason: 'password_reset', context, revokedBy },
    );
  }

  /**
   * An admin-issued link is redeemed only while the conditions under which
   * it was issued still hold (`createForMember`): the target belongs to one
   * organization only and owns none, and the issuer is still owner/admin of
   * that organization. Checked with the memberships locked, so a concurrent
   * promotion, second membership or demotion of the issuer waits.
   */
  private async assertAdminLinkStillAllowed(
    tx: Tx,
    targetId: Id<'usr'>,
    issuerId: Id<'usr'>,
  ): Promise<void> {
    const memberships = await lockUserMemberships(tx, targetId);
    const only = memberships.length === 1 ? memberships[0] : undefined;
    if (only === undefined || only.role === 'owner') throw resetTokenInvalid();
    const issuerRole = await this.orgMembers.lockRole(orgScope(only.organizationId, tx), issuerId);
    if (issuerRole !== 'owner' && issuerRole !== 'admin') throw resetTokenInvalid();
  }
}
