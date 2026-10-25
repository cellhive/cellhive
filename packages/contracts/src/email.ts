import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';

/**
 * Email (CONTRACTS §23, BACKLOG T513): instance SMTP status, limits and the
 * connection test; footer policy, default signature and system sender of
 * automation emails (T531). Sender identities (T530) and `send_email`
 * (T514) extend this file.
 */

/** How the SMTP connection is secured. */
export const SMTP_SECURITY_MODES = ['tls', 'starttls', 'none'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY_MODES)[number];

/**
 * Why a message was not sent (run step `error.code`, CONTRACTS §23):
 * - `smtp_not_configured` — no SMTP for the chosen transport;
 * - `smtp_temporary` — `4xx`, network, timeout or TLS failure: retried;
 * - `smtp_rejected` — `5xx` (authentication included): not retried;
 * - `email_quota_exceeded` — the organization (or sender identity) hourly limit; wait;
 * - `too_many_recipients` — to + cc + bcc above `EMAIL_MAX_RECIPIENTS`;
 * - `email_body_too_large` — HTML above `EMAIL_MAX_HTML_BYTES`;
 * - `invalid_recipients` — no valid recipient address;
 * - `invalid_sender` — `From`/Reply-To not allowed for the transport.
 */
export const EMAIL_FAILURE_CODES = [
  'smtp_not_configured',
  'smtp_temporary',
  'smtp_rejected',
  'email_quota_exceeded',
  'too_many_recipients',
  'email_body_too_large',
  'invalid_recipients',
  'invalid_sender',
] as const;
export type EmailFailureCode = (typeof EMAIL_FAILURE_CODES)[number];

/** Finer reason of an SMTP failure, for messages in the UI. */
export const SMTP_FAILURE_REASONS = [
  'auth_failed',
  // Identity SMTP host resolving to a private/loopback/link-local/metadata address (T530).
  'host_not_allowed',
  'tls_failed',
  'connection_failed',
  'timeout',
  'temporary',
  'rejected',
  'unknown',
] as const;
export type SmtpFailureReason = (typeof SMTP_FAILURE_REASONS)[number];

export const smtpReplySchema = z
  .object({
    code: z.number().int().min(200).max(599).nullable(),
    enhanced: z
      .string()
      .regex(/^[245]\.\d{1,3}\.\d{1,3}$/)
      .nullable(),
  })
  .meta({ id: 'SmtpReply', description: 'SMTP reply code and enhanced status code (RFC 3463)' });
export type SmtpReplyDto = z.infer<typeof smtpReplySchema>;

// --- Automation email: footer, signature, system sender (T531, ADR-33 §3–§4) ---

/**
 * Footer of an automation email (ADR-33 §4): `minimal` (default — "sent
 * automatically by Cellhive of <organization>", no base/automation name),
 * `full` (plus the automation and base names and a link to the automation,
 * which needs a session), `none`.
 */
export const EMAIL_FOOTER_LEVELS = ['minimal', 'full', 'none'] as const;
export type EmailFooterLevel = (typeof EMAIL_FOOTER_LEVELS)[number];

/**
 * Env `EMAIL_AUTOMATION_FOOTER` (SPEC §20): `required` (default) forbids
 * `none` in every organization; `org` leaves it to each organization's
 * `footer_policy`.
 */
export const EMAIL_INSTANCE_FOOTER_POLICIES = ['required', 'org'] as const;
export type EmailInstanceFooterPolicy = (typeof EMAIL_INSTANCE_FOOTER_POLICIES)[number];

/**
 * `organizations.settings.email.footer_policy`: `required` (default) or
 * `author_choice` (automations may pick `none`); only effective when
 * `EMAIL_AUTOMATION_FOOTER=org`.
 */
export const EMAIL_FOOTER_POLICIES = ['required', 'author_choice'] as const;
export type EmailFooterPolicy = (typeof EMAIL_FOOTER_POLICIES)[number];

/** Longest signature (sender identity or organization default), in characters. */
export const EMAIL_SIGNATURE_MAX_CHARS = 2000;

/**
 * Detail code (`errors[].code`) of `422 AUTOMATION_INVALID` when a
 * `send_email` action asks for `footer: none` and the policies or the
 * sender do not allow it (ADR-33 §4).
 */
export const EMAIL_FOOTER_NOT_ALLOWED = 'EMAIL_FOOTER_NOT_ALLOWED';

/**
 * Detail code (`VALIDATION_FAILED`) of a signature containing `{{`:
 * signatures are static text, never templates (ADR-33 §3).
 */
export const PLACEHOLDER_NOT_ALLOWED = 'PLACEHOLDER_NOT_ALLOWED';

/**
 * A signature: narrow Markdown, no placeholders; at most two images, each
 * an email asset of the organization (`![alt](asset:att_…)`, T534).
 */
export const emailSignatureSchema = z
  .string()
  .max(EMAIL_SIGNATURE_MAX_CHARS)
  .meta({
    description:
      `Narrow Markdown, at most ${String(EMAIL_SIGNATURE_MAX_CHARS)} characters; no ` +
      'placeholders (`{{` → `PLACEHOLDER_NOT_ALLOWED`); at most 2 images ' +
      '`![alt](asset:att_… =width)` of ready signature assets of the organization ' +
      '(`TOO_MANY_IMAGES`, `EMAIL_IMAGE_NOT_FOUND`); any other image syntax (URL, `data:`) → ' +
      '`IMAGE_SOURCE_NOT_ALLOWED`',
  });

// --- Attachments of automation emails (T532) -----------------------------------------

const MIB = 1024 * 1024;
/** Default of env `EMAIL_MAX_ATTACHMENTS` (files of one email). */
export const DEFAULT_EMAIL_MAX_ATTACHMENTS = 10;
/** Highest `EMAIL_MAX_ATTACHMENTS` an instance may set. */
export const EMAIL_MAX_ATTACHMENTS_CEILING = 20;
/** Default of env `EMAIL_MAX_ATTACHMENT_BYTES` (original files of one email, in all): 15 MiB. */
export const DEFAULT_EMAIL_MAX_ATTACHMENT_BYTES = 15 * MIB;
/** Highest `EMAIL_MAX_ATTACHMENT_BYTES` an instance may set: 30 MiB. */
export const EMAIL_MAX_ATTACHMENT_BYTES_CEILING = 30 * MIB;
/** Lowest attachment byte limit (env or organization): 1 MiB. */
export const EMAIL_MIN_ATTACHMENT_BYTES = MIB;
/**
 * The whole encoded message (base64 attachments, both body parts, headers)
 * at most 25 MiB — or what the instance byte limit needs, when its operator
 * raised `EMAIL_MAX_ATTACHMENT_BYTES` above the default (T532).
 */
export const EMAIL_MAX_MESSAGE_BYTES = 25 * MIB;

const orgMaxAttachmentsSchema = z.int().min(1).max(EMAIL_MAX_ATTACHMENTS_CEILING);
const orgMaxAttachmentBytesSchema = z
  .int()
  .min(EMAIL_MIN_ATTACHMENT_BYTES)
  .max(EMAIL_MAX_ATTACHMENT_BYTES_CEILING);

export const automationEmailSettingsSchema = z
  .object({
    instance_footer_policy: z.enum(EMAIL_INSTANCE_FOOTER_POLICIES).meta({
      description:
        'Env `EMAIL_AUTOMATION_FOOTER`; `required` makes `footer_policy` ineffective (no `none`)',
    }),
    footer_policy: z.enum(EMAIL_FOOTER_POLICIES),
    footer_none_allowed: z.boolean().meta({
      description:
        'Whether `send_email` may choose `footer: none` (still only with a verified `send_as` ' +
        'identity)',
    }),
    default_signature_md: z.string().nullable().meta({
      description: 'Signature of automation emails sent by the system sender',
    }),
    system_sender_enabled: z.boolean().meta({
      description: 'Automations may send with the system sender (`identity_id: null`)',
    }),
    max_attachments: orgMaxAttachmentsSchema.meta({
      description:
        'Files of one automation email in force: the organization value, at most ' +
        '`limits.max_attachments` (the instance cap; also the default)',
    }),
    max_attachment_bytes: orgMaxAttachmentBytesSchema.meta({
      description:
        'Bytes of the original files of one automation email in force (inline images count ' +
        'too, T534), at most `limits.max_attachment_bytes`',
    }),
    attachment_limits_custom: z.boolean().meta({
      description: 'The organization chose its own attachment limits (else the instance caps)',
    }),
    system_sender_usage: z
      .object({
        automations: z.number().int().min(0),
        enabled_automations: z.number().int().min(0),
      })
      .meta({
        description:
          'Automations (not deleted) with a `send_email` step using the system sender: their ' +
          'steps fail while the system sender is disabled',
      }),
  })
  .meta({
    id: 'AutomationEmailSettings',
    description: 'Footer policy, default signature and system sender of automation emails',
  });
export type AutomationEmailSettingsDto = z.infer<typeof automationEmailSettingsSchema>;

export const updateEmailSettingsRequestSchema = z
  .strictObject({
    footer_policy: z.enum(EMAIL_FOOTER_POLICIES).optional(),
    default_signature_md: emailSignatureSchema.nullable().optional(),
    system_sender_enabled: z.boolean().optional(),
    max_attachments: orgMaxAttachmentsSchema
      .nullable()
      .optional()
      .meta({
        description:
          'At most `limits.max_attachments` (`422 VALIDATION_FAILED` / `TOO_BIG`); `null` = the ' +
          'instance cap',
      }),
    max_attachment_bytes: orgMaxAttachmentBytesSchema
      .nullable()
      .optional()
      .meta({
        description:
          'At most `limits.max_attachment_bytes` (`422 VALIDATION_FAILED` / `TOO_BIG`); `null` = ' +
          'the instance cap',
      }),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one property is required',
  })
  .meta({ id: 'UpdateEmailSettingsRequest' });
export type UpdateEmailSettingsRequest = z.infer<typeof updateEmailSettingsRequestSchema>;

export const emailSettingsSchema = z
  .object({
    smtp: z.object({
      configured: z.boolean(),
      /** Masked: `***.example.com`. */
      host: z.string().nullable(),
      port: z.number().int().min(1).max(65535).nullable(),
      security: z.enum(SMTP_SECURITY_MODES).nullable(),
      from: z.string().nullable().meta({ description: 'Address of `SMTP_FROM`' }),
      from_name: z.string().nullable(),
      allowed_from_domains: z.array(z.string()),
    }),
    limits: z.object({
      max_per_hour_per_org: z.number().int().positive(),
      max_recipients: z.number().int().positive(),
      max_per_second_per_process: z.number().int().positive(),
      test_sends_per_minute: z.number().int().positive(),
      max_html_bytes: z.number().int().positive(),
      max_attachments: z.number().int().positive().meta({
        description: 'Env `EMAIL_MAX_ATTACHMENTS`: cap of the organization value',
      }),
      max_attachment_bytes: z.number().int().positive().meta({
        description: 'Env `EMAIL_MAX_ATTACHMENT_BYTES`: cap of the organization value',
      }),
      max_inline_images: z
        .number()
        .int()
        .positive()
        .meta({
          description:
            'Env `EMAIL_MAX_INLINE_IMAGES`: images of one automation email, signature included ' +
            '(T534); their bytes count toward `max_attachment_bytes`',
        }),
    }),
    usage: z.object({
      sent_this_hour: z.number().int().min(0),
      resets_at: isoDateTimeSchema,
    }),
    automation: automationEmailSettingsSchema,
  })
  .meta({
    id: 'EmailSettings',
    description:
      'Instance SMTP status, email limits and automation email settings of the organization ' +
      '(never the SMTP password or full URL)',
  });
export type EmailSettingsDto = z.infer<typeof emailSettingsSchema>;

export const emailTestResultSchema = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('sent'),
      /** The caller's own address. */
      to: z.string(),
      message_id: z.string(),
      smtp: smtpReplySchema,
    }),
    z.object({
      status: z.literal('failed'),
      code: z.enum(['smtp_temporary', 'smtp_rejected']),
      reason: z.enum(SMTP_FAILURE_REASONS),
      smtp: smtpReplySchema,
    }),
  ])
  .meta({ id: 'EmailTestResult', description: 'Outcome of the SMTP connection test' });
export type EmailTestResult = z.infer<typeof emailTestResultSchema>;
