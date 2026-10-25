import {
  SEND_EMAIL_ERROR_MAX_REJECTED,
  type AutomationTemporaryCause,
  type SendEmailStepOutput,
} from '@cellhive/contracts';

import { BasesRepository } from '../../../db/repositories/bases.repository.js';
import { OrganizationsRepository } from '../../../db/repositories/organizations.repository.js';
import { domainOf } from '../../../mail/address.js';
import { deterministicMessageId } from '../../../mail/headers.js';
import { EmailIdentitiesRepository } from '../../../mail/identities/email-identities.repository.js';
import {
  recordIdentitySendOutcome,
  type IdentitySendOutcome,
} from '../../../mail/identities/send-outcome.js';
import { EMAIL_QUOTA_MAX_WAIT_MS } from '../../../mail/limits.js';
import { isEmailSendError, type EmailSendError } from '../../../mail/smtp-errors.js';
import { AutomationStepError } from '../../engine/errors.js';
import { AutomationsRepository } from '../../repository/automations.repository.js';

import { attachmentParts, destroyAttachmentParts, inlineImageParts } from './attachments/stream.js';
import { SendEmailRenderer, type SendEmailConfigSource } from './render.js';

import type { Db } from '../../../db/create-db.js';
import type { JsonObject, JsonValue } from '../../../db/schema.js';
import type { InlineImageTranscoder } from '../../../mail/images/inline-images.js';
import type { MailAttachment, Mailer, MailSendResult } from '../../../mail/mailer.js';
import type { StorageDriver } from '../../../storage/storage-driver.js';
import type {
  AutomationActionContext,
  AutomationActionHandler,
  AutomationActionResult,
} from '../../engine/action-registry.js';

/**
 * The `send_email` handler of the run engine (SPEC §11.5, BACKLOG T514,
 * ADR-32 §3, ADR-33). One attempt:
 *
 * 1. Renders the email as `run_as` now (`SendEmailRenderer`): the sender
 *    identity is checked again — unusable → `email_identity_unavailable`,
 *    in `error` → `email_identity_auth_failed`; never falls back to the
 *    system sender. A footer `none` the policy no longer allows becomes
 *    `minimal`.
 * 2. Recipients over `EMAIL_MAX_RECIPIENTS` → `too_many_recipients`, none
 *    → `invalid_recipients`: nothing is sent.
 * 3. `Mailer.send` through the identity's transport (its own SMTP, or the
 *    instance SMTP), `origin = automation` (mandatory headers,
 *    `X-Cellhive-Automation`, organization and identity quotas),
 *    `Message-ID` from the step's idempotency key — the same on every
 *    retry. `recordIdentitySendOutcome` keeps the identity's authentication
 *    failure count (the third `535` in a row puts it in `error`).
 * 4. Failures: `smtp_temporary` is retried by the engine (10 s … 30 min),
 *    `email_quota_exceeded` waits for the next hour (up to 24 hours, not a
 *    retry), anything else fails the step at once.
 *
 * Attachments (T532) are decided by the renderer from `meta.attachments`
 * before anything is read (permissions of `run_as` now, `ready` files,
 * blocked types, limits of the organization) — a problem fails the step
 * with its attachment code and nothing is sent; the files are then
 * streamed from storage into the message (a read failure is retried like
 * an SMTP temporary failure).
 *
 * Inline images (T534) — signature assets, assets of this automation,
 * images of attachment fields of the trigger record as `run_as` may
 * download them — are inline `cid:` parts streamed the same way; their
 * number and bytes count toward the limits (a field image that cannot be
 * sent is left out with a warning).
 *
 * The step output holds ids, the mode, masked recipients, sizes and SMTP
 * codes — never the subject, the body, file names or full addresses.
 */

export interface SendEmailActionDeps {
  readonly db: Db;
  readonly mailer: Mailer;
  readonly config: SendEmailConfigSource;
  /** Storage of attachment files (required by steps with `attachments`, T532). */
  readonly storage?: StorageDriver | null;
  /** Re-encodes field images (WebP thumbnails) to JPEG/PNG for email (T534; worker `transcodeEmailImage`). */
  readonly transcodeImage?: InlineImageTranscoder | null;
}

/** The engine's temporary cause for an SMTP failure (`params.cause` stays the SMTP reason). */
function causeOf(error: EmailSendError): AutomationTemporaryCause {
  switch (error.reason) {
    case 'timeout':
      return 'timeout';
    case 'connection_failed':
    case 'tls_failed':
      return 'network';
    default:
      return 'server_error';
  }
}

/**
 * The step error of a failed send (codes, SMTP reply and masked recipients
 * only). Recipients refused (QA S5 L1, CONTRACTS §21): `rejected` — the
 * first {@link SEND_EMAIL_ERROR_MAX_REJECTED}, masked like the step output,
 * each with its code and SMTP reply —, `rejected_count` (all of them) and
 * `accepted_count` (accepted before the failure; the message reached none).
 */
function stepErrorOf(error: EmailSendError, outcome: IdentitySendOutcome): AutomationStepError {
  const params: Record<string, unknown> = {
    ...(error.reason === null ? {} : { reason: error.reason }),
    ...(error.smtp === null
      ? {}
      : { smtp: { code: error.smtp.code, enhanced: error.smtp.enhanced } }),
    ...(error.rejected.length === 0
      ? {}
      : {
          rejected: error.rejected.slice(0, SEND_EMAIL_ERROR_MAX_REJECTED).map((item) => ({
            masked: item.masked,
            code: item.code,
            smtp:
              item.smtp === null ? null : { code: item.smtp.code, enhanced: item.smtp.enhanced },
          })),
          rejected_count: error.rejected.length,
          accepted_count: error.acceptedCount,
        }),
  };
  if (outcome === 'identity_error') {
    return new AutomationStepError(
      'email_identity_auth_failed',
      'The SMTP server of the sender identity keeps refusing its credentials.',
      { params },
    );
  }
  switch (error.code) {
    case 'smtp_temporary':
      return new AutomationStepError(error.code, error.message, {
        transient: causeOf(error),
        params,
      });
    case 'email_quota_exceeded':
      return new AutomationStepError(error.code, error.message, {
        params,
        wait: {
          until: error.retryAt ?? new Date(Date.now() + 60 * 60 * 1000),
          maxWaitMs: EMAIL_QUOTA_MAX_WAIT_MS,
        },
      });
    default:
      return new AutomationStepError(error.code, error.message, { params });
  }
}

export function createSendEmailAction(deps: SendEmailActionDeps): AutomationActionHandler {
  const renderer = new SendEmailRenderer(
    deps.db,
    deps.config,
    deps.storage ?? null,
    deps.transcodeImage ?? null,
  );
  const organizations = new OrganizationsRepository(deps.db);
  const automations = new AutomationsRepository(deps.db);
  const bases = new BasesRepository(deps.db);
  const identities = new EmailIdentitiesRepository(deps.db);

  return {
    async execute(context: AutomationActionContext): Promise<AutomationActionResult> {
      const { action, scope, run } = context;
      if (action.type !== 'send_email') throw new TypeError('send_email handler: wrong action');
      const [organization, automation, base] = await Promise.all([
        organizations.findById(scope.organizationId),
        automations.get(scope, run.automationId),
        bases.getById(scope, run.baseId),
      ]);
      if (organization === undefined || base === undefined) {
        throw new AutomationStepError('permission_denied', 'The base is gone.', {
          params: { scope: 'base' },
        });
      }
      const runAsUserId = context.access.record.userId;
      if (runAsUserId === null) throw new TypeError('send_email: run_as has no user');
      const result = await renderer.render({
        scope,
        config: action.config,
        values: context.values,
        organization: { name: organization.name, settings: organization.settings },
        locale: run.locale,
        automation: {
          id: run.automationId,
          name: automation?.name ?? '',
          baseId: run.baseId,
          baseName: base.name,
        },
        runAsUserId,
        attachmentSource: {
          schema: context.schema,
          tableId: run.triggerTableId,
          recordId: run.triggerRecordId,
        },
      });
      if (!result.ok) {
        throw new AutomationStepError(result.code, 'The email cannot be sent.', {
          params: result.params,
        });
      }
      const { rendered } = result;
      const { recipients } = rendered;
      const files = rendered.attachments;
      if (!files.ok) {
        throw new AutomationStepError(files.code, 'The attachments cannot be sent.', {
          params: files.params,
        });
      }
      if (recipients.count > deps.config.email.maxRecipients) {
        throw new AutomationStepError('too_many_recipients', 'Too many recipients.', {
          params: { count: recipients.count, limit: deps.config.email.maxRecipients },
        });
      }
      if (recipients.count === 0) {
        throw new AutomationStepError('invalid_recipients', 'No valid recipient.', {
          params: { invalid: recipients.invalid.length, users_left_out: recipients.droppedUsers },
        });
      }
      const transport = rendered.sender.transport;
      // The `Message-ID` domain is the one of the `From` recipients see.
      const fromDomain =
        transport.kind === 'identity'
          ? domainOf(transport.fromAddress)
          : deps.config.mail === null
            ? null
            : domainOf(rendered.from?.address ?? deps.config.mail.fromAddress);
      if (fromDomain === null) {
        throw new AutomationStepError('smtp_not_configured', 'Email is not configured.');
      }
      const messageId = deterministicMessageId(context.idempotencyKey, fromDomain);
      const outcomeDeps = { db: deps.db, identities, mailer: deps.mailer };
      let parts: MailAttachment[] = [];
      const images = rendered.images.files;
      if (files.files.length > 0 || images.length > 0) {
        if (deps.storage === undefined || deps.storage === null) {
          throw new TypeError('send_email: attachments need a storage driver');
        }
        parts = [
          ...inlineImageParts(deps.storage, images),
          ...attachmentParts(deps.storage, files.files),
        ];
      }
      let sent: MailSendResult;
      try {
        sent = await deps.mailer.send({
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          subject: rendered.email.subject,
          text: rendered.email.text,
          html: rendered.email.html,
          ...(rendered.from === undefined ? {} : { from: rendered.from }),
          replyTo: rendered.replyTo,
          messageId,
          origin: {
            kind: 'automation',
            organizationId: scope.organizationId,
            automationId: run.automationId,
          },
          transport,
          attachments: parts,
        });
      } catch (error) {
        destroyAttachmentParts(parts);
        if (!isEmailSendError(error)) throw error;
        const outcome = await recordIdentitySendOutcome(
          outcomeDeps,
          scope.organizationId,
          transport,
          error,
          context.audit,
        );
        throw stepErrorOf(error, outcome);
      }
      await recordIdentitySendOutcome(
        outcomeDeps,
        scope.organizationId,
        transport,
        null,
        context.audit,
      );
      const output: SendEmailStepOutput = {
        message_id: sent.messageId === '' ? messageId : sent.messageId,
        identity_id: rendered.sender.identityId,
        mode: rendered.sender.mode,
        recipients: {
          accepted: [...sent.accepted],
          rejected: sent.rejected.map((item) => ({
            masked: item.masked,
            code: item.code,
            smtp:
              item.smtp === null ? null : { code: item.smtp.code, enhanced: item.smtp.enhanced },
          })),
        },
        bytes: sent.bytes,
        attachment_count: files.files.length,
        attachment_bytes: files.bytes,
        attachment_skipped: files.skipped,
        inline_image_count: images.length,
        inline_image_bytes: rendered.images.bytes,
        inline_image_skipped: rendered.images.skipped,
        smtp: sent.smtp,
        footer: rendered.email.footer,
      };
      return {
        output: {
          ...(output as unknown as JsonObject),
          ...(rendered.warnings.length === 0
            ? {}
            : { warnings: rendered.warnings as unknown as JsonValue }),
        },
        warnings: rendered.warnings,
      };
    },
  };
}
