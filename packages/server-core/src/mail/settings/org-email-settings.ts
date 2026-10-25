import { EMAIL_FOOTER_POLICIES, type EmailFooterPolicy } from '@cellhive/contracts';

import type { JsonObject, JsonValue } from '../../db/schema.js';

/**
 * `organizations.settings.email` (ADR-33 §1, §3, §4; BACKLOG T531, T532): the
 * organization's choices for automation emails. Stored in the settings
 * JSON of the organization (no table); missing or malformed keys read as
 * the defaults, so organizations created before T531 behave as documented.
 */
export interface OrgEmailSettings {
  /** `required` (default) | `author_choice`; effective only with `EMAIL_AUTOMATION_FOOTER=org`. */
  readonly footerPolicy: EmailFooterPolicy;
  /** Signature of automation emails sent by the system sender; `null` = none. */
  readonly defaultSignatureMd: string | null;
  /** Automations may send with the system sender (`identity_id: null`); default `true`. */
  readonly systemSenderEnabled: boolean;
  /** Files of one automation email (T532); `null` = the instance cap `EMAIL_MAX_ATTACHMENTS`. */
  readonly maxAttachments: number | null;
  /** Original bytes of those files (T532); `null` = the instance cap `EMAIL_MAX_ATTACHMENT_BYTES`. */
  readonly maxAttachmentBytes: number | null;
}

export const DEFAULT_ORG_EMAIL_SETTINGS: OrgEmailSettings = {
  footerPolicy: 'required',
  defaultSignatureMd: null,
  systemSenderEnabled: true,
  maxAttachments: null,
  maxAttachmentBytes: null,
};

/** The attachment limits of automation emails in force (T532). */
export interface EmailAttachmentLimits {
  /** Files of one email. */
  readonly maxAttachments: number;
  /** Original bytes of those files in all (inline images of T534 count too). */
  readonly maxAttachmentBytes: number;
}

/**
 * Limits in force for an organization: its own values, never above the
 * instance caps (`EMAIL_MAX_ATTACHMENTS`, `EMAIL_MAX_ATTACHMENT_BYTES`) —
 * an operator who lowers a cap after an organization chose more wins.
 */
export function effectiveAttachmentLimits(
  instance: { readonly maxAttachments: number; readonly maxAttachmentBytes: number },
  org: Pick<OrgEmailSettings, 'maxAttachments' | 'maxAttachmentBytes'>,
): EmailAttachmentLimits {
  return {
    maxAttachments: Math.min(instance.maxAttachments, org.maxAttachments ?? Infinity),
    maxAttachmentBytes: Math.min(instance.maxAttachmentBytes, org.maxAttachmentBytes ?? Infinity),
  };
}

function positiveInt(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function objectOf(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

/** The email settings of an organization from its `settings` JSON. */
export function orgEmailSettingsOf(settings: JsonValue | undefined): OrgEmailSettings {
  const email = objectOf(objectOf(settings)?.['email']);
  if (email === null) return DEFAULT_ORG_EMAIL_SETTINGS;
  const policy = email['footer_policy'];
  const signature = email['default_signature_md'];
  const enabled = email['system_sender_enabled'];
  return {
    footerPolicy: (EMAIL_FOOTER_POLICIES as readonly unknown[]).includes(policy)
      ? (policy as EmailFooterPolicy)
      : DEFAULT_ORG_EMAIL_SETTINGS.footerPolicy,
    defaultSignatureMd: typeof signature === 'string' && signature.trim() !== '' ? signature : null,
    systemSenderEnabled:
      typeof enabled === 'boolean' ? enabled : DEFAULT_ORG_EMAIL_SETTINGS.systemSenderEnabled,
    maxAttachments: positiveInt(email['max_attachments']),
    maxAttachmentBytes: positiveInt(email['max_attachment_bytes']),
  };
}

/** The stored form (`settings.email`) of `value`. */
export function orgEmailSettingsJson(value: OrgEmailSettings): JsonObject {
  return {
    footer_policy: value.footerPolicy,
    default_signature_md: value.defaultSignatureMd,
    system_sender_enabled: value.systemSenderEnabled,
    max_attachments: value.maxAttachments,
    max_attachment_bytes: value.maxAttachmentBytes,
  };
}
