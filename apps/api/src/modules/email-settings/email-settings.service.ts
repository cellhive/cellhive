import {
  AuditWriter,
  connectionTestEmail,
  isEmailSendError,
  OrganizationsRepository,
  type AppConfig,
  type Db,
  type EmailQuota,
  type EmailSendError,
  type JsonObject,
  type Mailer,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound } from '../../common/access/access.service.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { cacheUnavailable, RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG, DB, EMAIL_QUOTA, MAILER } from '../../common/tokens.js';

import { OrgEmailSettingsService } from './org-email-settings.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type {
  EmailSettingsDto,
  EmailTestResult,
  Id,
  UpdateEmailSettingsRequest,
} from '@cellhive/contracts';

const audit = new AuditWriter();

/**
 * `/orgs/:orgId/email-settings` (CONTRACTS §23, BACKLOG T513): read-only
 * status of the instance SMTP and the "Test connection" email to the
 * caller; the automation email settings of the organization (T531,
 * `OrgEmailSettingsService`). Organization owner/admin only (others `403`,
 * non-members `404`). Never returns the SMTP password, user or full URL.
 */
@Injectable()
export class EmailSettingsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(MAILER) private readonly mailer: Mailer | null,
    @Inject(EMAIL_QUOTA) private readonly quota: EmailQuota,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(OrgEmailSettingsService) private readonly orgSettings: OrgEmailSettingsService,
  ) {}

  async get(principal: Principal, organizationId: Id<'org'>): Promise<EmailSettingsDto> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const organization = await this.organizations.findById(organizationId);
    if (organization === undefined) throw notFound();
    const automation = await this.orgSettings.view(org.scope, organization.settings);
    const mail = this.config.mail;
    const instance = this.mailer?.instance ?? null;
    let usage: { used: number; resetsAt: Date };
    try {
      usage = await this.quota.used(organizationId);
    } catch (error) {
      throw cacheUnavailable(error);
    }
    return {
      smtp: {
        configured: mail !== null,
        host: instance?.host ?? null,
        port: instance?.port ?? null,
        security: instance?.security ?? null,
        from: mail?.fromAddress ?? null,
        from_name: mail?.fromName ?? null,
        allowed_from_domains: mail === null ? [] : [...mail.allowedFromDomains],
      },
      limits: {
        max_per_hour_per_org: this.config.email.maxPerHourPerOrg,
        max_recipients: this.config.email.maxRecipients,
        max_per_second_per_process: this.config.email.maxPerSecond,
        test_sends_per_minute: this.config.email.testSendsPerMinute,
        max_html_bytes: this.config.email.maxHtmlBytes,
        max_attachments: this.config.email.maxAttachments,
        max_attachment_bytes: this.config.email.maxAttachmentBytes,
        max_inline_images: this.config.email.maxInlineImages,
      },
      usage: { sent_this_hour: usage.used, resets_at: usage.resetsAt.toISOString() },
      automation,
    };
  }

  /**
   * Footer policy, default signature, system sender (T531) and attachment
   * limits (T532) of automation emails; returns the settings as `get`
   * does. Owner/admin only.
   */
  async update(
    principal: Principal,
    organizationId: Id<'org'>,
    body: UpdateEmailSettingsRequest,
    meta: RequestMeta,
  ): Promise<EmailSettingsDto> {
    await this.access.requireOrgAdmin(principal, organizationId);
    await this.orgSettings.update(organizationId, principal.userId, body, meta);
    return this.get(principal, organizationId);
  }

  /**
   * Connects, authenticates and sends one fixed test email to the caller's
   * own address. SMTP failures are a result (`status: failed` with the
   * classified code), not an error response. Audited as `email.test_sent`
   * without content or address.
   */
  async test(
    principal: Principal,
    organizationId: Id<'org'>,
    meta: RequestMeta,
  ): Promise<EmailTestResult> {
    await this.access.requireOrgAdmin(principal, organizationId);
    const mailer = this.mailer;
    if (mailer === null) {
      throw new AppError('SMTP_NOT_CONFIGURED', {
        detail: 'Email is not configured on this server (SMTP_URL, SMTP_FROM).',
      });
    }
    await this.rateLimiter.hit(`email-test:${principal.userId}`, {
      limit: this.config.email.testSendsPerMinute,
      windowSeconds: 60,
    });
    const organization = await this.organizations.findById(organizationId);
    if (organization === undefined) throw notFound();

    let result: EmailTestResult;
    try {
      await mailer.verify();
      const sent = await mailer.send({
        ...connectionTestEmail(principal.user.email, {
          locale: principal.user.locale ?? this.localeOf(organization.settings),
          organizationName: organization.name,
          sentAt: new Date(),
        }),
        origin: { kind: 'system' },
      });
      result = {
        status: 'sent',
        to: principal.user.email,
        message_id: sent.messageId,
        smtp: sent.smtp,
      };
    } catch (error) {
      if (!isEmailSendError(error)) throw error;
      result = this.failed(error);
      this.logger.warn({ ...error.toLog(), organization_id: organizationId }, 'email test failed');
    }

    const after: JsonObject =
      result.status === 'sent'
        ? { status: 'sent', smtp_code: result.smtp.code }
        : {
            status: 'failed',
            code: result.code,
            reason: result.reason,
            smtp_code: result.smtp.code,
          };
    await this.db.withTx((tx) =>
      audit.write(tx, {
        action: 'email.test_sent',
        organizationId,
        baseId: null,
        entityType: 'org',
        entityId: organizationId,
        after,
        context: auditContextOf(meta, { type: 'user', id: principal.userId }),
      }),
    );
    return result;
  }

  private failed(error: EmailSendError): EmailTestResult {
    return {
      status: 'failed',
      code: error.code === 'smtp_temporary' ? 'smtp_temporary' : 'smtp_rejected',
      reason: error.reason ?? 'rejected',
      smtp: error.smtp ?? { code: null, enhanced: null },
    };
  }

  private localeOf(settings: unknown): string | null {
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null;
    const locale = (settings as Record<string, unknown>)['locale'];
    return typeof locale === 'string' ? locale : null;
  }
}
