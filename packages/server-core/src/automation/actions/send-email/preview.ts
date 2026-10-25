import { randomUUID } from 'node:crypto';

import {
  canonicalTimeZone,
  ATTACHMENT_DOWNLOAD_URL_SECONDS,
  ATTACHMENTS_UNAVAILABLE,
  automationDefinitionSchema,
  isTemplateReferenceId,
  type AutomationAction,
  type AutomationBranchAction,
  type AutomationDefinition,
  type AutomationEmailPreview,
  type AutomationEmailTestResult,
  type AutomationTrigger,
  type Id,
  type ProblemErrorItem,
  type SendEmailConfig,
  type SendEmailWarning,
} from '@cellhive/contracts';

import { AuditWriter } from '../../../audit/audit-writer.js';
import { AppError } from '../../../errors/app-error.js';
import {
  loadMemberAccessBase,
  resolveMemberBaseAccess,
  type AccessDefaults,
  type MemberAccessBase,
  type MemberBaseAccess,
} from '../../../import/member-access.js';
import { domainOf, maskAddress, sanitizeHeaderText } from '../../../mail/address.js';
import { deterministicMessageId } from '../../../mail/headers.js';
import { EmailIdentitiesRepository } from '../../../mail/identities/email-identities.repository.js';
import { recordIdentitySendOutcome } from '../../../mail/identities/send-outcome.js';
import { orgEmailSettingsOf } from '../../../mail/settings/org-email-settings.js';
import { isEmailSendError } from '../../../mail/smtp-errors.js';
import { mailLocaleOf } from '../../../mail/templates.js';
import { flattenActions, validateAutomationDefinition } from '../../definition/validate.js';
import { loadAutomationSchema } from '../../engine/schema-context.js';
import { checkAutomationTemplate } from '../../values/check.js';
import { AutomationValueEvaluator } from '../../values/evaluator.js';
import { recordQueryReader } from '../../values/record-reader.js';
import { previousSourceOf, TRIGGER_REFERENCES } from '../../values/references.js';
import { automationSnapshot } from '../../values/snapshot.js';

import { attachmentParts, destroyAttachmentParts, inlineImageParts } from './attachments/stream.js';
import { RecipientMembersRepository } from './recipient-members.repository.js';
import {
  SendEmailRenderer,
  type RenderedAutomationEmail,
  type SendEmailConfigSource,
} from './render.js';
import { checkSendEmailSender } from './sender-check.js';

import type { AuditContext } from '../../../audit/audit-entry.js';
import type { AppConfig } from '../../../config/load-config.js';
import type { Db } from '../../../db/create-db.js';
import type { OrgScope } from '../../../db/repository.js';
import type { JsonValue } from '../../../db/schema.js';
import type { InlineImageTranscoder } from '../../../mail/images/inline-images.js';
import type { MailAddress, Mailer } from '../../../mail/mailer.js';
import type { RecordQueryService } from '../../../records/record-query.service.js';
import type { StorageDriver } from '../../../storage/storage-driver.js';
import type { AutomationValidationContext } from '../../definition/validate.js';

/**
 * Preview and "Send a test to me" of a `send_email` step (BACKLOG T514,
 * ADR-32 §3, CONTRACTS §21). The email is rendered exactly like a run
 * (`SendEmailRenderer`) but with the permissions of the **person editing**
 * (who becomes `run_as` when they save), on a record of the trigger table
 * they read: a field they cannot read stays empty even when the current
 * `run_as` could read it. Earlier steps do not run (their values are
 * empty). The configuration — the saved one or the builder's draft — is
 * checked like a save first (`422 AUTOMATION_INVALID`).
 *
 * The test email goes only to the caller's own address, with the subject
 * prefixed `[Test]`/`[Thử]`, through the same transport, headers, footer
 * and signature as a real one. Callers check who may do this (managers of
 * the automation) and rate-limit the test.
 */

export interface AutomationEmailPreviewerOptions {
  readonly config: SendEmailConfigSource & Pick<AppConfig, 'defaults'>;
  readonly query: RecordQueryService;
  readonly mailer: Mailer;
  /** Storage of attachment files: the test email carries the real files (T532). */
  readonly storage?: StorageDriver | null;
  /** Re-encodes field images (WebP thumbnails) to JPEG/PNG for email (T534; worker `transcodeEmailImage`). */
  readonly transcodeImage?: InlineImageTranscoder | null;
}

/** The automation as stored. */
export interface PreviewAutomation {
  readonly id: Id<'aut'>;
  readonly base_id: Id<'bse'>;
  readonly name: string;
  readonly definition: unknown;
  readonly trigger_table_id: Id<'tbl'> | null;
}

export interface EmailPreviewRequest {
  readonly automation: PreviewAutomation;
  readonly actionId: string;
  /** The builder's unsaved configuration (default: the saved step). */
  readonly draft?: SendEmailConfig;
  readonly recordId: Id<'rec'> | null;
  readonly editorUserId: Id<'usr'>;
}

/** Most recipients whose permissions the builder warning checks. */
const MAX_CHECKED_RECIPIENTS = 50;

type AnyAction = AutomationAction | AutomationBranchAction;

interface Prepared {
  readonly rendered: RenderedAutomationEmail;
  readonly config: SendEmailConfig;
  readonly loaded: MemberAccessBase;
  readonly schema: AutomationValidationContext;
  readonly triggerType: AutomationTrigger['type'];
  readonly tableId: Id<'tbl'> | null;
  readonly recordId: Id<'rec'> | null;
  readonly locale: string;
  readonly definition: AutomationDefinition;
  /** Path of the step in the definition (`definition.actions[0]`). */
  readonly path: string;
}

const audit = new AuditWriter();

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function settingOf(settings: JsonValue, key: string): unknown {
  return isObject(settings) ? settings[key] : undefined;
}

function invalid(errors: ProblemErrorItem[]): AppError {
  return new AppError('AUTOMATION_INVALID', {
    detail: 'The email step is not valid for you.',
    errors,
  });
}

/** `"Name" <address>` as recipients see it. */
function display(address: MailAddress): string {
  const name = sanitizeHeaderText(address.name ?? '');
  return name === '' ? `<${address.address}>` : `"${name}" <${address.address}>`;
}

/** The definition with the step `actionId` set to `config` (added at the end when new). */
function withStep(
  definition: AutomationDefinition,
  actionId: string,
  config: SendEmailConfig,
): AutomationDefinition {
  const seen = { found: false };
  const replace = <A extends AnyAction>(action: A): A => {
    if (action.id === actionId && action.type === 'send_email') {
      seen.found = true;
      return { ...action, config };
    }
    if (action.type === 'if') {
      return {
        ...action,
        config: {
          ...action.config,
          then: action.config.then.map(replace),
          else: action.config.else.map(replace),
        },
      };
    }
    return action;
  };
  const actions = definition.actions.map(replace);
  if (!seen.found) actions.push({ id: actionId, type: 'send_email', config });
  return { ...definition, actions };
}

/** Trigger data of a preview: now, and the editor as the person who clicked. */
function previewTriggerData(editor: Id<'usr'>, now: Date): Record<string, unknown> {
  const at = now.toISOString();
  return { fired_at: at, due_at: at, clicked_at: at, clicked_by: editor, actor: editor };
}

export class AutomationEmailPreviewer {
  private readonly renderer: SendEmailRenderer;
  private readonly identities: EmailIdentitiesRepository;
  private readonly members: RecipientMembersRepository;
  private readonly defaults: AccessDefaults;

  constructor(
    private readonly db: Db,
    private readonly options: AutomationEmailPreviewerOptions,
  ) {
    this.renderer = new SendEmailRenderer(
      db,
      options.config,
      options.storage ?? null,
      options.transcodeImage ?? null,
    );
    this.identities = new EmailIdentitiesRepository(db);
    this.members = new RecipientMembersRepository(db);
    this.defaults = {
      timeZone: options.config.defaults.timezone,
      locale: options.config.defaults.locale,
    };
  }

  async preview(scope: OrgScope, request: EmailPreviewRequest): Promise<AutomationEmailPreview> {
    const prepared = await this.prepare(scope, request);
    const { rendered } = prepared;
    const masked = (list: readonly string[]) => list.map(maskAddress);
    return {
      subject: rendered.email.subject,
      html: rendered.email.html,
      text: rendered.email.text,
      headers: {
        from:
          rendered.from === undefined
            ? `"${sanitizeHeaderText(prepared.loaded.organization.name)}" <SMTP_FROM>`
            : display(rendered.from),
        reply_to: rendered.replyTo.length === 0 ? null : rendered.replyTo.map(display).join(', '),
      },
      identity_id: rendered.sender.identityId,
      mode: rendered.sender.mode,
      footer: rendered.email.footer,
      recipients: {
        count: rendered.recipients.count,
        to: masked(rendered.recipients.to),
        cc: masked(rendered.recipients.cc),
        bcc: masked(rendered.recipients.bcc),
        invalid: rendered.recipients.invalid.length,
      },
      attachments: rendered.attachments.ok
        ? rendered.attachments.files.map((file) => ({ name: file.filename, size: file.size }))
        : [],
      images: await this.previewImages(rendered),
      warnings: await this.warningsOf(scope, request, prepared),
      render_warnings: rendered.warnings.map((warning) => ({ ...warning })),
    };
  }

  /**
   * Sends the rendered email to `caller.email` only (see the module
   * comment). SMTP failures are a result, not an error.
   */
  async sendTest(
    scope: OrgScope,
    request: EmailPreviewRequest,
    caller: { readonly email: string },
    context: AuditContext,
  ): Promise<AutomationEmailTestResult> {
    const prepared = await this.prepare(scope, request);
    const { rendered } = prepared;
    const transport = rendered.sender.transport;
    const mail = this.options.config.mail;
    if (transport.kind === 'instance' && mail === null) {
      throw new AppError('SMTP_NOT_CONFIGURED', {
        detail: 'Email is not configured on this server (SMTP_URL, SMTP_FROM).',
      });
    }
    const domain =
      transport.kind === 'identity'
        ? domainOf(transport.fromAddress)
        : domainOf(rendered.from?.address ?? mail?.fromAddress ?? '');
    const prefix = mailLocaleOf(prepared.locale) === 'vi' ? '[Thử]' : '[Test]';
    const outcomeDeps = { db: this.db, identities: this.identities, mailer: this.options.mailer };
    const files = rendered.attachments;
    if (!files.ok) {
      throw invalid([
        {
          path: `${prepared.path}.config.attachments`,
          code: ATTACHMENTS_UNAVAILABLE,
          message: 'The attachments of this record cannot be sent',
          params: { code: files.code, ...files.params },
        },
      ]);
    }
    const storage = this.options.storage ?? null;
    const images = rendered.images.files;
    if ((files.files.length > 0 || images.length > 0) && storage === null) {
      throw new TypeError('email test: attachments need a storage driver');
    }
    const parts =
      storage === null
        ? []
        : [...inlineImageParts(storage, images), ...attachmentParts(storage, files.files)];
    let result: AutomationEmailTestResult;
    try {
      const sent = await this.options.mailer.send({
        to: caller.email,
        subject: sanitizeHeaderText(`${prefix} ${rendered.email.subject}`),
        text: rendered.email.text,
        html: rendered.email.html,
        ...(rendered.from === undefined ? {} : { from: rendered.from }),
        replyTo: rendered.replyTo,
        messageId: deterministicMessageId(
          `test:${request.automation.id}:${request.actionId}:${randomUUID()}`,
          domain,
        ),
        origin: {
          kind: 'automation',
          organizationId: scope.organizationId,
          automationId: request.automation.id,
        },
        transport,
        attachments: parts,
      });
      await recordIdentitySendOutcome(outcomeDeps, scope.organizationId, transport, null, context);
      result = { status: 'sent', to: caller.email, message_id: sent.messageId, smtp: sent.smtp };
    } catch (error) {
      destroyAttachmentParts(parts);
      if (!isEmailSendError(error)) throw error;
      await recordIdentitySendOutcome(outcomeDeps, scope.organizationId, transport, error, context);
      result = {
        status: 'failed',
        code: error.code,
        reason: error.reason,
        smtp: error.smtp ?? { code: null, enhanced: null },
      };
    }
    await this.db.withTx((tx) =>
      audit.write(tx, {
        action: 'automation.test_email_sent',
        organizationId: scope.organizationId,
        baseId: request.automation.base_id,
        tableId: request.automation.trigger_table_id,
        entityType: 'automation',
        entityId: request.automation.id,
        after:
          result.status === 'sent'
            ? { action_id: request.actionId, status: 'sent', smtp_code: result.smtp.code }
            : {
                action_id: request.actionId,
                status: 'failed',
                code: result.code,
                reason: result.reason,
                smtp_code: result.smtp.code,
              },
        context,
      }),
    );
    return result;
  }

  // --- Internals --------------------------------------------------------------------

  /**
   * The inline images of the preview (T534) as signed URLs of the viewer
   * (60 s, `inline`): the HTML keeps its `cid:` sources, the builder swaps
   * them in its sandboxed frame. These URLs are never put in an email.
   */
  private async previewImages(
    rendered: RenderedAutomationEmail,
  ): Promise<AutomationEmailPreview['images']> {
    const storage = this.options.storage ?? null;
    if (storage === null) return [];
    return Promise.all(
      rendered.images.files.map(async (file) => {
        const signed = await storage.presignGet(file.objectKey, {
          filename: file.filename,
          expiresIn: ATTACHMENT_DOWNLOAD_URL_SECONDS,
          disposition: 'inline',
        });
        return { cid: file.cid, url: signed.url };
      }),
    );
  }

  private async prepare(scope: OrgScope, request: EmailPreviewRequest): Promise<Prepared> {
    const { automation } = request;
    const baseId = automation.base_id;
    const loaded = await loadMemberAccessBase(this.db, scope, baseId);
    const access =
      loaded === undefined
        ? undefined
        : await resolveMemberBaseAccess(
            this.db,
            scope,
            { userId: request.editorUserId, baseId },
            this.defaults,
            loaded,
          );
    if (loaded === undefined || access === undefined) throw new AppError('NOT_FOUND');
    const stored = automationDefinitionSchema.safeParse(automation.definition);
    if (!stored.success) {
      throw invalid([
        { path: 'definition', code: 'INVALID', message: 'The stored definition is outdated' },
      ]);
    }
    const flat = flattenActions(stored.data.actions);
    const found = flat.find((item) => item.action.id === request.actionId);
    if (found !== undefined && found.action.type !== 'send_email') throw new AppError('NOT_FOUND');
    const savedConfig = found?.action.type === 'send_email' ? found.action.config : undefined;
    const draft = request.draft ?? savedConfig;
    if (draft === undefined) throw new AppError('NOT_FOUND');
    const definition = withStep(stored.data, request.actionId, draft);
    const path =
      flattenActions(definition.actions).find((item) => item.action.id === request.actionId)
        ?.path ?? 'definition.actions';

    // The step as a save by the editor would check it (their access).
    const schema = await loadAutomationSchema(
      this.db,
      scope,
      baseId,
      access.record.resolved.access,
      loaded.base.settings,
    );
    const validation = validateAutomationDefinition(definition, schema);
    let config = draft;
    if (validation.ok) {
      const checked = flattenActions(validation.definition.actions).find(
        (item) => item.action.id === request.actionId,
      )?.action;
      if (checked?.type === 'send_email') config = checked.config;
    } else {
      const own = validation.errors.filter(
        (error) => error.path === path || error.path.startsWith(`${path}.`),
      );
      if (own.length > 0) throw invalid(own);
    }
    const orgSettings = orgEmailSettingsOf(loaded.organization.settings);
    const senderErrors = await checkSendEmailSender(
      {
        identities: this.identities,
        mail: this.options.config.mail,
        instanceFooterPolicy: this.options.config.email.automationFooter,
      },
      scope,
      { baseId, config, path, orgSettings },
    );
    if (senderErrors.length > 0) throw invalid(senderErrors);

    const triggerType = definition.trigger.type;
    const tableId = triggerType === 'schedule' ? null : automation.trigger_table_id;
    if (request.recordId !== null) {
      const found =
        tableId === null ? [] : await this.readable(scope, tableId, request.recordId, access);
      if (found.length === 0) throw new AppError('NOT_FOUND');
    }

    const settings = loaded.organization.settings;
    const timeZone = canonicalTimeZone(settingOf(settings, 'timezone')) ?? this.defaults.timeZone;
    const localeSetting = settingOf(settings, 'locale');
    const locale =
      typeof localeSetting === 'string' && localeSetting !== ''
        ? localeSetting
        : this.defaults.locale;
    const now = new Date();
    const publicUrl = this.options.config.publicUrl.replace(/\/+$/u, '');
    const values = new AutomationValueEvaluator({
      context: schema,
      definition,
      reader: recordQueryReader(this.options.query, scope, access.record),
      trigger: {
        tableId,
        recordId: request.recordId,
        data: previewTriggerData(request.editorUserId, now),
      },
      steps: new Map(),
      timeZone,
      locale,
      now,
      recordUrl: (table, record) =>
        `${publicUrl}/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(table)}?record=${encodeURIComponent(record)}`,
    });
    const result = await this.renderer.render({
      scope,
      config,
      values,
      organization: { name: loaded.organization.name, settings },
      locale,
      automation: {
        id: automation.id,
        name: automation.name,
        baseId,
        baseName: loaded.base.name,
      },
      runAsUserId: request.editorUserId,
      attachmentSource: { schema, tableId, recordId: request.recordId },
    });
    if (!result.ok) {
      if (result.code === 'email_body_too_large') {
        throw invalid([
          {
            path: `${path}.config.body.template`,
            code: 'TOO_BIG',
            message: 'The email is larger than EMAIL_MAX_HTML_BYTES',
            params: {
              html_bytes: result.params['html_bytes'],
              limit: this.options.config.email.maxHtmlBytes,
            },
          },
        ]);
      }
      throw invalid([
        {
          path: `${path}.config.identity_id`,
          code: 'EMAIL_IDENTITY_NOT_USABLE',
          message: 'This sender identity cannot be used by automations of this base',
        },
      ]);
    }
    return {
      rendered: result.rendered,
      config,
      loaded,
      schema,
      triggerType,
      tableId,
      recordId: request.recordId,
      locale,
      definition,
      path,
    };
  }

  /** The record if `access` reads it (outside its read rule or table → none). */
  private async readable(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
    access: MemberBaseAccess,
  ): Promise<readonly unknown[]> {
    if (access.record.resolved.access.tables[tableId] === undefined) return [];
    try {
      return await this.options.query.getRecords(scope, tableId, [recordId], access.record, {
        field_key_type: 'id',
        fields: [],
      });
    } catch (error) {
      if (error instanceof AppError && error.status === 404) return [];
      throw error;
    }
  }

  /** Builder warnings (codes and ids only, never values). */
  private async warningsOf(
    scope: OrgScope,
    request: EmailPreviewRequest,
    prepared: Prepared,
  ): Promise<SendEmailWarning[]> {
    const warnings: SendEmailWarning[] = [];
    const { rendered } = prepared;
    const unread = await this.unreadableByRecipients(scope, request, prepared);
    if (unread !== null) warnings.push({ code: 'RECIPIENT_MAY_NOT_READ', params: unread });
    if (rendered.sender.mode === 'on_behalf') warnings.push({ code: 'ON_BEHALF_DMARC' });
    const files = rendered.attachments;
    if (!files.ok) {
      warnings.push({
        code: 'ATTACHMENTS_UNAVAILABLE',
        params: { code: files.code, ...files.params },
      });
    } else if (files.files.length > 0) {
      const limits = rendered.attachmentLimits;
      // Near a limit: another file on a real record may fail the step.
      if (
        files.files.length > limits.maxAttachments * 0.8 ||
        files.bytes > limits.maxAttachmentBytes * 0.8
      ) {
        warnings.push({
          code: 'ATTACHMENTS_SIZE',
          params: {
            count: files.files.length,
            bytes: files.bytes,
            max_attachments: limits.maxAttachments,
            max_attachment_bytes: limits.maxAttachmentBytes,
          },
        });
      }
    }
    const addresses = [
      ...rendered.recipients.to,
      ...rendered.recipients.cc,
      ...rendered.recipients.bcc,
    ];
    const members = await this.members.memberAddresses(scope, addresses);
    const external = addresses.filter((address) => !members.has(address.toLowerCase())).length;
    if (external > 0) warnings.push({ code: 'EXTERNAL_RECIPIENTS', params: { count: external } });
    return warnings;
  }

  /**
   * Quyết định S5 #3: recipients are not checked, but the builder warns
   * when some recipient users (from user fields, steps, `clicked_by`) cannot
   * read a field the subject/body shows, or the record itself.
   */
  private async unreadableByRecipients(
    scope: OrgScope,
    request: EmailPreviewRequest,
    prepared: Prepared,
  ): Promise<Record<string, unknown> | null> {
    const users = prepared.rendered.recipients.userIds.slice(0, MAX_CHECKED_RECIPIENTS);
    const { tableId } = prepared;
    if (users.length === 0 || tableId === null) return null;
    const fields = this.templateFields(prepared, tableId);
    const unreadable = new Set<string>();
    let recordHidden = false;
    let people = 0;
    for (const userId of users) {
      const access = await resolveMemberBaseAccess(
        this.db,
        scope,
        { userId, baseId: request.automation.base_id },
        this.defaults,
        prepared.loaded,
      );
      const table = access?.record.resolved.access.tables[tableId];
      const missing = fields.filter((field) => table?.fields[field as Id<'fld'>] === undefined);
      const hidden =
        prepared.recordId !== null &&
        (access === undefined ||
          (await this.readable(scope, tableId, prepared.recordId, access)).length === 0);
      if (missing.length === 0 && !hidden) continue;
      people += 1;
      for (const field of missing) unreadable.add(field);
      recordHidden ||= hidden;
    }
    if (people === 0) return null;
    return {
      field_ids: [...unreadable].sort(),
      recipients: people,
      ...(recordHidden ? { record: true } : {}),
    };
  }

  /** Fields of the trigger table that the subject and the body show (first link hop included). */
  private templateFields(prepared: Prepared, tableId: Id<'tbl'>): string[] {
    const sources = {
      trigger: TRIGGER_REFERENCES[prepared.triggerType],
      steps: new Map<string, Id<'tbl'>>(),
      ...previousSourceOf(prepared.triggerType, tableId),
      digest: prepared.config.body.digest !== null,
    };
    const snapshot = automationSnapshot(prepared.schema, tableId, null, sources);
    const fields = new Set<string>();
    for (const source of [prepared.config.subject.template, prepared.config.body.template]) {
      const { check } = checkAutomationTemplate(source, snapshot, 'template');
      for (const placeholder of check.placeholders) {
        for (const dependency of placeholder.dependencies) {
          const field =
            dependency.kind === 'same_row' ? dependency.field_id : dependency.link_path[0];
          if (field !== undefined && !isTemplateReferenceId(field)) fields.add(field);
        }
      }
    }
    return [...fields];
  }
}
