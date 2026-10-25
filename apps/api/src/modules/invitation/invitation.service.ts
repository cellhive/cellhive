import { ALREADY_MEMBER, INVITATION_TTL_DAYS, UNKNOWN_PRINCIPAL } from '@cellhive/contracts';
import {
  findInvitationOrganization,
  invitationEmail,
  invitationStateOf,
  InvitationsRepository,
  OrganizationsRepository,
  OrgMembersRepository,
  orgScope,
  SQLSTATE,
  sqlStateOf,
  UsersRepository,
  withTxScope,
  WorkspaceMembersRepository,
  WorkspacesRepository,
  type AppConfig,
  type Db,
  type Invitation,
  type Mailer,
  type OrgRole,
  type Tx,
  type User,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound } from '../../common/access/access.service.js';
import { mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { PasswordHasher } from '../../common/auth/password/password-hasher.js';
import { assertPasswordPolicy } from '../../common/auth/password/password-policy.js';
import { generateToken, hashToken, isWellFormedToken } from '../../common/auth/secrets.js';
import { iso, isoOrNull, offsetList, userSummaryOf, validationFailed } from '../../common/dto.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG, DB, MAILER } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type {
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  CreatedInvitation,
  CreateInvitationRequest,
  Id,
  InvitationDto,
  InvitationList,
  InvitationListQuery,
  InvitationPreview,
} from '@cellhive/contracts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Invitations are valid for 7 days (SPEC §5.10). */
export const INVITATION_TTL_MS = INVITATION_TTL_DAYS * DAY_MS;
/** Previews and acceptances per IP (tokens are unguessable; this bounds work and noise). */
export const INVITATION_IP_RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;

/** The web page that accepts an invitation. */
export function inviteUrlOf(publicUrl: string, token: string): string {
  return `${publicUrl}/invite/${token}`;
}

function invitationInvalid(): AppError {
  return new AppError('INVITATION_INVALID', {
    detail: 'This invitation link is invalid, used, revoked or expired.',
  });
}

function invitationDtoOf(invitation: Invitation): InvitationDto {
  return {
    id: invitation.id,
    organization_id: invitation.organization_id,
    email: invitation.email,
    role: invitation.org_role,
    workspace_id: invitation.workspace_id,
    inviter_id: invitation.inviter_id,
    status: invitationStateOf(invitation),
    expires_at: iso(invitation.expires_at),
    accepted_at: isoOrNull(invitation.accepted_at),
    revoked_at: isoOrNull(invitation.revoked_at),
    created_at: iso(invitation.created_at),
  };
}

/**
 * Whether a member with `role` may (still) invite: owners and admins invite
 * every invitable role (`admin`, `member`).
 */
export function mayInvite(role: OrgRole | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

function sameEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Invitations (SPEC §14.1A, §5.10): the only way into an organization.
 * Tokens are 32 random bytes; only their SHA-256 is stored. The link is
 * returned once to the inviter and emailed when SMTP is configured; it is
 * never logged. Wrong, used, revoked and expired links all answer
 * `410 INVITATION_INVALID`.
 */
@Injectable()
export class InvitationService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(InvitationsRepository) private readonly invitations: InvitationsRepository,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(OrgMembersRepository) private readonly orgMembers: OrgMembersRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(WorkspacesRepository) private readonly workspaces: WorkspacesRepository,
    @Inject(WorkspaceMembersRepository)
    private readonly workspaceMembers: WorkspaceMembersRepository,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
    @Inject(MAILER) private readonly mailer: Mailer | null,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async list(
    principal: Principal,
    organizationId: Id<'org'>,
    query: InvitationListQuery,
  ): Promise<InvitationList> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    return offsetList(
      await this.invitations.list(org.scope, query, query.status),
      query,
      invitationDtoOf,
    );
  }

  async get(
    principal: Principal,
    organizationId: Id<'org'>,
    invitationId: Id<'inv'>,
  ): Promise<InvitationDto> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const invitation = await this.invitations.getById(org.scope, invitationId);
    if (invitation === undefined) throw notFound();
    return invitationDtoOf(invitation);
  }

  async create(
    principal: Principal,
    organizationId: Id<'org'>,
    input: CreateInvitationRequest,
    meta: RequestMeta,
  ): Promise<CreatedInvitation> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const token = generateToken();
    const invitation = await this.db.withTx(async (tx) => {
      const scope = withTxScope(org.scope, tx);
      const existing = await this.users.findByEmail(input.email, tx);
      if (existing !== undefined && (await this.orgMembers.get(scope, existing.id)) !== undefined) {
        throw validationFailed('This person already is a member of the organization.', {
          path: 'email',
          code: ALREADY_MEMBER,
        });
      }
      if (
        input.workspace_id !== undefined &&
        (await this.workspaces.getById(scope, input.workspace_id)) === undefined
      ) {
        throw validationFailed('No such workspace in this organization.', {
          path: 'workspace_id',
          code: UNKNOWN_PRINCIPAL,
        });
      }
      const created = await this.invitations.create(scope, {
        email: input.email,
        inviterId: principal.userId,
        orgRole: input.role,
        workspaceId: input.workspace_id ?? null,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      });
      const summary = {
        email: created.email,
        role: created.org_role,
        workspace_id: created.workspace_id,
        expires_at: iso(created.expires_at),
      };
      await recordChange(tx, {
        type: 'invitation.created',
        organizationId,
        entityType: 'invitation',
        entityId: created.id,
        context: mutationContextOf(meta, principal.userId),
        after: summary,
        data: { role: created.org_role, workspace_id: created.workspace_id },
      });
      return created;
    });

    const inviteUrl = inviteUrlOf(this.config.publicUrl, token);
    const settings = org.membership.settings;
    const orgLocale =
      typeof settings === 'object' && settings !== null && !Array.isArray(settings)
        ? settings.locale
        : undefined;
    const emailSent = this.sendEmail(
      invitation,
      org.membership.name,
      typeof orgLocale === 'string' ? orgLocale : this.config.defaults.locale,
      principal,
      inviteUrl,
    );
    return { ...invitationDtoOf(invitation), invite_url: inviteUrl, email_sent: emailSent };
  }

  /** Revokes a pending invitation; other states are left as they are. */
  async revoke(
    principal: Principal,
    organizationId: Id<'org'>,
    invitationId: Id<'inv'>,
    meta: RequestMeta,
  ): Promise<void> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(org.scope, tx);
      if ((await this.invitations.getById(scope, invitationId)) === undefined) throw notFound();
      const revoked = await this.invitations.revoke(scope, invitationId);
      if (revoked === undefined) return;
      await recordChange(tx, {
        type: 'invitation.revoked',
        organizationId,
        entityType: 'invitation',
        entityId: invitationId,
        context: mutationContextOf(meta, principal.userId),
        before: { email: revoked.email, role: revoked.org_role },
      });
    });
  }

  /** `GET /invitations/:token`: what the link is for, so the page can ask for sign-in or sign-up. */
  async preview(token: string, meta: RequestMeta): Promise<InvitationPreview> {
    await this.rateLimiter.hit(`invite:ip:${meta.ip ?? 'unknown'}`, INVITATION_IP_RATE_LIMIT);
    const invitation = await this.findPending(token);
    const organization = await this.organizations.findById(invitation.organization_id);
    if (organization === undefined) throw invitationInvalid();
    return {
      organization: { id: organization.id, name: organization.name },
      email: invitation.email,
      role: invitation.org_role,
      expires_at: iso(invitation.expires_at),
      account_exists: (await this.users.findByEmail(invitation.email)) !== undefined,
    };
  }

  /**
   * `POST /invitations/:token/accept`. Signed in: the session user must
   * have the invited email (another user gets the same `410` as a bad link,
   * revealing nothing). Not signed in: creates the account from
   * `display_name` + `password`, unless one exists (`401`: sign in first).
   */
  async accept(
    token: string,
    input: AcceptInvitationRequest | undefined,
    principal: Principal | undefined,
    meta: RequestMeta,
  ): Promise<AcceptInvitationResponse> {
    await this.rateLimiter.hit(`invite:ip:${meta.ip ?? 'unknown'}`, INVITATION_IP_RATE_LIMIT);
    const pending = await this.findPending(token);

    let newAccount: { displayName: string; passwordHash: string } | undefined;
    if (principal === undefined) {
      if ((await this.users.findByEmail(pending.email)) !== undefined) {
        throw new AppError('UNAUTHENTICATED', {
          detail: 'An account with this email exists: sign in to accept the invitation.',
        });
      }
      newAccount = await this.newAccountOf(input);
    } else if (!sameEmail(principal.user.email, pending.email)) {
      throw invitationInvalid();
    }

    const result = await this.db.withTx(async (tx) => {
      const scope = orgScope(pending.organization_id, tx);
      const invitation = await this.invitations.findByTokenHash(scope, hashToken(token), {
        forUpdate: true,
      });
      if (invitation === undefined || invitationStateOf(invitation) !== 'pending') {
        throw invitationInvalid();
      }
      // The inviter must still be allowed to invite: removing or demoting a
      // member revokes their invitations, this also covers any race with it.
      if (!mayInvite(await this.orgMembers.roleOf(scope, invitation.inviter_id))) {
        throw invitationInvalid();
      }
      let user: User;
      if (principal === undefined && newAccount !== undefined) {
        user = await this.createUser(invitation.email, newAccount, input, tx);
      } else if (principal !== undefined) {
        user = principal.user;
      } else {
        throw invitationInvalid();
      }
      const context = mutationContextOf(meta, user.id);

      const membership = await this.orgMembers.get(scope, user.id);
      let role: OrgRole = invitation.org_role;
      if (membership === undefined) {
        await this.orgMembers.add(scope, user.id, invitation.org_role);
        await recordChange(tx, {
          type: 'org_member.added',
          organizationId: invitation.organization_id,
          entityType: 'org_member',
          entityId: user.id,
          context,
          after: { user_id: user.id, role: invitation.org_role, invitation_id: invitation.id },
          data: { user_id: user.id, role: invitation.org_role },
        });
      } else {
        // Already a member (e.g. two invitations): keep the current role.
        role = membership.role;
      }
      if (invitation.workspace_id !== null) {
        const added = await this.workspaceMembers.add(scope, {
          workspaceId: invitation.workspace_id,
          principalType: 'user',
          principalId: user.id,
          role: 'member',
        });
        if (added !== undefined) {
          await recordChange(tx, {
            type: 'workspace_member.added',
            organizationId: invitation.organization_id,
            entityType: 'workspace_member',
            entityId: invitation.workspace_id,
            context,
            after: { principal_type: 'user', principal_id: user.id, role: 'member' },
            data: { principal_type: 'user', principal_id: user.id, role: 'member' },
          });
        }
      }
      if ((await this.invitations.markAccepted(scope, invitation.id)) === undefined) {
        throw invitationInvalid();
      }
      await recordChange(tx, {
        type: 'invitation.accepted',
        organizationId: invitation.organization_id,
        entityType: 'invitation',
        entityId: invitation.id,
        context,
        after: { user_id: user.id, role, new_account: principal === undefined },
        data: { user_id: user.id },
      });
      const organization = await this.organizations.findById(invitation.organization_id, tx);
      if (organization === undefined) throw invitationInvalid();
      return {
        organization: { id: organization.id, name: organization.name, slug: organization.slug },
        user: userSummaryOf(user),
        role,
        workspace_id: invitation.workspace_id,
      };
    });
    if (principal !== undefined) this.access.invalidate(principal);
    return result;
  }

  /** A pending invitation for `token` whose inviter may still invite, or `410`. */
  private async findPending(token: string): Promise<Invitation> {
    if (!isWellFormedToken(token)) throw invitationInvalid();
    const tokenHash = hashToken(token);
    const organizationId = await findInvitationOrganization(this.db.kysely, tokenHash);
    if (organizationId === undefined) throw invitationInvalid();
    const scope = orgScope(organizationId);
    const invitation = await this.invitations.findByTokenHash(scope, tokenHash);
    if (invitation === undefined || invitationStateOf(invitation) !== 'pending') {
      throw invitationInvalid();
    }
    if (!mayInvite(await this.orgMembers.roleOf(scope, invitation.inviter_id))) {
      throw invitationInvalid();
    }
    return invitation;
  }

  /** Validates the sign-up fields and hashes the password (before any transaction). */
  private async newAccountOf(
    input: AcceptInvitationRequest | undefined,
  ): Promise<{ displayName: string; passwordHash: string }> {
    const missing = (['display_name', 'password'] as const).filter(
      (key) => input?.[key] === undefined,
    );
    if (missing.length > 0 || input?.display_name === undefined || input.password === undefined) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Sign in, or give a display name and a password to create your account.',
        errors: missing.map((path) => ({ path, code: 'REQUIRED', message: 'Required' })),
      });
    }
    assertPasswordPolicy(input.password);
    return {
      displayName: input.display_name,
      passwordHash: await this.hasher.hash(input.password),
    };
  }

  private async createUser(
    email: string,
    account: { displayName: string; passwordHash: string },
    input: AcceptInvitationRequest | undefined,
    tx: Tx,
  ): Promise<User> {
    try {
      return await this.users.create(
        {
          email,
          displayName: account.displayName,
          passwordHash: account.passwordHash,
          locale: input?.locale ?? null,
          timezone: input?.timezone ?? null,
        },
        tx,
      );
    } catch (error) {
      // Created concurrently by another request: that account must sign in.
      if (sqlStateOf(error) === SQLSTATE.uniqueViolation) {
        throw new AppError('UNAUTHENTICATED', {
          detail: 'An account with this email exists: sign in to accept the invitation.',
        });
      }
      throw error;
    }
  }

  /** Emails the link when SMTP is configured; failures are logged without the link. */
  private sendEmail(
    invitation: Invitation,
    organizationName: string,
    locale: string,
    principal: Principal,
    inviteUrl: string,
  ): boolean {
    const mailer = this.mailer;
    if (mailer === null) return false;
    const message = invitationEmail(invitation.email, {
      locale,
      inviterName: principal.user.display_name,
      organizationName,
      inviteUrl,
      expiresAt: invitation.expires_at,
    });
    mailer.send(message).catch((err: unknown) => {
      this.logger.warn(
        { invitation_id: invitation.id, error: err instanceof Error ? err.name : 'unknown' },
        'invitation email could not be sent',
      );
    });
    return true;
  }
}
