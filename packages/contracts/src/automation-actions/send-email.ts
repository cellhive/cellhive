import { z } from 'zod';

import {
  automationActionIdSchema,
  digestValueSchema,
  fieldValueSchema,
  MAX_TEMPLATE_LENGTH,
  stepValueSchema,
  triggerValueSchema,
} from '../automation-values.js';
import { emailPreviewImageSchema } from '../email-assets.js';
import { EMAIL_IDENTITY_MODES, EMAIL_IDENTITY_RUN_ERROR_CODES } from '../email-identities.js';
import {
  EMAIL_FAILURE_CODES,
  EMAIL_FOOTER_LEVELS,
  SMTP_FAILURE_REASONS,
  smtpReplySchema,
} from '../email.js';
import { idOf } from '../ids.js';

/**
 * `send_email` (SPEC §11.5, CONTRACTS §21/§23, ADR-32 §3, ADR-33; BACKLOG
 * T514): an automation email from the system sender or a verified sender
 * identity, to recipients taken from literals, email/user fields, earlier
 * steps or the trigger. The subject is a one-line template, the body a
 * narrow Markdown template (parsed first, values substituted as text);
 * signature and footer follow the identity and the policies (T531).
 * Attachments (T532) are the files of attachment fields of the trigger
 * record, streamed from storage into the message.
 */

/** Most values in each of `to`, `cc`, `bcc` (each value may hold several addresses). */
export const MAX_EMAIL_RECIPIENT_VALUES = 50;
/** Longest subject template source; the rendered subject is cut at 255 (`TEMPLATE_OUTPUT_LIMITS`). */
export const MAX_EMAIL_SUBJECT_SOURCE = 1_000;
/** Longest literal address list item. */
const MAX_LITERAL_ADDRESS_LENGTH = 320;

/** `{ "literal": "a@b.vn" }` or a list of addresses. */
export const emailRecipientLiteralSchema = z
  .strictObject({
    literal: z.union([
      z.string().min(1).max(MAX_LITERAL_ADDRESS_LENGTH),
      z
        .array(z.string().min(1).max(MAX_LITERAL_ADDRESS_LENGTH))
        .min(1)
        .max(MAX_EMAIL_RECIPIENT_VALUES),
    ]),
  })
  .meta({ id: 'EmailRecipientLiteral', description: 'One address or a list of addresses' });

/**
 * A recipient value (SPEC §11.4): a literal address (list), a field of the
 * trigger record (`user`, `created_by`/`updated_by`, or `text` with the
 * `email` style), an earlier step's output or trigger data (`clicked_by`).
 * Users become their account email (active members of the organization only).
 */
export const emailRecipientValueSchema = z
  .union([emailRecipientLiteralSchema, fieldValueSchema, stepValueSchema, triggerValueSchema])
  .meta({ id: 'EmailRecipientValue' });
export type EmailRecipientValue = z.infer<typeof emailRecipientValueSchema>;

const recipientListSchema = z.array(emailRecipientValueSchema).max(MAX_EMAIL_RECIPIENT_VALUES);

/**
 * Reply-To of the action (ADR-33 §1): a verified identity, or the account
 * email of a Cellhive user — a `user` field of the trigger record, the
 * person who clicked the button, or `run_as`. Never a literal or a text
 * field (`EMAIL_REPLY_TO_INVALID`). `null` = the identity's own Reply-To.
 */
export const emailReplyToSchema = z
  .union([
    z.strictObject({ identity_id: idOf('eid') }),
    fieldValueSchema,
    z.strictObject({ trigger: z.literal('clicked_by') }),
    z.strictObject({ run_as: z.literal(true) }),
  ])
  .meta({ id: 'EmailReplyTo' });
export type EmailReplyTo = z.infer<typeof emailReplyToSchema>;

/** Reference of the body template where the `digest` lines go: `{{ [@digest] }}`. */
export const EMAIL_BODY_DIGEST_REFERENCE = '@digest';

export const sendEmailBodySchema = z
  .strictObject({
    format: z.literal('markdown'),
    template: z
      .string()
      .max(MAX_TEMPLATE_LENGTH)
      .meta({
        description:
          'Narrow Markdown with `{{ formula }}` placeholders (stored form). The template is ' +
          'parsed first; each value becomes text (never a link, image, heading or HTML). ' +
          'Images (T534, inline `cid:` parts): `![alt](asset:att_… =width)` — an image uploaded ' +
          'for this automation — and `![alt](field:fld_…)` — the images of an attachment field ' +
          'of the trigger record (1280 px thumbnails, only `ready` files `run_as` may ' +
          'download); any other image syntax → `IMAGE_SOURCE_NOT_ALLOWED`. The alt text takes ' +
          'the escapes of inline text (`\\]`, `\\\\`, `\\{`)',
      }),
    digest: digestValueSchema.shape.digest
      .nullable()
      .default(null)
      .meta({
        description:
          'Lines of an earlier `find_records` step, placed where the template says ' +
          '`{{ [@digest] }}` (one line per record, as text)',
      }),
  })
  .meta({ id: 'SendEmailBody' });

/** Most attachment fields of one `send_email` step (BACKLOG T532). */
export const MAX_EMAIL_ATTACHMENT_FIELDS = 5;

/** What a file that is not `ready` (or no longer in the cell) does to the step (T532). */
export const EMAIL_MISSING_ATTACHMENT_MODES = ['fail', 'skip'] as const;
export type EmailMissingAttachmentMode = (typeof EMAIL_MISSING_ATTACHMENT_MODES)[number];

/**
 * An attachment source: an `attachment` field of the trigger record whose
 * files `run_as` may download (`file_download_fields`, SPEC §14.1).
 */
export const sendEmailAttachmentSchema = z
  .strictObject({ field: idOf('fld') })
  .meta({ id: 'SendEmailAttachment', description: 'Attachment field of the trigger record' });
export type SendEmailAttachment = z.infer<typeof sendEmailAttachmentSchema>;

export const sendEmailConfigSchema = z
  .strictObject({
    identity_id: idOf('eid')
      .nullable()
      .default(null)
      .meta({
        description:
          'Verified sender identity in the scope of the base; `null` = the system sender ' +
          '(`SMTP_FROM`, when the organization allows it)',
      }),
    to: recipientListSchema.min(1),
    cc: recipientListSchema.default([]),
    bcc: recipientListSchema.default([]),
    reply_to: emailReplyToSchema.nullable().default(null),
    subject: z.strictObject({
      template: z.string().min(1).max(MAX_EMAIL_SUBJECT_SOURCE).meta({
        description: 'One-line template; line breaks and control characters become spaces, ≤ 255',
      }),
    }),
    body: sendEmailBodySchema,
    include_signature: z.boolean().default(true),
    footer: z.enum(EMAIL_FOOTER_LEVELS).default('minimal').meta({
      description:
        '`none` only when the policies allow it and the sender is a verified `send_as` identity',
    }),
    attachments: z
      .array(sendEmailAttachmentSchema)
      .max(MAX_EMAIL_ATTACHMENT_FIELDS)
      .default([])
      .meta({
        description:
          'Attachment fields of the trigger record (each at most once): their `ready` files are ' +
          'attached; `run_as` must be allowed to download them. Limits: ' +
          '`min(EMAIL_MAX_ATTACHMENTS, org max_attachments)` files and ' +
          '`min(EMAIL_MAX_ATTACHMENT_BYTES, org max_attachment_bytes)` bytes in all',
      }),
    on_missing_attachment: z
      .enum(EMAIL_MISSING_ATTACHMENT_MODES)
      .default('fail')
      .meta({
        description:
          'A file not `ready` (`pending_upload`, `pending_scan`) or removed: `fail` the step ' +
          '(`attachment_not_ready`), or `skip` it (sent without it, counted in ' +
          '`attachment_skipped`)',
      }),
  })
  .meta({ id: 'SendEmailConfig' });
export type SendEmailConfig = z.infer<typeof sendEmailConfigSchema>;
export type SendEmailConfigInput = z.input<typeof sendEmailConfigSchema>;

export const sendEmailActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('send_email'),
    config: sendEmailConfigSchema,
  })
  .meta({
    id: 'SendEmailAction',
    description:
      'Output: `{ message_id, identity_id, mode, recipients: { accepted, rejected }, bytes, ' +
      'attachment_count, attachment_bytes, attachment_skipped, smtp, footer }` — never the ' +
      'body, file names or addresses in full',
  });

// --- Save-time detail codes (`422 AUTOMATION_INVALID`) ---------------------------------

/** Reply-To that is not a verified identity nor a Cellhive user (ADR-33 §1). */
export const EMAIL_REPLY_TO_INVALID = 'EMAIL_REPLY_TO_INVALID';

/**
 * An attachment source that is not an `attachment` field of the trigger
 * record (`params.type`), named twice (`params.reason = duplicate`), or a
 * trigger without record (`params.reason = no_trigger_record`) (T532).
 */
export const ATTACHMENT_FIELD_INVALID = 'ATTACHMENT_FIELD_INVALID';
/** An attachment field whose files the person saving may not download (T532). */
export const ATTACHMENT_FIELD_NOT_DOWNLOADABLE = 'ATTACHMENT_FIELD_NOT_DOWNLOADABLE';
/**
 * "Send a test to me" whose attachments would fail the step with the
 * chosen record (`params.code`: an `EMAIL_ATTACHMENT_ERROR_CODES` code) (T532).
 */
export const ATTACHMENTS_UNAVAILABLE = 'ATTACHMENTS_UNAVAILABLE';

// --- Run step -------------------------------------------------------------------------

/**
 * Why the attachments of a `send_email` step stopped it (T532; checked on
 * `meta.attachments` before any file is read, nothing is sent):
 * - `attachment_access_denied` — `run_as` no longer reads the record or
 *   the field, or may not download its files (`params.field_id`);
 * - `attachment_not_ready` — a file is `pending_upload`/`pending_scan` or
 *   was removed, with `on_missing_attachment: fail` (`params.field_id`);
 * - `attachment_type_blocked` — an extension Gmail refuses, or
 *   `.html`/`.htm`/`.xhtml`/`.svg` (`params.extension`);
 * - `too_many_attachments` — more files than the limit (`params.count`,
 *   `params.limit`); with `params.scope = inline_images`, more images than
 *   `EMAIL_MAX_INLINE_IMAGES` (T534);
 * - `attachments_too_large` — more bytes than the limit (`params.bytes`,
 *   `params.limit`; files and inline images together, T534;
 *   `params.scope = message` when the whole encoded message would exceed it).
 */
export const EMAIL_ATTACHMENT_ERROR_CODES = [
  'attachment_access_denied',
  'attachment_not_ready',
  'attachment_type_blocked',
  'too_many_attachments',
  'attachments_too_large',
] as const;
export type EmailAttachmentErrorCode = (typeof EMAIL_ATTACHMENT_ERROR_CODES)[number];

/**
 * `error.code` of a failed `send_email` step: the email failure codes of
 * CONTRACTS §23.1 (`smtp_temporary` is retried, `email_quota_exceeded`
 * waits for the next hour up to 24 hours), the identity codes of §23.3
 * and the attachment codes (T532).
 */
export const SEND_EMAIL_STEP_ERROR_CODES = [
  ...EMAIL_FAILURE_CODES,
  ...EMAIL_IDENTITY_RUN_ERROR_CODES,
  ...EMAIL_ATTACHMENT_ERROR_CODES,
] as const;
export type SendEmailStepErrorCode = (typeof SEND_EMAIL_STEP_ERROR_CODES)[number];

/** Why a recipient was not mailed (step output `recipients.rejected[].code`). */
export const EMAIL_RECIPIENT_REJECTION_CODES = [
  'invalid_address',
  'smtp_temporary',
  'smtp_rejected',
] as const;

/**
 * One recipient the message did not go to: masked address, why, and the
 * server's reply codes (`null` for `invalid_address`, never its text).
 * `smtp` is absent from steps run before T541.
 */
export const emailRecipientRejectionSchema = z
  .object({
    masked: z.string().meta({ description: 'Masked: `a***@example.com` (`***` if unparseable)' }),
    code: z.enum(EMAIL_RECIPIENT_REJECTION_CODES),
    smtp: smtpReplySchema.nullable().optional(),
  })
  .meta({ id: 'EmailRecipientRejection' });
export type EmailRecipientRejection = z.infer<typeof emailRecipientRejectionSchema>;

/** Output of a `send_email` step (no body, no subject, addresses masked). */
export const sendEmailStepOutputSchema = z
  .object({
    message_id: z.string(),
    identity_id: idOf('eid').nullable(),
    mode: z.enum(EMAIL_IDENTITY_MODES),
    recipients: z.object({
      accepted: z.array(z.string()).meta({ description: 'Masked: `a***@example.com`' }),
      rejected: z.array(emailRecipientRejectionSchema),
    }),
    bytes: z.int().min(0).nullable(),
    attachment_count: z.int().min(0),
    attachment_bytes: z.int().min(0).meta({ description: 'Bytes of the original files' }),
    attachment_skipped: z.int().min(0).meta({
      description: 'Files left out (`on_missing_attachment: skip`); never their names',
    }),
    inline_image_count: z.int().min(0).meta({
      description: 'Inline images sent (T534), signature included',
    }),
    inline_image_bytes: z.int().min(0),
    inline_image_skipped: z
      .int()
      .min(0)
      .meta({
        description:
          'Field images left out (not `ready`, no thumbnail, `run_as` may not download them) ' +
          'or assets gone; each also an `inline_image_skipped` warning',
      }),
    smtp: smtpReplySchema,
    footer: z.enum(EMAIL_FOOTER_LEVELS),
  })
  .meta({ id: 'SendEmailStepOutput' });
export type SendEmailStepOutput = z.infer<typeof sendEmailStepOutputSchema>;

// --- Builder: warnings, preview, test send (CONTRACTS §21) -----------------------------

/**
 * Warnings for the builder (never errors; Quyết định S5 #3: `send_email`
 * does not check what recipients may read):
 * - `RECIPIENT_MAY_NOT_READ` — recipients from a user field, and the
 *   template shows fields (or the record) some of them cannot read
 *   (`params.field_ids`, `params.recipients`);
 * - `ON_BEHALF_DMARC` — the identity sends `on_behalf`: recipients see
 *   "<name> (via Cellhive)" from `SMTP_FROM`;
 * - `EXTERNAL_RECIPIENTS` — addresses that are not members of the
 *   organization (`params.count`);
 * - `ATTACHMENTS_SIZE` — the files of the preview record use more than 80 %
 *   of a limit (`params.count`, `params.bytes`, `params.max_attachments`,
 *   `params.max_attachment_bytes`) (T532);
 * - `ATTACHMENTS_UNAVAILABLE` — with the preview record the step would fail
 *   because of its attachments (`params.code`: an
 *   `EMAIL_ATTACHMENT_ERROR_CODES` code, plus its params) (T532).
 */
export const SEND_EMAIL_WARNING_CODES = [
  'RECIPIENT_MAY_NOT_READ',
  'ON_BEHALF_DMARC',
  'EXTERNAL_RECIPIENTS',
  'ATTACHMENTS_SIZE',
  'ATTACHMENTS_UNAVAILABLE',
] as const;
export type SendEmailWarningCode = (typeof SEND_EMAIL_WARNING_CODES)[number];

export const sendEmailWarningSchema = z
  .object({
    code: z.enum(SEND_EMAIL_WARNING_CODES),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'SendEmailWarning' });
export type SendEmailWarning = z.infer<typeof sendEmailWarningSchema>;

export const automationEmailPreviewRequestSchema = z
  .strictObject({
    record_id: idOf('rec')
      .nullable()
      .default(null)
      .meta({
        description:
          'A record of the trigger table the caller reads (`null` for a trigger without record); ' +
          'through an API token it also needs `records:read`',
      }),
    draft: sendEmailConfigSchema.optional().meta({
      description: "The builder's unsaved configuration of the step (default: the saved one)",
    }),
  })
  .meta({ id: 'AutomationEmailPreviewRequest' });
export type AutomationEmailPreviewRequest = z.infer<typeof automationEmailPreviewRequestSchema>;

/** Template warnings of the render (lower case codes of `TEMPLATE_WARNING_CODES`). */
const renderWarningSchema = z.object({
  code: z.string(),
  placeholder: z.int().min(0).optional(),
  field_id: z.string().optional(),
});

export const automationEmailPreviewSchema = z
  .object({
    subject: z.string(),
    html: z.string().meta({
      description:
        'Whole HTML document: show it in `<iframe sandbox srcdoc>` without scripts (ADR-32 §3)',
    }),
    text: z.string(),
    headers: z.object({
      from: z.string().meta({ description: 'The `From` recipients will see' }),
      reply_to: z.string().nullable(),
    }),
    identity_id: idOf('eid').nullable(),
    mode: z.enum(EMAIL_IDENTITY_MODES),
    footer: z.enum(EMAIL_FOOTER_LEVELS),
    recipients: z
      .object({
        count: z.int().min(0),
        to: z.array(z.string()),
        cc: z.array(z.string()),
        bcc: z.array(z.string()),
        invalid: z.int().min(0),
      })
      .meta({ description: 'Masked addresses (`a***@example.com`)' }),
    attachments: z.array(z.object({ name: z.string(), size: z.int().min(0) })).meta({
      description:
        'Files that would be attached (T532), with the permissions of the person editing ' +
        '(empty when `ATTACHMENTS_UNAVAILABLE`)',
    }),
    images: z.array(emailPreviewImageSchema).meta({
      description:
        'Inline images of `html` (T534): the email references them as `cid:`; the preview ' +
        'shows them through these signed URLs of the viewer (valid 60 s, never sent)',
    }),
    warnings: z.array(sendEmailWarningSchema),
    render_warnings: z.array(renderWarningSchema).meta({
      description:
        '`unknown_reference`, `field_unavailable`, `render_timeout`… (codes only); steps do not ' +
        'run in a preview, so their values are empty',
    }),
  })
  .meta({ id: 'AutomationEmailPreview' });
export type AutomationEmailPreview = z.infer<typeof automationEmailPreviewSchema>;

export const automationEmailTestRequestSchema = automationEmailPreviewRequestSchema.meta({
  id: 'AutomationEmailTestRequest',
});
export type AutomationEmailTestRequest = z.infer<typeof automationEmailTestRequestSchema>;

export const automationEmailTestResultSchema = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('sent'),
      /** The caller's own address: the only recipient of a test email. */
      to: z.string(),
      message_id: z.string(),
      smtp: smtpReplySchema,
    }),
    z.object({
      status: z.literal('failed'),
      code: z.enum(EMAIL_FAILURE_CODES),
      reason: z.enum(SMTP_FAILURE_REASONS).nullable(),
      smtp: smtpReplySchema,
    }),
  ])
  .meta({ id: 'AutomationEmailTestResult', description: 'Outcome of "Send a test to me"' });
export type AutomationEmailTestResult = z.infer<typeof automationEmailTestResultSchema>;
