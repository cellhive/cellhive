import {
  EMAIL_IDENTITIES_MAX_PER_ORG,
  EMAIL_VERIFICATION_MAX_CODE_ATTEMPTS,
  EMAIL_VERIFICATION_SENDS_PER_DAY_PER_ORG,
  EMAIL_VERIFICATION_SENDS_PER_HOUR_PER_IDENTITY,
  displayNameIssueOf,
  newId,
  type BaseEmailIdentityList,
  type CreateEmailIdentityInput,
  type EmailIdentityDto,
  type EmailIdentityList,
  type EmailIdentityMutation,
  type EmailIdentityUsages,
  type EmailVerificationConfirmed,
  type EmailVerificationOutcome,
  type EmailVerificationPreview,
  type EmailVerificationStep,
  type Id,
  type ProblemErrorItem,
  type UpdateEmailIdentityRequest,
} from '@cellhive/contracts';
import {
  canSeeAutomation,
  checkSignatureAssets,
  deriveSecretKey,
  EmailAssetsRepository,
  EmailIdentitiesRepository,
  EmailIdentityUsageRepository,
  EmailIdentityVerificationsRepository,
  EMAIL_VERIFICATION_TTL_MS,
  identityHintsOf,
  identityModeOf,
  identityTransportOf,
  isEmailSendError,
  issueVerification,
  normalizeAddress,
  normalizeSmtpHost,
  OrganizationsRepository,
  orgScope,
  parseVerificationToken,
  resolveAllowedSmtpHost,
  sanitizeHeaderText,
  sealSecret,
  senderDisplayOf,
  senderVerificationEmail,
  signatureInput,
  SmtpHostError,
  SQLSTATE,
  sqlStateOf,
  unsealSecret,
  UsersRepository,
  verificationCodeMatches,
  verificationSenderOf,
  verifySenderUrlOf,
  type AppConfig,
  type Db,
  type EmailIdentityPatch,
  type EmailIdentityRow,
  type EmailIdentityVerificationRow,
  type EmailSendError,
  type JsonObject,
  type JsonValue,
  type Mailer,
  type OrgScope,
  type Tx,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, permissionDenied } from '../../common/access/access.service.js';
import { mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { iso, isoOrNull } from '../../common/dto.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG, DB, MAIL_SERVICE } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';
import type { Buffer } from 'node:buffer';

/** Public preview and confirmation per IP (tokens are unguessable; this bounds work). */
export const EMAIL_VERIFY_IP_RATE_LIMIT = { limit: 30, windowSeconds: 60 } as const;

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

type SmtpSettings = Pick<
  EmailIdentityRow,
  'smtp_host' | 'smtp_port' | 'smtp_security' | 'smtp_username' | 'smtp_password_enc'
>;

const NO_SMTP: SmtpSettings = {
  smtp_host: null,
  smtp_port: null,
  smtp_security: null,
  smtp_username: null,
  smtp_password_enc: null,
};

function invalid(detail: string, errors: ProblemErrorItem[]): AppError {
  return new AppError('VALIDATION_FAILED', { detail, errors });
}

function invalidField(path: string, code: string, message: string): AppError {
  return invalid(message, [{ path, code, message }]);
}

function verificationInvalid(
  code: 'TOKEN_INVALID' | 'CODE_INVALID' | 'CODE_LOCKED' | 'NO_PENDING_VERIFICATION',
  params?: Record<string, unknown>,
): AppError {
  const messages = {
    TOKEN_INVALID: 'This verification link is invalid, used, replaced or expired.',
    CODE_INVALID: 'The verification code is wrong.',
    CODE_LOCKED: 'Too many wrong codes: send a new verification email.',
    NO_PENDING_VERIFICATION: 'There is no verification to complete: send a new one.',
  } as const;
  return new AppError('EMAIL_VERIFICATION_INVALID', {
    detail: messages[code],
    errors: [
      {
        path: code === 'TOKEN_INVALID' ? 'token' : 'code',
        code,
        message: messages[code],
        ...(params === undefined ? {} : { params }),
      },
    ],
  });
}

/** Step of "Test & verify" a classified SMTP failure belongs to. */
function stepOf(error: EmailSendError, sending: boolean): EmailVerificationStep {
  switch (error.reason) {
    case 'connection_failed':
    case 'timeout':
    case 'host_not_allowed':
      return 'connect';
    case 'tls_failed':
      return 'tls';
    case 'auth_failed':
      return 'auth';
    default:
      return error.code === 'smtp_not_configured' ? 'connect' : sending ? 'send' : 'connect';
  }
}

function localeOf(settings: unknown): string | null {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null;
  const locale = (settings as Record<string, unknown>)['locale'];
  return typeof locale === 'string' ? locale : null;
}

/** Snapshot for audit entries: never the password, token or code. */
function snapshotOf(identity: EmailIdentityRow, baseIds: readonly Id<'bse'>[]): JsonObject {
  return {
    email: identity.email,
    display_name: identity.display_name,
    reply_to: identity.reply_to,
    transport: identity.transport,
    mode: identity.mode,
    status: identity.status,
    base_scope: identity.base_scope,
    base_ids: [...baseIds],
    signature_md: identity.signature_md,
    smtp: smtpSnapshotOf(identity),
  };
}

function smtpSnapshotOf(identity: SmtpSettings): JsonObject | null {
  return identity.smtp_host === null
    ? null
    : {
        host: identity.smtp_host,
        port: identity.smtp_port,
        security: identity.smtp_security,
        username: identity.smtp_username,
      };
}

/**
 * Sender identities (BACKLOG T530, ADR-33, CONTRACTS §23.3). Managed by
 * organization owners/admins only (members `403`, other organizations
 * `404`); automation managers of a base only list the verified identities
 * in scope, without SMTP settings. SMTP passwords are sealed and never
 * returned, logged or audited; verification links and codes are stored
 * hashed and never returned or logged.
 */
@Injectable()
export class EmailIdentityService {
  private readonly smtpKey: Buffer;
  private readonly codeKey: Buffer;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(MAIL_SERVICE) private readonly mailer: Mailer,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(EmailIdentitiesRepository) private readonly identities: EmailIdentitiesRepository,
    @Inject(EmailIdentityVerificationsRepository)
    private readonly verifications: EmailIdentityVerificationsRepository,
    @Inject(EmailIdentityUsageRepository) private readonly usage: EmailIdentityUsageRepository,
    @Inject(EmailAssetsRepository) private readonly assets: EmailAssetsRepository,
  ) {
    this.smtpKey = deriveSecretKey(config.security.appMasterKey, 'email-identity-smtp');
    this.codeKey = deriveSecretKey(config.security.appMasterKey, 'email-identity-code');
  }

  // --- Reads -------------------------------------------------------------

  async list(principal: Principal, organizationId: Id<'org'>): Promise<EmailIdentityList> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const rows = await this.identities.list(org.scope);
    return { items: await this.dtosOf(org.scope, rows) };
  }

  async get(principal: Principal, identityId: Id<'eid'>): Promise<EmailIdentityDto> {
    const { scope, identity } = await this.requireIdentity(principal, identityId);
    return this.dtoOf(scope, identity);
  }

  /** `GET /bases/:baseId/email-identities`: automation managers of the base. */
  async listForBase(principal: Principal, baseId: Id<'bse'>): Promise<BaseEmailIdentityList> {
    const base = await this.access.requireBase(principal, baseId, 'read');
    const managesAutomations =
      base.access.is_admin ||
      Object.values(base.access.tables).some((table) => table.perm === 'manage');
    if (!managesAutomations) {
      throw permissionDenied('Only automation managers of the base can list sender identities.');
    }
    const rows = await this.identities.listUsableInBase(base.org.scope, baseId);
    return {
      items: rows.map((row) => ({
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        mode: identityModeOf(row.transport, row.email, this.config.mail),
      })),
    };
  }

  /**
   * Automations (not deleted) whose `send_email` steps send as the identity
   * or reply to it (T514): they fail with `email_identity_unavailable` once
   * it is disabled or deleted. The name only when the caller sees the
   * automation (its base, and its trigger table unless base admin).
   */
  async usages(principal: Principal, identityId: Id<'eid'>): Promise<EmailIdentityUsages> {
    const { scope } = await this.requireIdentity(principal, identityId);
    const rows = await this.usage.list(scope, identityId);
    const items: EmailIdentityUsages['items'] = [];
    for (const row of rows) {
      const base = await this.access.findBase(principal, row.baseId);
      const visible = base !== undefined && canSeeAutomation(base.access, row.triggerTableId);
      items.push({
        automation_id: row.automationId,
        base_id: row.baseId,
        name: visible ? row.name : null,
      });
    }
    return { items, total: items.length };
  }

  // --- Writes ------------------------------------------------------------

  async create(
    principal: Principal,
    organizationId: Id<'org'>,
    body: CreateEmailIdentityInput,
    meta: RequestMeta,
  ): Promise<EmailIdentityMutation> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const email = this.addressOf(body.email, 'email');
    const replyTo =
      body.reply_to === undefined || body.reply_to === null
        ? null
        : this.addressOf(body.reply_to, 'reply_to');
    const displayName = this.displayNameOf(body.display_name);
    const signature = signatureInput(body.signature_md ?? null, 'signature_md');
    // Images must be signature assets of this organization (T534).
    await checkSignatureAssets(this.assets, org.scope, signature, 'signature_md');
    let smtp: SmtpSettings = NO_SMTP;
    if (body.transport === 'smtp') {
      if (body.smtp === undefined) {
        throw invalidField('smtp', 'SMTP_REQUIRED', 'The SMTP server is required.');
      }
      if (body.smtp.password === undefined) {
        throw invalidField('smtp.password', 'PASSWORD_REQUIRED', 'The SMTP password is required.');
      }
      smtp = await this.smtpSettingsOf(body.smtp, null);
    } else if (body.smtp !== undefined) {
      throw invalidField('smtp', 'SMTP_NOT_ALLOWED', 'Only the transport smtp has an SMTP server.');
    }
    const baseIds = body.base_scope === 'selected' ? [...new Set(body.base_ids)] : [];
    await this.assertBases(org.scope, baseIds);
    if ((await this.identities.count(org.scope)) >= EMAIL_IDENTITIES_MAX_PER_ORG) {
      throw invalidField(
        'email',
        'IDENTITY_LIMIT_REACHED',
        `An organization has at most ${String(EMAIL_IDENTITIES_MAX_PER_ORG)} sender identities.`,
      );
    }
    const context = mutationContextOf(meta, principal.userId);
    const identity = await this.uniqueEmail(() =>
      this.db.withTx(async (tx) => {
        const scope = orgScope(organizationId, tx);
        const created = await this.identities.create(scope, {
          id: newId('eid'),
          email,
          display_name: displayName,
          reply_to: replyTo,
          transport: body.transport,
          mode: identityModeOf(body.transport, email, this.config.mail),
          base_scope: body.base_scope,
          signature_md: signature,
          ...smtp,
          created_by: principal.userId,
        });
        await this.identities.replaceBases(scope, created.id, baseIds);
        await this.change(tx, created, 'email_identity.created', context, {
          after: {
            ...snapshotOf(created, baseIds),
            ...(created.smtp_security === 'none' ? { insecure_confirmed: true } : {}),
          },
        });
        return created;
      }),
    );
    const verification = await this.sendVerification(org.scope, identity, principal, meta, {
      explicit: false,
    });
    return { identity: await this.dtoOf(org.scope, identity), verification };
  }

  async update(
    principal: Principal,
    identityId: Id<'eid'>,
    body: UpdateEmailIdentityRequest,
    meta: RequestMeta,
  ): Promise<EmailIdentityMutation> {
    const { scope: readScope, identity: current } = await this.requireIdentity(
      principal,
      identityId,
    );
    const organizationId = current.organization_id;
    const patch: EmailIdentityPatch = {};
    if (body.email !== undefined) patch.email = this.addressOf(body.email, 'email');
    if (body.display_name !== undefined) patch.display_name = this.displayNameOf(body.display_name);
    if (body.reply_to !== undefined) {
      patch.reply_to = body.reply_to === null ? null : this.addressOf(body.reply_to, 'reply_to');
    }
    if (body.signature_md !== undefined) {
      patch.signature_md = signatureInput(body.signature_md, 'signature_md');
      await checkSignatureAssets(this.assets, readScope, patch.signature_md, 'signature_md');
    }
    const transport = body.transport ?? current.transport;
    if (transport !== current.transport) patch.transport = transport;

    // SMTP settings: required when switching to `smtp`, cleared when leaving it.
    let nextSmtp: SmtpSettings = NO_SMTP;
    let passwordChanged = false;
    if (transport === 'smtp') {
      if (body.smtp === undefined && current.transport !== 'smtp') {
        throw invalidField('smtp', 'SMTP_REQUIRED', 'The SMTP server is required.');
      }
      if (body.smtp === undefined) {
        nextSmtp = current;
      } else {
        if (body.smtp.password === undefined && current.smtp_password_enc === null) {
          throw invalidField(
            'smtp.password',
            'PASSWORD_REQUIRED',
            'The SMTP password is required.',
          );
        }
        passwordChanged =
          body.smtp.password !== undefined &&
          !this.samePassword(current.smtp_password_enc, body.smtp.password);
        nextSmtp = await this.smtpSettingsOf(
          passwordChanged ? body.smtp : { ...body.smtp, password: undefined },
          current,
        );
      }
    } else if (body.smtp !== undefined) {
      throw invalidField('smtp', 'SMTP_NOT_ALLOWED', 'Only the transport smtp has an SMTP server.');
    }
    const endpointChanged =
      transport === 'smtp' &&
      (current.transport !== 'smtp' ||
        nextSmtp.smtp_host !== current.smtp_host ||
        nextSmtp.smtp_port !== current.smtp_port ||
        nextSmtp.smtp_security !== current.smtp_security ||
        nextSmtp.smtp_username !== current.smtp_username ||
        passwordChanged);
    if (transport !== current.transport || endpointChanged) Object.assign(patch, nextSmtp);

    const baseScope = body.base_scope ?? current.base_scope;
    if (baseScope !== current.base_scope) patch.base_scope = baseScope;
    const currentBaseIds =
      (await this.identities.baseIdsOf(readScope, [current.id])).get(current.id) ?? [];
    let baseIds = currentBaseIds;
    if (baseScope === 'all') baseIds = [];
    else if (body.base_ids !== undefined) baseIds = [...new Set(body.base_ids)].sort();
    await this.assertBases(readScope, baseIds);

    const email = patch.email ?? current.email;
    // ADR-33 §2/§1A: address, transport, host, user name or password → verify again.
    const reverify =
      email !== current.email ||
      transport !== current.transport ||
      (transport === 'smtp' &&
        (nextSmtp.smtp_host !== current.smtp_host ||
          nextSmtp.smtp_username !== current.smtp_username ||
          passwordChanged));
    patch.mode = identityModeOf(transport, email, this.config.mail);
    if (endpointChanged || transport !== current.transport) {
      patch.smtp_version = current.smtp_version + 1;
      patch.auth_failures = 0;
    }
    if (reverify) {
      if (current.status === 'disabled') {
        patch.status_before_disable = 'pending';
      } else {
        patch.status = 'pending';
      }
      patch.verified_at = null;
      patch.verified_via = null;
      patch.error_reason = null;
    }

    const context = mutationContextOf(meta, principal.userId);
    const updated = await this.uniqueEmail(() =>
      this.db.withTx(async (tx) => {
        const scope = orgScope(organizationId, tx);
        const locked = await this.identities.findById(scope, current.id, { forUpdate: true });
        if (locked === undefined) throw notFound();
        const row = (await this.identities.update(scope, current.id, patch)) ?? locked;
        const sameBases =
          baseIds.length === currentBaseIds.length &&
          baseIds.every((id, index) => id === currentBaseIds[index]);
        if (!sameBases) await this.identities.replaceBases(scope, current.id, baseIds);
        if (reverify) await this.verifications.delete(scope, current.id);

        const before = snapshotOf(current, currentBaseIds);
        const after = snapshotOf(row, baseIds);
        const changedKeys = Object.keys(after).filter(
          (key) =>
            key !== 'smtp' &&
            key !== 'mode' &&
            key !== 'status' &&
            JSON.stringify(before[key]) !== JSON.stringify(after[key]),
        );
        if (changedKeys.length > 0) {
          await this.change(tx, row, 'email_identity.updated', context, {
            before: Object.fromEntries(changedKeys.map((key) => [key, before[key] ?? null])),
            after: {
              ...Object.fromEntries(changedKeys.map((key) => [key, after[key] ?? null])),
              ...(reverify ? { status: row.status } : {}),
            },
          });
        }
        if (endpointChanged || (current.transport === 'smtp' && transport !== 'smtp')) {
          await this.change(tx, row, 'email_identity.credentials_changed', context, {
            before: { smtp: smtpSnapshotOf(current) },
            after: {
              smtp: smtpSnapshotOf(row),
              password_changed: passwordChanged,
              ...(row.smtp_security === 'none' && current.smtp_security !== 'none'
                ? { insecure_confirmed: true }
                : {}),
            },
          });
        }
        return row;
      }),
    );
    if (patch.smtp_version !== undefined || reverify) this.mailer.forgetIdentity(current.id);
    const verification =
      reverify && updated.status === 'pending'
        ? await this.sendVerification(readScope, updated, principal, meta, { explicit: false })
        : null;
    return { identity: await this.dtoOf(readScope, updated), verification };
  }

  async remove(principal: Principal, identityId: Id<'eid'>, meta: RequestMeta): Promise<void> {
    const { identity } = await this.requireIdentity(principal, identityId);
    const context = mutationContextOf(meta, principal.userId);
    await this.db.withTx(async (tx) => {
      const scope = orgScope(identity.organization_id, tx);
      const baseIds = (await this.identities.baseIdsOf(scope, [identity.id])).get(identity.id);
      if (!(await this.identities.delete(scope, identity.id))) throw notFound();
      await this.change(tx, identity, 'email_identity.deleted', context, {
        before: snapshotOf(identity, baseIds ?? []),
      });
    });
    this.mailer.forgetIdentity(identity.id);
  }

  async disable(
    principal: Principal,
    identityId: Id<'eid'>,
    meta: RequestMeta,
  ): Promise<EmailIdentityDto> {
    return this.setEnabled(principal, identityId, false, meta);
  }

  async enable(
    principal: Principal,
    identityId: Id<'eid'>,
    meta: RequestMeta,
  ): Promise<EmailIdentityDto> {
    return this.setEnabled(principal, identityId, true, meta);
  }

  private async setEnabled(
    principal: Principal,
    identityId: Id<'eid'>,
    enabled: boolean,
    meta: RequestMeta,
  ): Promise<EmailIdentityDto> {
    const { scope: readScope, identity } = await this.requireIdentity(principal, identityId);
    const context = mutationContextOf(meta, principal.userId);
    const updated = await this.db.withTx(async (tx) => {
      const scope = orgScope(identity.organization_id, tx);
      const locked = await this.identities.findById(scope, identity.id, { forUpdate: true });
      if (locked === undefined) throw notFound();
      const disabled = locked.status === 'disabled';
      if (disabled !== enabled) return locked;
      const row = enabled
        ? await this.identities.update(scope, locked.id, {
            status: locked.status_before_disable ?? 'pending',
            status_before_disable: null,
          })
        : await this.identities.update(scope, locked.id, {
            status: 'disabled',
            status_before_disable: locked.status,
          });
      if (row === undefined) throw notFound();
      // A pending link or code must not verify a disabled identity.
      if (!enabled) await this.verifications.delete(scope, locked.id);
      await this.change(
        tx,
        row,
        enabled ? 'email_identity.enabled' : 'email_identity.disabled',
        context,
        { before: { status: locked.status }, after: { status: row.status } },
      );
      return row;
    });
    if (!enabled) this.mailer.forgetIdentity(identity.id);
    return this.dtoOf(readScope, updated);
  }

  // --- Verification ------------------------------------------------------

  /** `POST /email-identities/:id/send-verification`. */
  async resendVerification(
    principal: Principal,
    identityId: Id<'eid'>,
    meta: RequestMeta,
  ): Promise<EmailVerificationOutcome> {
    const { scope, identity } = await this.requireIdentity(principal, identityId);
    this.assertVerifiable(identity);
    if (identity.transport === 'system' && !this.mailer.instanceConfigured) {
      throw new AppError('SMTP_NOT_CONFIGURED', {
        detail: 'Email is not configured on this server (SMTP_URL, SMTP_FROM).',
      });
    }
    return this.sendVerification(scope, identity, principal, meta, { explicit: true });
  }

  /** `POST /email-identities/:id/test-and-verify` ("Test & verify", transport `smtp`). */
  async testAndVerify(
    principal: Principal,
    identityId: Id<'eid'>,
    meta: RequestMeta,
  ): Promise<EmailVerificationOutcome> {
    const { scope, identity } = await this.requireIdentity(principal, identityId);
    if (identity.transport !== 'smtp') {
      throw invalidField(
        'transport',
        'TRANSPORT_NOT_SMTP',
        'Test & verify is for identities with their own SMTP server.',
      );
    }
    this.assertVerifiable(identity);
    return this.sendVerification(scope, identity, principal, meta, { explicit: true });
  }

  /** `POST /email-identities/:id/verify-code`. */
  async verifyCode(
    principal: Principal,
    identityId: Id<'eid'>,
    code: string,
    meta: RequestMeta,
  ): Promise<EmailIdentityDto> {
    const { scope: readScope, identity } = await this.requireIdentity(principal, identityId);
    const context = mutationContextOf(meta, principal.userId);
    const outcome = await this.db.withTx(async (tx) => {
      const scope = orgScope(identity.organization_id, tx);
      const locked = await this.identities.findById(scope, identity.id, { forUpdate: true });
      if (locked === undefined) throw notFound();
      const verification = await this.verifications.findByIdentity(scope, locked.id, {
        forUpdate: true,
      });
      if (!this.isLive(verification, locked)) {
        return { error: verificationInvalid('NO_PENDING_VERIFICATION') };
      }
      if (verification.failed_attempts >= EMAIL_VERIFICATION_MAX_CODE_ATTEMPTS) {
        return { error: verificationInvalid('CODE_LOCKED') };
      }
      if (!verificationCodeMatches(this.codeKey, locked.id, code, verification.code_hash)) {
        const attempts = await this.verifications.recordFailedAttempt(scope, locked.id);
        const left = Math.max(0, EMAIL_VERIFICATION_MAX_CODE_ATTEMPTS - attempts);
        return {
          error:
            left === 0
              ? verificationInvalid('CODE_LOCKED')
              : verificationInvalid('CODE_INVALID', { attempts_left: left }),
        };
      }
      return { identity: await this.markVerified(tx, locked, 'code', context) };
    });
    // Wrong attempts are committed before the error goes out.
    if ('error' in outcome) throw outcome.error;
    this.mailer.forgetIdentity(identity.id);
    return this.dtoOf(readScope, outcome.identity);
  }

  /** `POST /email-identities/verify/preview` (public): what the link confirms. */
  async preview(token: string, meta: RequestMeta): Promise<EmailVerificationPreview> {
    await this.rateLimiter.hit(
      `email-verify:ip:${meta.ip ?? 'unknown'}`,
      EMAIL_VERIFY_IP_RATE_LIMIT,
    );
    const found = await this.findByToken(token);
    const [organization, requester] = await Promise.all([
      this.organizations.findById(found.identity.organization_id),
      found.verification.requested_by === null
        ? Promise.resolve(undefined)
        : this.users.findById(found.verification.requested_by),
    ]);
    if (organization === undefined) throw verificationInvalid('TOKEN_INVALID');
    return {
      organization_name: organization.name,
      email: found.identity.email,
      display_name: found.identity.display_name,
      requested_by: requester?.display_name ?? null,
      expires_at: iso(found.verification.expires_at),
    };
  }

  /** `POST /email-identities/verify` (public): the "Confirm" button of the page. */
  async confirm(token: string, meta: RequestMeta): Promise<EmailVerificationConfirmed> {
    await this.rateLimiter.hit(
      `email-verify:ip:${meta.ip ?? 'unknown'}`,
      EMAIL_VERIFY_IP_RATE_LIMIT,
    );
    const parsed = parseVerificationToken(token);
    if (parsed === null) throw verificationInvalid('TOKEN_INVALID');
    const context = auditContextOf(meta, { type: 'system', id: null });
    const verified = await this.db.withTx(async (tx) => {
      const scope = orgScope(parsed.organizationId, tx);
      const verification = await this.verifications.findByTokenHash(scope, parsed.tokenHash, {
        forUpdate: true,
      });
      if (verification === undefined) throw verificationInvalid('TOKEN_INVALID');
      const identity = await this.identities.findById(scope, verification.identity_id, {
        forUpdate: true,
      });
      if (identity === undefined || !this.isLive(verification, identity)) {
        throw verificationInvalid('TOKEN_INVALID');
      }
      return this.markVerified(tx, identity, 'link', context);
    });
    this.mailer.forgetIdentity(verified.id);
    return { status: 'verified', email: verified.email };
  }

  // --- Internals ---------------------------------------------------------

  private async requireIdentity(
    principal: Principal,
    identityId: Id<'eid'>,
  ): Promise<{ scope: OrgScope; identity: EmailIdentityRow }> {
    // The identity is looked up in the caller's organizations only: one of
    // another organization is `404`; a member who is not an admin is `403`.
    const memberships = await this.access.memberships(principal);
    for (const membership of memberships) {
      const scope = orgScope(membership.organizationId);
      const identity = await this.identities.findById(scope, identityId);
      if (identity === undefined) continue;
      const org = await this.access.requireOrgAdmin(principal, membership.organizationId);
      return { scope: org.scope, identity };
    }
    throw notFound();
  }

  private assertVerifiable(identity: EmailIdentityRow): void {
    if (identity.status !== 'pending' && identity.status !== 'error') {
      throw invalidField(
        'status',
        'NOT_VERIFIABLE',
        'Only pending identities and identities in error can be verified.',
      );
    }
  }

  /** The verification still applies: not expired, sent to the current address, not disabled. */
  private isLive(
    verification: EmailIdentityVerificationRow | undefined,
    identity: EmailIdentityRow,
  ): verification is EmailIdentityVerificationRow {
    return (
      verification !== undefined &&
      verification.expires_at.getTime() > Date.now() &&
      verification.email === identity.email &&
      (identity.status === 'pending' || identity.status === 'error')
    );
  }

  private async findByToken(
    token: string,
  ): Promise<{ identity: EmailIdentityRow; verification: EmailIdentityVerificationRow }> {
    const parsed = parseVerificationToken(token);
    if (parsed === null) throw verificationInvalid('TOKEN_INVALID');
    const scope = orgScope(parsed.organizationId);
    const verification = await this.verifications.findByTokenHash(scope, parsed.tokenHash);
    if (verification === undefined) throw verificationInvalid('TOKEN_INVALID');
    const identity = await this.identities.findById(scope, verification.identity_id);
    if (identity === undefined || !this.isLive(verification, identity)) {
      throw verificationInvalid('TOKEN_INVALID');
    }
    return { identity, verification };
  }

  private async markVerified(
    tx: Tx,
    identity: EmailIdentityRow,
    via: 'link' | 'code',
    context: ReturnType<typeof mutationContextOf>,
  ): Promise<EmailIdentityRow> {
    const scope = orgScope(identity.organization_id, tx);
    const row = await this.identities.update(scope, identity.id, {
      status: 'verified',
      verified_at: new Date(),
      verified_via: via,
      error_reason: null,
      auth_failures: 0,
      mode: identityModeOf(identity.transport, identity.email, this.config.mail),
    });
    if (row === undefined) throw notFound();
    await this.verifications.delete(scope, identity.id);
    // `via` only: never the token or the code.
    await this.change(tx, row, 'email_identity.verified', context, {
      before: { status: identity.status },
      after: { status: 'verified', via, mode: row.mode },
    });
    return row;
  }

  /**
   * Sends the verification email through the transport the identity uses
   * (ADR-33 §2): an identity SMTP is first connected and logged into.
   * Rate limited per identity and per organization; an SMTP failure is an
   * outcome. `explicit`: an API call asked for it (limits and missing SMTP
   * are errors) rather than a create/change (they are outcomes).
   */
  private async sendVerification(
    readScope: OrgScope,
    identity: EmailIdentityRow,
    principal: Principal,
    meta: RequestMeta,
    options: { readonly explicit: boolean },
  ): Promise<EmailVerificationOutcome> {
    const organizationId = identity.organization_id;
    try {
      await this.rateLimiter.hit(`email-verify:identity:${identity.id}`, {
        limit: EMAIL_VERIFICATION_SENDS_PER_HOUR_PER_IDENTITY,
        windowSeconds: HOUR_SECONDS,
      });
      await this.rateLimiter.hit(`email-verify:org:${organizationId}`, {
        limit: EMAIL_VERIFICATION_SENDS_PER_DAY_PER_ORG,
        windowSeconds: DAY_SECONDS,
      });
    } catch (error) {
      if (options.explicit || !(error instanceof AppError) || error.code !== 'RATE_LIMITED') {
        throw error;
      }
      return { status: 'rate_limited', retry_after_seconds: error.retryAfterSeconds ?? 60 };
    }

    const organization = await this.organizations.findById(organizationId);
    const locale = localeOf(organization?.settings) ?? principal.user.locale ?? null;
    const issued = issueVerification(this.codeKey, organizationId, identity.id);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
    await this.verifications.issue(readScope, {
      identityId: identity.id,
      email: identity.email,
      tokenHash: issued.tokenHash,
      codeHash: issued.codeHash,
      requestedBy: principal.userId,
      expiresAt,
    });

    // Never the unverified display name in a header (T528, QA S5 M7).
    const headers = verificationSenderOf(identity);
    const transport = identityTransportOf(identity, this.smtpKey);
    let outcome: EmailVerificationOutcome;
    let sending = false;
    try {
      if (transport.kind === 'identity') await this.mailer.verify(transport);
      sending = true;
      const sent = await this.mailer.send({
        ...senderVerificationEmail({
          locale,
          displayName: identity.display_name,
          address: identity.email,
          verifyUrl: verifySenderUrlOf(this.config.publicUrl, issued.token),
          code: issued.code,
          expiresAt,
        }),
        ...(headers.from === undefined ? {} : { from: headers.from }),
        replyTo: headers.replyTo,
        transport,
        origin: { kind: 'system' },
      });
      outcome = { status: 'sent', to: identity.email, expires_at: iso(expiresAt), smtp: sent.smtp };
    } catch (error) {
      if (!isEmailSendError(error)) throw error;
      // No SMTP configured is a known state (the demo seed, an instance
      // without email yet): the answer and the audit say so, nothing failed
      // that an operator must look at (T527). Real send failures stay warnings.
      const log = { ...error.toLog(), organization_id: organizationId, identity_id: identity.id };
      if (error.code === 'smtp_not_configured') {
        this.logger.info(log, 'sender identity verification email not sent: no SMTP configured');
      } else {
        this.logger.warn(log, 'sender identity verification email failed');
      }
      outcome = {
        status: 'failed',
        step: stepOf(error, sending),
        code: error.code,
        reason: error.reason,
        smtp: error.smtp ?? { code: null, enhanced: null },
      };
      // A link nobody received must not stay usable.
      await this.verifications.delete(readScope, identity.id);
    }

    const after: JsonObject =
      outcome.status === 'sent'
        ? { transport: identity.transport, status: 'sent', smtp_code: outcome.smtp.code }
        : {
            transport: identity.transport,
            status: 'failed',
            step: outcome.step,
            code: outcome.code,
            reason: outcome.reason,
            smtp_code: outcome.smtp.code,
          };
    await this.db.withTx((tx) =>
      this.change(
        tx,
        identity,
        'email_identity.verification_sent',
        mutationContextOf(meta, principal.userId),
        {
          after,
        },
      ),
    );
    return outcome;
  }

  private change(
    tx: Tx,
    identity: EmailIdentityRow,
    type:
      | 'email_identity.created'
      | 'email_identity.verification_sent'
      | 'email_identity.verified'
      | 'email_identity.updated'
      | 'email_identity.credentials_changed'
      | 'email_identity.disabled'
      | 'email_identity.enabled'
      | 'email_identity.deleted',
    context: ReturnType<typeof mutationContextOf>,
    values: { readonly before?: JsonObject; readonly after?: JsonObject },
  ): Promise<void> {
    const data: Record<string, JsonValue> = {
      transport: identity.transport,
      status: identity.status,
    };
    return recordChange(tx, {
      type,
      organizationId: identity.organization_id,
      entityType: 'email_identity',
      entityId: identity.id,
      context,
      before: values.before ?? null,
      after: values.after ?? null,
      data,
    });
  }

  /** Maps the unique `(organization_id, email)` violation to `EMAIL_TAKEN`. */
  private async uniqueEmail<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (sqlStateOf(error) === SQLSTATE.uniqueViolation) {
        throw invalidField('email', 'EMAIL_TAKEN', 'Another sender identity has this address.');
      }
      throw error;
    }
  }

  /** Whether `password` is the stored one (a key that cannot unseal it counts as changed). */
  private samePassword(sealed: string | null, password: string): boolean {
    if (sealed === null) return false;
    try {
      return unsealSecret(this.smtpKey, sealed) === password;
    } catch {
      return false;
    }
  }

  private addressOf(value: string, path: string): string {
    const address = normalizeAddress(value);
    if (address === null) throw invalidField(path, 'INVALID_EMAIL', 'Not a valid email address.');
    return address.toLowerCase();
  }

  private displayNameOf(value: string): string {
    const name = sanitizeHeaderText(value, 100);
    if (name === '') throw invalidField('display_name', 'TOO_SMALL', 'The name is required.');
    return name;
  }

  private async assertBases(scope: OrgScope, baseIds: readonly Id<'bse'>[]): Promise<void> {
    const existing = await this.identities.existingBaseIds(scope, baseIds);
    const errors = baseIds.flatMap((baseId, index): ProblemErrorItem[] =>
      existing.has(baseId)
        ? []
        : [{ path: `base_ids[${String(index)}]`, code: 'UNKNOWN_BASE', message: 'Unknown base.' }],
    );
    if (errors.length > 0) throw invalid('Some bases do not exist.', errors);
  }

  /**
   * Validated and sealed SMTP settings. The host is resolved now (and again
   * on every connection); `security = none` needs `allow_insecure: true`
   * when it is newly chosen.
   */
  private async smtpSettingsOf(
    input: NonNullable<CreateEmailIdentityInput['smtp']>,
    current: SmtpSettings | null,
  ): Promise<SmtpSettings> {
    const host = normalizeSmtpHost(input.host);
    if (host === null) {
      throw invalidField('smtp.host', 'INVALID_FORMAT', 'Not a host name or IP address.');
    }
    try {
      await resolveAllowedSmtpHost(host, { allowPrivate: this.config.email.allowPrivateSmtpHosts });
    } catch (error) {
      if (!(error instanceof SmtpHostError)) throw error;
      throw error.problem === 'unresolvable'
        ? invalidField('smtp.host', 'HOST_UNRESOLVABLE', 'The SMTP host could not be resolved.')
        : invalidField(
            'smtp.host',
            'HOST_NOT_ALLOWED',
            'The SMTP host resolves to a private, loopback, link-local or metadata address.',
          );
    }
    if (
      input.security === 'none' &&
      current?.smtp_security !== 'none' &&
      input.allow_insecure !== true
    ) {
      throw invalidField(
        'smtp.allow_insecure',
        'INSECURE_NOT_CONFIRMED',
        'An SMTP connection without TLS must be confirmed with allow_insecure.',
      );
    }
    return {
      smtp_host: host,
      smtp_port: input.port,
      smtp_security: input.security,
      smtp_username: input.username,
      smtp_password_enc:
        input.password === undefined
          ? (current?.smtp_password_enc ?? null)
          : sealSecret(this.smtpKey, input.password),
    };
  }

  private async dtoOf(scope: OrgScope, identity: EmailIdentityRow): Promise<EmailIdentityDto> {
    const [dto] = await this.dtosOf(scope, [identity]);
    if (dto === undefined) throw notFound();
    return dto;
  }

  private async dtosOf(
    scope: OrgScope,
    rows: readonly EmailIdentityRow[],
  ): Promise<EmailIdentityDto[]> {
    const ids = rows.map((row) => row.id);
    const [bases, verifications, organization] = await Promise.all([
      this.identities.baseIdsOf(scope, ids),
      this.verifications.findByIdentities(scope, ids),
      this.organizations.findById(scope.organizationId),
    ]);
    const locale = localeOf(organization?.settings);
    const mail = this.config.mail;
    return rows.map((row): EmailIdentityDto => {
      const verification = verifications.get(row.id);
      const live = this.isLive(verification, row);
      return {
        id: row.id,
        organization_id: row.organization_id,
        email: row.email,
        display_name: row.display_name,
        // Names saved before T540 are flagged on read, never rewritten.
        display_name_issue: displayNameIssueOf(row.display_name),
        reply_to: row.reply_to,
        transport: row.transport,
        mode: identityModeOf(row.transport, row.email, mail),
        status: row.status,
        error_reason: row.error_reason,
        verified_at: isoOrNull(row.verified_at),
        verified_via: row.verified_via,
        base_scope: row.base_scope,
        base_ids: row.base_scope === 'selected' ? (bases.get(row.id) ?? []) : [],
        signature_md: row.signature_md,
        smtp:
          row.smtp_host === null ||
          row.smtp_port === null ||
          row.smtp_security === null ||
          row.smtp_username === null
            ? null
            : {
                host: row.smtp_host,
                port: row.smtp_port,
                security: row.smtp_security,
                username: row.smtp_username,
                password_set: true,
              },
        display: senderDisplayOf(row, mail, locale),
        hints: identityHintsOf(row, mail),
        verification: {
          pending: live,
          sent_at: live ? iso(verification.created_at) : null,
          expires_at: live ? iso(verification.expires_at) : null,
          code_attempts_left: live
            ? Math.max(0, EMAIL_VERIFICATION_MAX_CODE_ATTEMPTS - verification.failed_attempts)
            : null,
        },
        created_by: row.created_by,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
      };
    });
  }
}
