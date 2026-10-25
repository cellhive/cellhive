import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import {
  EMAIL_FAILURE_CODES,
  EMAIL_SIGNATURE_MAX_CHARS,
  SMTP_FAILURE_REASONS,
  SMTP_SECURITY_MODES,
  smtpReplySchema,
} from './email.js';
import { idOf } from './ids.js';

/**
 * Sender identities (CONTRACTS §23.3, ADR-33, BACKLOG T530): addresses an
 * organization owner/admin declares and verifies (`hr@corp.vn`), which
 * automation emails may be sent as. Transport `system` goes through the
 * instance SMTP (`send_as` when the domain is in `SMTP_ALLOWED_FROM_DOMAINS`,
 * else `on_behalf`); transport `smtp` logs into the identity's own SMTP
 * server (always `send_as`). The SMTP password is write-only.
 */

/** `system`: the instance SMTP; `smtp`: the identity's own SMTP server. */
export const EMAIL_IDENTITY_TRANSPORTS = ['system', 'smtp'] as const;
export type EmailIdentityTransport = (typeof EMAIL_IDENTITY_TRANSPORTS)[number];

/**
 * Computed by the server, never chosen: `send_as` → `From: "<name>" <address>`;
 * `on_behalf` → `From: "<name> (via Cellhive)" <SMTP_FROM>` + `Reply-To: <address>`.
 */
export const EMAIL_IDENTITY_MODES = ['send_as', 'on_behalf'] as const;
export type EmailIdentityMode = (typeof EMAIL_IDENTITY_MODES)[number];

export const EMAIL_IDENTITY_STATUSES = ['pending', 'verified', 'error', 'disabled'] as const;
export type EmailIdentityStatus = (typeof EMAIL_IDENTITY_STATUSES)[number];

export const EMAIL_IDENTITY_VERIFIED_VIA = ['link', 'code'] as const;
export type EmailIdentityVerifiedVia = (typeof EMAIL_IDENTITY_VERIFIED_VIA)[number];

export const EMAIL_IDENTITY_BASE_SCOPES = ['all', 'selected'] as const;
export type EmailIdentityBaseScope = (typeof EMAIL_IDENTITY_BASE_SCOPES)[number];

/** Why an identity is in `error` (repeated authentication failures while sending). */
export const EMAIL_IDENTITY_ERROR_REASONS = ['auth_failed'] as const;
export type EmailIdentityErrorReason = (typeof EMAIL_IDENTITY_ERROR_REASONS)[number];

/** The only SMTP ports an identity may use (ADR-33 §1A). */
export const EMAIL_IDENTITY_SMTP_PORTS = [25, 465, 587, 2525] as const;
export type EmailIdentitySmtpPort = (typeof EMAIL_IDENTITY_SMTP_PORTS)[number];

export const EMAIL_IDENTITY_DISPLAY_NAME_MAX = 100;
export const EMAIL_IDENTITY_SIGNATURE_MAX = EMAIL_SIGNATURE_MAX_CHARS;
/** Identities per organization. */
export const EMAIL_IDENTITIES_MAX_PER_ORG = 100;
/** Bases of a `selected` scope. */
export const EMAIL_IDENTITY_MAX_BASES = 500;

/** Verification (ADR-33 §2). */
export const EMAIL_VERIFICATION_TTL_HOURS = 24;
export const EMAIL_VERIFICATION_CODE_LENGTH = 6;
export const EMAIL_VERIFICATION_MAX_CODE_ATTEMPTS = 5;
export const EMAIL_VERIFICATION_SENDS_PER_HOUR_PER_IDENTITY = 3;
export const EMAIL_VERIFICATION_SENDS_PER_DAY_PER_ORG = 20;
/** Consecutive authentication failures while sending that put an `smtp` identity in `error`. */
export const EMAIL_IDENTITY_AUTH_FAILURES_TO_ERROR = 3;

/**
 * Run step `error.code` of `send_email` with an identity (T514): the
 * identity is not usable any more (disabled, deleted, out of scope, not
 * verified) / its SMTP keeps refusing the credentials (`status = error`).
 * The automation stays enabled in both cases.
 */
export const EMAIL_IDENTITY_RUN_ERROR_CODES = [
  'email_identity_unavailable',
  'email_identity_auth_failed',
] as const;
export type EmailIdentityRunErrorCode = (typeof EMAIL_IDENTITY_RUN_ERROR_CODES)[number];

/**
 * Detail code (`errors[].code`) of `422 AUTOMATION_INVALID` when an action
 * names an identity the editor may not use — unverified, disabled, out of
 * the base scope, missing or of another organization alike (no existence
 * leak, ADR-33 §1).
 */
export const EMAIL_IDENTITY_NOT_USABLE = 'EMAIL_IDENTITY_NOT_USABLE';

/**
 * Detail code (`errors[].code`, path `display_name`) of `422 VALIDATION_FAILED`
 * when a display name could pass for an address or a link in the `From`
 * header (BACKLOG T540, QA S5 M7): `params.reason` is one of
 * `DISPLAY_NAME_ISSUES`.
 */
export const DISPLAY_NAME_NOT_ALLOWED = 'DISPLAY_NAME_NOT_ALLOWED';

/**
 * Why a display name is refused, in the order they are checked: control
 * characters (C0/C1, U+2028/U+2029, bidirectional embeddings, overrides and
 * isolates), `<`/`>`, `@`, then anything that looks like a URL or a domain
 * name (`looksLikeAddressOrUrl`). Brackets, `@` and URLs are matched after
 * NFKC normalization (fullwidth `＠`, `＜`, `．` count).
 */
export const DISPLAY_NAME_ISSUES = ['control_char', 'angle_bracket', 'at_sign', 'url'] as const;
export type DisplayNameIssue = (typeof DISPLAY_NAME_ISSUES)[number];

// eslint-disable-next-line no-control-regex -- the point is to match control characters
const DISPLAY_NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/**
 * Invisible characters that could hide a dot or split a label: format
 * characters (zero-width space, soft hyphen…) and every default-ignorable
 * code point (combining grapheme joiner, variation selectors… — QA T559).
 */
const FORMAT_CHARACTERS = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/** `.` and the full stops IDNA treats as label separators (U+3002, U+FF0E, U+FF61). */
const DOT = '[.\u3002\uff0e\uff61]';
/** A scheme starting a token (the look-behind keeps the scan linear). */
const URL_SCHEME = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\//iu;
const WWW_PREFIX = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])www\\d{0,3}${DOT}`, 'iu');
/**
 * A label: starts with a letter or digit, then letters, marks, digits, `-`.
 * No nested quantifier, and the look-behind below stops a match from starting
 * inside a word, so the scan stays linear in the length of the name.
 */
const LABEL = '[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}-]*';
/** A top-level domain: punycode (`xn--p1ai`) or at least two letters (`com`, `vn`, `рф`). */
const TLD = '(?:xn--[a-z0-9-]+|\\p{L}[\\p{L}\\p{M}]+)';
const DOMAIN_LIKE = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}-])${LABEL}${DOT}${TLD}(?![\\p{L}\\p{M}\\p{N}-])`,
  'iu',
);

/**
 * Whether `value` contains something a mail client or a reader could take for
 * a web address: a scheme (`xxx://`), `www.`, or a `label.tld` domain whose
 * top-level domain has at least two letters (Unicode/IDN and punycode
 * included). A dot followed by a space (`Dept. IT`, a full stop) or preceded
 * by one (`example .com`) is not a domain; neither is a number (`2.0`).
 * Invisible format characters are ignored so that `example\u200b.com` counts.
 */
export function looksLikeAddressOrUrl(value: string): boolean {
  const text = value.normalize('NFKC').replace(FORMAT_CHARACTERS, '');
  return URL_SCHEME.test(text) || WWW_PREFIX.test(text) || DOMAIN_LIKE.test(text);
}

/**
 * The first reason `value` may not be a display name (`null` when it may).
 * Used by the request schemas and, on read, for `display_name_issue` of rows
 * saved before the rule (they are flagged, never rewritten).
 */
export function displayNameIssueOf(value: string): DisplayNameIssue | null {
  if (DISPLAY_NAME_CONTROL.test(value)) return 'control_char';
  const text = value.normalize('NFKC');
  if (/[<>]/u.test(text)) return 'angle_bracket';
  if (text.includes('@')) return 'at_sign';
  if (looksLikeAddressOrUrl(value)) return 'url';
  return null;
}

const displayNameSchema = z
  .string()
  .min(1)
  .max(EMAIL_IDENTITY_DISPLAY_NAME_MAX)
  .superRefine((value, ctx) => {
    // Too long is already reported; do not scan an arbitrarily large input.
    if (value.length > EMAIL_IDENTITY_DISPLAY_NAME_MAX) return;
    const reason = displayNameIssueOf(value);
    if (reason !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'The display name may not contain @, < or >, control characters or a URL.',
        params: { code: DISPLAY_NAME_NOT_ALLOWED, reason },
      });
    }
  })
  .meta({
    description:
      'Shown in the `From` header. 1–100 characters; `@`, `<`, `>`, control characters ' +
      '(C0/C1, U+2028/U+2029, bidirectional overrides and isolates) and URL/domain ' +
      'look-alikes (`xxx://`, `www.`, `label.tld`) are refused with `DISPLAY_NAME_NOT_ALLOWED` ' +
      '(`params.reason`: `control_char`, `angle_bracket`, `at_sign`, `url`)',
  });

/** Hints the UI explains next to an identity (translated by code). */
export const EMAIL_IDENTITY_HINTS = [
  // `send_as`: SPF/DKIM of the domain must cover the sending server (DMARC alignment).
  'spf_dkim_alignment',
  // `smtp`: Microsoft 365/Gmail restrict basic SMTP AUTH; use an app password where allowed.
  'basic_auth_restricted',
  // `smtp` with `security = none`: credentials and mail travel in clear text.
  'insecure_connection',
  // `on_behalf`: recipients see "<name> (via Cellhive)" and reply to the identity.
  'sent_on_behalf',
] as const;
export type EmailIdentityHint = (typeof EMAIL_IDENTITY_HINTS)[number];

/** Opaque link token: `<org_id>.<32 random bytes, base64url>` (ADR-33 §2). */
export const EMAIL_VERIFICATION_TOKEN_PATTERN = /^org_[0-9A-Za-z]{16}\.[A-Za-z0-9_-]{43}$/;

export const emailIdentityIdSchema = idOf('eid');

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .meta({ description: 'Host name or IP address of the SMTP server (no scheme, no port)' });

const smtpPortSchema = z
  .union(EMAIL_IDENTITY_SMTP_PORTS.map((port) => z.literal(port)))
  .meta({ description: 'Only 25, 465, 587 or 2525' });

const addressInput = z.string().trim().min(3).max(254);

const signatureSchema = z
  .string()
  .max(EMAIL_IDENTITY_SIGNATURE_MAX)
  .nullable()
  .meta({
    description:
      'Narrow Markdown, no placeholders (`{{` → `PLACEHOLDER_NOT_ALLOWED`), at most 2 images ' +
      '`![alt](asset:att_…)` of signature assets of the organization (T534; other image ' +
      'syntax → `IMAGE_SOURCE_NOT_ALLOWED`); added below the body of automation emails sent ' +
      'as the identity (T531)',
  });

/** SMTP settings of a `smtp` identity. `password` is write-only. */
export const emailIdentitySmtpInputSchema = z
  .strictObject({
    host: hostSchema,
    port: smtpPortSchema,
    security: z.enum(SMTP_SECURITY_MODES),
    username: z.string().min(1).max(256),
    /** Required when creating or switching to `smtp`; omitted keeps the stored one. */
    password: z.string().min(1).max(1024).optional(),
    /** Must be `true` to save `security = none` (audited). */
    allow_insecure: z.boolean().optional(),
  })
  .meta({ id: 'EmailIdentitySmtpInput', description: 'SMTP server of the identity' });
export type EmailIdentitySmtpInput = z.infer<typeof emailIdentitySmtpInputSchema>;

export const createEmailIdentityRequestSchema = z
  .strictObject({
    email: addressInput,
    display_name: displayNameSchema,
    reply_to: addressInput.nullable().optional(),
    transport: z.enum(EMAIL_IDENTITY_TRANSPORTS),
    smtp: emailIdentitySmtpInputSchema.optional(),
    base_scope: z.enum(EMAIL_IDENTITY_BASE_SCOPES).default('all'),
    base_ids: z.array(idOf('bse')).max(EMAIL_IDENTITY_MAX_BASES).default([]),
    signature_md: signatureSchema.optional(),
  })
  .meta({ id: 'CreateEmailIdentityRequest' });
export type CreateEmailIdentityRequest = z.input<typeof createEmailIdentityRequestSchema>;
export type CreateEmailIdentityInput = z.output<typeof createEmailIdentityRequestSchema>;

export const updateEmailIdentityRequestSchema = z
  .strictObject({
    email: addressInput.optional(),
    display_name: displayNameSchema.optional(),
    reply_to: addressInput.nullable().optional(),
    transport: z.enum(EMAIL_IDENTITY_TRANSPORTS).optional(),
    smtp: emailIdentitySmtpInputSchema.optional(),
    base_scope: z.enum(EMAIL_IDENTITY_BASE_SCOPES).optional(),
    base_ids: z.array(idOf('bse')).max(EMAIL_IDENTITY_MAX_BASES).optional(),
    signature_md: signatureSchema.optional(),
  })
  .meta({ id: 'UpdateEmailIdentityRequest' });
export type UpdateEmailIdentityRequest = z.infer<typeof updateEmailIdentityRequestSchema>;

export const verifyEmailIdentityCodeRequestSchema = z
  .strictObject({ code: z.string().regex(/^\d{6}$/) })
  .meta({ id: 'VerifyEmailIdentityCodeRequest' });
export type VerifyEmailIdentityCodeRequest = z.infer<typeof verifyEmailIdentityCodeRequestSchema>;

export const emailVerificationTokenRequestSchema = z
  .strictObject({ token: z.string().min(1).max(200) })
  .meta({ id: 'EmailVerificationTokenRequest' });
export type EmailVerificationTokenRequest = z.infer<typeof emailVerificationTokenRequestSchema>;

export const emailIdentitySmtpSchema = z
  .object({
    host: z.string(),
    port: z.number().int(),
    security: z.enum(SMTP_SECURITY_MODES),
    username: z.string(),
    /** Always `true`: the password itself is never returned. */
    password_set: z.literal(true),
  })
  .meta({
    id: 'EmailIdentitySmtp',
    description: 'SMTP server of the identity (never the password)',
  });

export const emailIdentitySchema = z
  .object({
    id: emailIdentityIdSchema,
    organization_id: idOf('org'),
    email: z.string(),
    display_name: z.string(),
    /**
     * Why the stored name would be refused today (T540): set for names saved
     * before the rule, which are kept (and still sent, escaped) until an
     * organization admin changes them.
     */
    display_name_issue: z
      .enum(DISPLAY_NAME_ISSUES)
      .nullable()
      .meta({
        description:
          '`null`, or why the stored display name would be refused today (saved before the ' +
          'rule; kept and still used until changed)',
      }),
    reply_to: z.string().nullable(),
    transport: z.enum(EMAIL_IDENTITY_TRANSPORTS),
    mode: z.enum(EMAIL_IDENTITY_MODES),
    status: z.enum(EMAIL_IDENTITY_STATUSES),
    error_reason: z.enum(EMAIL_IDENTITY_ERROR_REASONS).nullable(),
    verified_at: isoDateTimeSchema.nullable(),
    verified_via: z.enum(EMAIL_IDENTITY_VERIFIED_VIA).nullable(),
    base_scope: z.enum(EMAIL_IDENTITY_BASE_SCOPES),
    base_ids: z.array(idOf('bse')),
    signature_md: z.string().nullable(),
    smtp: emailIdentitySmtpSchema.nullable(),
    /** How recipients see the message: the `From` and `Reply-To` headers it gets. */
    display: z.object({ from: z.string(), reply_to: z.string().nullable() }),
    hints: z.array(z.enum(EMAIL_IDENTITY_HINTS)),
    verification: z.object({
      /** A link/code was sent and can still be used. */
      pending: z.boolean(),
      sent_at: isoDateTimeSchema.nullable(),
      expires_at: isoDateTimeSchema.nullable(),
      code_attempts_left: z.number().int().min(0).nullable(),
    }),
    created_by: idOf('usr').nullable(),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'EmailIdentity', description: 'Sender identity (organization owner/admin view)' });
export type EmailIdentityDto = z.infer<typeof emailIdentitySchema>;

export const emailIdentityListSchema = z
  .object({ items: z.array(emailIdentitySchema) })
  .meta({ id: 'EmailIdentityList' });
export type EmailIdentityList = z.infer<typeof emailIdentityListSchema>;

/** Step of the "Test & verify" run that failed. */
export const EMAIL_VERIFICATION_STEPS = ['connect', 'tls', 'auth', 'send'] as const;
export type EmailVerificationStep = (typeof EMAIL_VERIFICATION_STEPS)[number];

/**
 * Outcome of sending the verification email (create, address/transport
 * change, `send-verification`, `test-and-verify`). An SMTP failure is a
 * result, not an error response.
 */
export const emailVerificationOutcomeSchema = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('sent'),
      /** The identity's own address. */
      to: z.string(),
      expires_at: isoDateTimeSchema,
      smtp: smtpReplySchema,
    }),
    z.object({
      status: z.literal('failed'),
      step: z.enum(EMAIL_VERIFICATION_STEPS),
      code: z.enum(EMAIL_FAILURE_CODES),
      reason: z.enum(SMTP_FAILURE_REASONS).nullable(),
      smtp: smtpReplySchema,
    }),
    z.object({
      status: z.literal('rate_limited'),
      retry_after_seconds: z.number().int().min(1),
    }),
  ])
  .meta({ id: 'EmailVerificationOutcome' });
export type EmailVerificationOutcome = z.infer<typeof emailVerificationOutcomeSchema>;

export const emailIdentityMutationSchema = z
  .object({
    identity: emailIdentitySchema,
    /** `null` when the change did not require a new verification. */
    verification: emailVerificationOutcomeSchema.nullable(),
  })
  .meta({ id: 'EmailIdentityMutation' });
export type EmailIdentityMutation = z.infer<typeof emailIdentityMutationSchema>;

/** What an automation manager of a base sees: never SMTP settings. */
export const baseEmailIdentitySchema = z
  .object({
    id: emailIdentityIdSchema,
    email: z.string(),
    display_name: z.string(),
    mode: z.enum(EMAIL_IDENTITY_MODES),
  })
  .meta({ id: 'BaseEmailIdentity' });
export type BaseEmailIdentityDto = z.infer<typeof baseEmailIdentitySchema>;

export const baseEmailIdentityListSchema = z
  .object({ items: z.array(baseEmailIdentitySchema) })
  .meta({ id: 'BaseEmailIdentityList' });
export type BaseEmailIdentityList = z.infer<typeof baseEmailIdentityListSchema>;

export const emailIdentityUsagesSchema = z
  .object({
    items: z.array(
      z.object({
        automation_id: idOf('aut'),
        base_id: idOf('bse'),
        /** `null` when the caller cannot see the base. */
        name: z.string().nullable(),
      }),
    ),
    total: z.number().int().min(0),
  })
  .meta({ id: 'EmailIdentityUsages', description: 'Automations sending with the identity' });
export type EmailIdentityUsages = z.infer<typeof emailIdentityUsagesSchema>;

/** The public page `/verify-sender?token=…` before confirming (no state change). */
export const emailVerificationPreviewSchema = z
  .object({
    organization_name: z.string(),
    email: z.string(),
    display_name: z.string(),
    /** Display name of the admin who asked for the verification. */
    requested_by: z.string().nullable(),
    expires_at: isoDateTimeSchema,
  })
  .meta({ id: 'EmailVerificationPreview' });
export type EmailVerificationPreview = z.infer<typeof emailVerificationPreviewSchema>;

export const emailVerificationConfirmedSchema = z
  .object({ status: z.literal('verified'), email: z.string() })
  .meta({ id: 'EmailVerificationConfirmed' });
export type EmailVerificationConfirmed = z.infer<typeof emailVerificationConfirmedSchema>;
