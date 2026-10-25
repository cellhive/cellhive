import {
  checkSignatureAssets,
  effectiveAttachmentLimits,
  EmailAssetsRepository,
  footerNoneAllowedByPolicy,
  orgEmailSettingsJson,
  orgEmailSettingsOf,
  OrganizationsRepository,
  orgScope,
  signatureInput,
  SystemSenderUsageRepository,
  type AppConfig,
  type Db,
  type JsonObject,
  type JsonValue,
  type OrgEmailSettings,
  type OrgScope,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { notFound } from '../../common/access/access.service.js';
import { diffOf, mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import type { RequestMeta } from '../../common/auth/request-meta.js';
import type {
  AutomationEmailSettingsDto,
  Id,
  UpdateEmailSettingsRequest,
} from '@cellhive/contracts';

function objectOf(value: JsonValue): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * Automation email settings of an organization (BACKLOG T531, ADR-33):
 * `organizations.settings.email { footer_policy, default_signature_md,
 * system_sender_enabled, max_attachments, max_attachment_bytes }` (T532:
 * attachment limits ≤ the instance caps, `null` = the caps). The callers check that the principal is an
 * owner/admin of the organization. Changes are `org.updated` (event +
 * audit with before/after of the email settings, no secret).
 */
@Injectable()
export class OrgEmailSettingsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(SystemSenderUsageRepository) private readonly usage: SystemSenderUsageRepository,
    @Inject(EmailAssetsRepository) private readonly assets: EmailAssetsRepository,
  ) {}

  /** The settings as returned by `GET /orgs/:orgId/email-settings` (`automation`). */
  async view(scope: OrgScope, settings: JsonValue): Promise<AutomationEmailSettingsDto> {
    const email = orgEmailSettingsOf(settings);
    const usage = await this.usage.count(scope);
    const instancePolicy = this.config.email.automationFooter;
    const limits = effectiveAttachmentLimits(this.config.email, email);
    return {
      instance_footer_policy: instancePolicy,
      footer_policy: email.footerPolicy,
      footer_none_allowed: footerNoneAllowedByPolicy({
        instancePolicy,
        orgPolicy: email.footerPolicy,
      }),
      default_signature_md: email.defaultSignatureMd,
      system_sender_enabled: email.systemSenderEnabled,
      max_attachments: limits.maxAttachments,
      max_attachment_bytes: limits.maxAttachmentBytes,
      attachment_limits_custom: email.maxAttachments !== null || email.maxAttachmentBytes !== null,
      system_sender_usage: {
        automations: usage.automations,
        enabled_automations: usage.enabledAutomations,
      },
    };
  }

  /**
   * Organization attachment limits never above the instance caps
   * (`EMAIL_MAX_ATTACHMENTS`, `EMAIL_MAX_ATTACHMENT_BYTES`): `422
   * VALIDATION_FAILED` / `TOO_BIG` with `params.maximum` (T532).
   */
  private checkAttachmentLimits(body: UpdateEmailSettingsRequest): void {
    const caps = [
      ['max_attachments', body.max_attachments, this.config.email.maxAttachments],
      ['max_attachment_bytes', body.max_attachment_bytes, this.config.email.maxAttachmentBytes],
    ] as const;
    const errors = caps
      .filter(([, value, cap]) => typeof value === 'number' && value > cap)
      .map(([path, , cap]) => ({
        path,
        code: 'TOO_BIG',
        message: `At most ${String(cap)} (limit of this server)`,
        params: { maximum: cap },
      }));
    if (errors.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'An attachment limit is above the limit of this server.',
        errors,
      });
    }
  }

  /**
   * Applies `body` to `settings.email` (other settings untouched, row
   * locked while it is rewritten). `footer_policy` may be stored while
   * `EMAIL_AUTOMATION_FOOTER=required`; it only takes effect with `org`.
   */
  async update(
    organizationId: Id<'org'>,
    userId: Id<'usr'>,
    body: UpdateEmailSettingsRequest,
    meta: RequestMeta,
  ): Promise<void> {
    const signature =
      body.default_signature_md === undefined
        ? undefined
        : signatureInput(body.default_signature_md, 'default_signature_md');
    if (signature !== undefined) {
      // Images must be signature assets of this organization (T534).
      await checkSignatureAssets(
        this.assets,
        orgScope(organizationId),
        signature,
        'default_signature_md',
      );
    }
    this.checkAttachmentLimits(body);
    await this.db.withTx(async (tx) => {
      const current = await this.organizations.lockById(organizationId, tx);
      if (current === undefined) throw notFound();
      const settings = objectOf(current.settings);
      const before = orgEmailSettingsOf(current.settings);
      const next: OrgEmailSettings = {
        footerPolicy: body.footer_policy ?? before.footerPolicy,
        defaultSignatureMd: signature === undefined ? before.defaultSignatureMd : signature,
        systemSenderEnabled: body.system_sender_enabled ?? before.systemSenderEnabled,
        maxAttachments:
          body.max_attachments === undefined ? before.maxAttachments : body.max_attachments,
        maxAttachmentBytes:
          body.max_attachment_bytes === undefined
            ? before.maxAttachmentBytes
            : body.max_attachment_bytes,
      };
      const beforeJson = orgEmailSettingsJson(before);
      const afterJson = orgEmailSettingsJson(next);
      const changes = diffOf(beforeJson, afterJson);
      if (Object.keys(changes).length === 0) return;
      await this.organizations.update(
        organizationId,
        { settings: { ...settings, email: afterJson } },
        tx,
      );
      await recordChange(tx, {
        type: 'org.updated',
        organizationId,
        entityType: 'org',
        entityId: organizationId,
        context: mutationContextOf(meta, userId),
        before: { settings: { email: beforeJson } },
        after: { settings: { email: afterJson } },
        changes: Object.fromEntries(
          Object.entries(changes).map(([key, change]) => [`settings.email.${key}`, change]),
        ),
      });
    });
  }
}
