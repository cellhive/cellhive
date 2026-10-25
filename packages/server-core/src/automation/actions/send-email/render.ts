import { Buffer } from 'node:buffer';

import { TEMPLATE_OUTPUT_LIMITS, type Id, type SendEmailConfig } from '@cellhive/contracts';

import { deriveSecretKey } from '../../../auth/secret-box.js';
import { normalizeRecipients, type NormalizedRecipients } from '../../../mail/address.js';
import {
  automationEmailImages,
  composeAutomationEmail,
  signatureSourceOf,
  type ComposedAutomationEmail,
} from '../../../mail/automation-email/compose.js';
import { EmailIdentitiesRepository } from '../../../mail/identities/email-identities.repository.js';
import { resolveSender, type ResolvedSender } from '../../../mail/identities/sender.js';
import {
  effectiveAttachmentLimits,
  orgEmailSettingsOf,
  type EmailAttachmentLimits,
} from '../../../mail/settings/org-email-settings.js';

import { messageByteLimit, type AttachmentPlan } from './attachments/plan.js';
import { EmailAttachmentResolver } from './attachments/resolve.js';
import { InlineImageResolver } from './inline-images.js';
import { RecipientMembersRepository } from './recipient-members.repository.js';
import { collectRecipients, userIdsOf, type RecipientParts } from './recipients.js';

import type { AppConfig } from '../../../config/load-config.js';
import type { Db } from '../../../db/create-db.js';
import type { OrgScope } from '../../../db/repository.js';
import type { JsonValue } from '../../../db/schema.js';
import type { FooterAutomation } from '../../../mail/footer/footer.js';
import type { InlineImageSet, InlineImageTranscoder } from '../../../mail/images/inline-images.js';
import type { MailAddress } from '../../../mail/mailer.js';
import type { StorageDriver } from '../../../storage/storage-driver.js';
import type { AutomationValidationContext } from '../../definition/validate.js';
import type { AutomationValueEvaluator, TemplateWarning } from '../../values/evaluator.js';

/**
 * Renders one `send_email` step (BACKLOG T514, ADR-32 §3, ADR-33): the
 * sender (`resolveSender`, checked again now), Reply-To, recipients, the
 * subject (one header line, ≤ 255) and the body (narrow Markdown parsed
 * first, values as text nodes, signature, footer, fixed layout —
 * `composeAutomationEmail`). Values are read through `values`: the run's
 * evaluator (`run_as` now) or the preview's (the editor). Shared by the
 * action handler, the preview and "Send a test to me", so all three show
 * the same email.
 */

export type SendEmailConfigSource = Pick<AppConfig, 'mail' | 'email' | 'publicUrl' | 'security'>;

export interface SendEmailRenderInput {
  readonly scope: OrgScope;
  readonly config: SendEmailConfig;
  readonly values: AutomationValueEvaluator;
  readonly organization: { readonly name: string; readonly settings: JsonValue };
  /** The organization's locale (footer, `(via Cellhive)`). */
  readonly locale: string;
  /** Automation and base (ids always; names only shown by the `full` footer). */
  readonly automation: FooterAutomation;
  /** The person behind `reply_to: { run_as: true }`. */
  readonly runAsUserId: Id<'usr'>;
  /**
   * Where the attachments come from (T532): the schema and access of the
   * person `values` reads as, the trigger table and record.
   */
  readonly attachmentSource: {
    readonly schema: AutomationValidationContext;
    readonly tableId: Id<'tbl'> | null;
    readonly recordId: string | null;
  };
}

export interface RenderedRecipients extends NormalizedRecipients {
  /** Cellhive users among the recipients (active members only). */
  readonly userIds: readonly Id<'usr'>[];
  /** Users named by a value who are not active members (left out). */
  readonly droppedUsers: number;
}

export interface RenderedAutomationEmail {
  readonly sender: ResolvedSender;
  readonly from: MailAddress | undefined;
  readonly replyTo: readonly MailAddress[];
  readonly recipients: RenderedRecipients;
  readonly email: ComposedAutomationEmail;
  readonly warnings: readonly TemplateWarning[];
  /**
   * The files to attach, or why the step cannot send (T532): the action
   * fails the step, the preview warns, the test send refuses. Also fails
   * when the inline images (T534) are above `EMAIL_MAX_INLINE_IMAGES`
   * (`too_many_attachments`, `params.scope = inline_images`) or, with the
   * files, above the byte limit.
   */
  readonly attachments: AttachmentPlan;
  /** Inline images of the HTML (T534): sent as `cid:` parts. */
  readonly images: InlineImageSet;
  /** Attachment limits in force for the organization. */
  readonly attachmentLimits: EmailAttachmentLimits;
}

export type SendEmailRenderFailureCode =
  'email_identity_unavailable' | 'email_identity_auth_failed' | 'email_body_too_large';

export type SendEmailRenderResult =
  | { readonly ok: true; readonly rendered: RenderedAutomationEmail }
  | {
      readonly ok: false;
      readonly code: SendEmailRenderFailureCode;
      readonly params: Readonly<Record<string, unknown>>;
    };

/** Most Reply-To addresses taken from a `user` field. */
const MAX_REPLY_TO = 10;

export class SendEmailRenderer {
  private readonly identities: EmailIdentitiesRepository;
  private readonly members: RecipientMembersRepository;
  private readonly files: EmailAttachmentResolver;
  private readonly inlineImages: InlineImageResolver;
  private readonly smtpKey: Buffer;

  /** `storage` + `transcode` read and re-encode the thumbnails of field images (T534); without them they are left out. */
  constructor(
    db: Db,
    private readonly config: SendEmailConfigSource,
    storage: Pick<StorageDriver, 'getStream'> | null = null,
    transcode: InlineImageTranscoder | null = null,
  ) {
    this.identities = new EmailIdentitiesRepository(db);
    this.members = new RecipientMembersRepository(db);
    this.files = new EmailAttachmentResolver(db);
    this.inlineImages = new InlineImageResolver(db, storage, transcode);
    this.smtpKey = deriveSecretKey(config.security.appMasterKey, 'email-identity-smtp');
  }

  async render(input: SendEmailRenderInput): Promise<SendEmailRenderResult> {
    const { scope, config, values } = input;
    const orgSettings = orgEmailSettingsOf(input.organization.settings);
    const resolved = await resolveSender(
      { identities: this.identities, mail: this.config.mail, smtpKey: this.smtpKey },
      scope,
      {
        identityId: config.identity_id,
        baseId: input.automation.baseId as Id<'bse'>,
        locale: input.locale,
        systemSenderEnabled: orgSettings.systemSenderEnabled,
      },
    );
    if (!resolved.ok) return this.senderFailure(scope, config.identity_id);
    const sender = resolved.sender;

    const replyTo = await this.replyToOf(input, sender);
    if (replyTo === null) {
      return { ok: false, code: 'email_identity_unavailable', params: { part: 'reply_to' } };
    }

    const warnings: TemplateWarning[] = [];
    const recipients = await this.recipientsOf(input);
    warnings.push(...recipients.warnings);

    const subject = await values.renderTemplate(config.subject.template, {
      context: 'header',
      maxLength: TEMPLATE_OUTPUT_LIMITS.email_subject,
    });
    warnings.push(...subject.warnings);
    let digest: string | undefined;
    if (config.body.digest !== null) {
      const lines = await values.renderDigest(config.body.digest, { context: 'plain' });
      warnings.push(...lines.warnings);
      digest = lines.text;
    }
    const placeholders = await values.placeholderValues(
      config.body.template,
      digest === undefined ? {} : { digest },
    );
    warnings.push(...placeholders.warnings);

    // Inline images (T534) of the template source and the signature, as this person now.
    const images = await this.inlineImages.resolve({
      scope,
      images: automationEmailImages(
        config.body.template,
        signatureSourceOf(sender, orgSettings, config.include_signature),
      ),
      automationId: input.automation.id as Id<'aut'>,
      schema: input.attachmentSource.schema,
      tableId: input.attachmentSource.tableId,
      recordId: input.attachmentSource.recordId,
      values,
    });
    warnings.push(...images.warnings);

    const composed = composeAutomationEmail({
      subject: subject.text,
      body: { template: config.body.template, values: placeholders.values },
      sender,
      orgSettings,
      instanceFooterPolicy: this.config.email.automationFooter,
      footer: config.footer,
      includeSignature: config.include_signature,
      locale: input.locale,
      organizationName: input.organization.name,
      publicUrl: this.config.publicUrl,
      automation: input.automation,
      maxHtmlBytes: this.config.email.maxHtmlBytes,
      images: { body: images.resolver('body'), signature: images.resolver('signature') },
    });
    if (!composed.ok) {
      return { ok: false, code: composed.code, params: { html_bytes: composed.htmlBytes } };
    }
    const email = this.config.email;
    const attachmentLimits = effectiveAttachmentLimits(email, orgSettings);
    const imageCount = images.files.length;
    const attachments: AttachmentPlan =
      imageCount > email.maxInlineImages
        ? {
            ok: false,
            code: 'too_many_attachments',
            params: { scope: 'inline_images', count: imageCount, limit: email.maxInlineImages },
          }
        : await this.files.resolve({
            scope,
            config,
            schema: input.attachmentSource.schema,
            tableId: input.attachmentSource.tableId,
            recordId: input.attachmentSource.recordId,
            values,
            limits: attachmentLimits,
            messageLimit: messageByteLimit(email),
            bodyBytes: composed.email.htmlBytes + Buffer.byteLength(composed.email.text, 'utf8'),
            inlineBytes: images.bytes,
          });
    return {
      ok: true,
      rendered: {
        sender,
        from: this.fromOf(sender, input.organization.name),
        replyTo,
        recipients: recipients.normalized,
        email: composed.email,
        warnings: dedupe(warnings),
        attachments,
        attachmentLimits,
        images,
      },
    };
  }

  /**
   * `From` (ADR-33 §1): the identity's (its mode), or `SMTP_FROM` with the
   * organization's name for the system sender ("the system sender uses the
   * organization name").
   */
  private fromOf(sender: ResolvedSender, organizationName: string): MailAddress | undefined {
    if (sender.identityId !== null || this.config.mail === null) return sender.from;
    return { address: this.config.mail.fromAddress, name: organizationName };
  }

  /** Why the sender is not usable: an identity in `error` failed to authenticate. */
  private async senderFailure(
    scope: OrgScope,
    identityId: Id<'eid'> | null,
  ): Promise<SendEmailRenderResult> {
    if (identityId !== null) {
      const identity = await this.identities.findById(scope, identityId);
      if (identity?.status === 'error') {
        return {
          ok: false,
          code: 'email_identity_auth_failed',
          params: { reason: identity.error_reason ?? 'auth_failed' },
        };
      }
    }
    return { ok: false, code: 'email_identity_unavailable', params: { part: 'sender' } };
  }

  /**
   * Reply-To of the action, else the sender's (ADR-33 §1): a verified
   * identity of the base scope (`null` = not usable: the step fails), or the
   * account email of Cellhive users who are active members (none → the
   * sender's Reply-To).
   */
  private async replyToOf(
    input: SendEmailRenderInput,
    sender: ResolvedSender,
  ): Promise<readonly MailAddress[] | null> {
    const choice = input.config.reply_to;
    if (choice === null) return sender.replyTo;
    if ('identity_id' in choice) {
      const identity = await this.identities.findUsable(
        input.scope,
        choice.identity_id,
        input.automation.baseId as Id<'bse'>,
      );
      if (identity === undefined) return null;
      return [{ address: identity.email, name: identity.display_name }];
    }
    let userIds: Id<'usr'>[];
    if ('run_as' in choice) userIds = [input.runAsUserId];
    else {
      const resolved = await input.values.resolve(
        'field' in choice ? { field: choice.field } : { trigger: 'clicked_by' },
      );
      userIds = userIdsOf(resolved.value);
    }
    const members = await this.members.activeMembers(input.scope, userIds);
    const addresses = [...new Set(userIds)]
      .map((id) => members.get(id))
      .filter((member) => member !== undefined)
      .slice(0, MAX_REPLY_TO)
      .map((member) => ({ address: member.email, name: member.displayName }));
    return addresses.length === 0 ? sender.replyTo : addresses;
  }

  private async recipientsOf(input: SendEmailRenderInput): Promise<{
    normalized: RenderedRecipients;
    warnings: readonly TemplateWarning[];
  }> {
    const found = await collectRecipients(input.config, (value) => input.values.resolve(value));
    const allUsers = [...found.to.userIds, ...found.cc.userIds, ...found.bcc.userIds];
    const members = await this.members.activeMembers(input.scope, allUsers);
    const emailsOf = (parts: RecipientParts): string[] => [
      ...parts.addresses,
      ...parts.userIds.flatMap((id) => {
        const member = members.get(id);
        return member === undefined ? [] : [member.email];
      }),
    ];
    const normalized = normalizeRecipients({
      to: emailsOf(found.to),
      cc: emailsOf(found.cc),
      bcc: emailsOf(found.bcc),
    });
    const unique = new Set(allUsers);
    return {
      normalized: {
        ...normalized,
        userIds: [...unique].filter((id) => members.has(id)),
        droppedUsers: [...unique].filter((id) => !members.has(id)).length,
      },
      warnings: found.warnings,
    };
  }
}

function dedupe(warnings: readonly TemplateWarning[]): TemplateWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}|${String(warning.placeholder ?? '')}|${warning.field_id ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
