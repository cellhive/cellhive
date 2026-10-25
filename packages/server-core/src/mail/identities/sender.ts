import { unsealSecret } from '../../auth/secret-box.js';
import { domainOf } from '../address.js';
import { mailLocaleOf } from '../templates.js';
import { INSTANCE_TRANSPORT, type MailTransportRef } from '../transport.js';

import type { EmailIdentitiesRepository } from './email-identities.repository.js';
import type { MailConfig } from '../../config/load-config.js';
import type { OrgScope } from '../../db/repository.js';
import type { EmailIdentityRow } from '../../db/schema.js';
import type { MailAddress } from '../mailer.js';
import type {
  EmailIdentityHint,
  EmailIdentityMode,
  EmailIdentityTransport,
  Id,
} from '@cellhive/contracts';
import type { Buffer } from 'node:buffer';

/**
 * Who an automation email is from (ADR-33 §1): the system sender
 * (`SMTP_FROM`) or a verified identity, in the mode the server computes —
 * never chosen by the user, never silently rewritten.
 */

/**
 * `smtp` → always `send_as`; `system` → `send_as` when the domain is in
 * `SMTP_ALLOWED_FROM_DOMAINS` (or the address is `SMTP_FROM`), else
 * `on_behalf`. Without instance SMTP a `system` identity is `on_behalf`.
 */
export function identityModeOf(
  transport: EmailIdentityTransport,
  email: string,
  mail: MailConfig | null,
): EmailIdentityMode {
  if (transport === 'smtp') return 'send_as';
  if (mail === null) return 'on_behalf';
  const allowed =
    email.toLowerCase() === mail.fromAddress.toLowerCase() ||
    mail.allowedFromDomains.includes(domainOf(email));
  return allowed ? 'send_as' : 'on_behalf';
}

const VIA_SUFFIX = { en: '(via Cellhive)', vi: '(qua Cellhive)' } as const;

/** `HR` → `HR (via Cellhive)` in the organization's language. */
export function onBehalfName(displayName: string, locale: string | null | undefined): string {
  return `${displayName} ${VIA_SUFFIX[mailLocaleOf(locale)]}`;
}

export interface SenderHeaders {
  readonly mode: EmailIdentityMode;
  /** `undefined` = `SMTP_FROM` as configured (instance transport only). */
  readonly from: MailAddress | undefined;
  readonly replyTo: readonly MailAddress[];
}

/** `From`/`Reply-To` of a message sent as `identity` (its current mode). */
export function senderHeadersOf(
  identity: Pick<EmailIdentityRow, 'transport' | 'email' | 'display_name' | 'reply_to'>,
  mail: MailConfig | null,
  locale: string | null | undefined,
): SenderHeaders {
  const mode = identityModeOf(identity.transport, identity.email, mail);
  if (mode === 'send_as') {
    return {
      mode,
      from: { address: identity.email, name: identity.display_name },
      replyTo: identity.reply_to === null ? [] : [{ address: identity.reply_to }],
    };
  }
  return {
    mode,
    from:
      mail === null
        ? undefined
        : { address: mail.fromAddress, name: onBehalfName(identity.display_name, locale) },
    // Replies go to the identity (or its own Reply-To).
    replyTo: [{ address: identity.reply_to ?? identity.email }],
  };
}

/**
 * `From`/`Reply-To` of the verification email of `identity` (ADR-33 §2,
 * T528): the display name is not verified yet, so it never reaches a
 * header. `system` → the instance sender (`SMTP_FROM` as configured);
 * `smtp` → the identity's own address, without a name (the email must leave
 * from that mailbox to prove it). No Reply-To: nobody needs to answer it.
 */
export function verificationSenderOf(identity: Pick<EmailIdentityRow, 'transport' | 'email'>): {
  readonly from: MailAddress | undefined;
  readonly replyTo: readonly MailAddress[];
} {
  return identity.transport === 'smtp'
    ? { from: { address: identity.email }, replyTo: [] }
    : { from: undefined, replyTo: [] };
}

function quoted(address: MailAddress): string {
  const name = address.name ?? '';
  return name === '' ? `<${address.address}>` : `"${name}" <${address.address}>`;
}

/** What recipients see, for the identity page and the automation builder. */
export function senderDisplayOf(
  identity: Pick<EmailIdentityRow, 'transport' | 'email' | 'display_name' | 'reply_to'>,
  mail: MailConfig | null,
  locale: string | null | undefined,
): { from: string; reply_to: string | null } {
  const headers = senderHeadersOf(identity, mail, locale);
  const from =
    headers.from === undefined
      ? `"${onBehalfName(identity.display_name, locale)}" <SMTP_FROM>`
      : quoted(headers.from);
  const replyTo = headers.replyTo.map(quoted).join(', ');
  return { from, reply_to: replyTo === '' ? null : replyTo };
}

/** Hints the UI explains next to an identity (`EMAIL_IDENTITY_HINTS`). */
export function identityHintsOf(
  identity: Pick<EmailIdentityRow, 'transport' | 'email' | 'smtp_security'>,
  mail: MailConfig | null,
): EmailIdentityHint[] {
  const hints: EmailIdentityHint[] = [];
  const mode = identityModeOf(identity.transport, identity.email, mail);
  hints.push(mode === 'send_as' ? 'spf_dkim_alignment' : 'sent_on_behalf');
  if (identity.transport === 'smtp') {
    hints.push('basic_auth_restricted');
    if (identity.smtp_security === 'none') hints.push('insecure_connection');
  }
  return hints;
}

/**
 * The transport a message of `identity` goes through: the instance SMTP,
 * or its own SMTP (password unsealed only when the transport is built).
 */
export function identityTransportOf(identity: EmailIdentityRow, smtpKey: Buffer): MailTransportRef {
  if (identity.transport === 'system') return INSTANCE_TRANSPORT;
  const { smtp_host, smtp_port, smtp_security, smtp_username, smtp_password_enc } = identity;
  if (
    smtp_host === null ||
    smtp_port === null ||
    smtp_security === null ||
    smtp_username === null ||
    smtp_password_enc === null
  ) {
    throw new TypeError('identity transport: incomplete SMTP settings');
  }
  return {
    kind: 'identity',
    identityId: identity.id,
    version: identity.smtp_version,
    endpoint: {
      host: smtp_host,
      port: smtp_port,
      security: smtp_security,
      username: smtp_username,
    },
    credentials: () =>
      Promise.resolve({ user: smtp_username, pass: unsealSecret(smtpKey, smtp_password_enc) }),
    fromAddress: identity.email,
  };
}

/** A sender ready for `Mailer.send`. */
export interface ResolvedSender {
  /** `null` = the system sender (`SMTP_FROM`). */
  readonly identityId: Id<'eid'> | null;
  readonly mode: EmailIdentityMode;
  readonly from: MailAddress | undefined;
  readonly replyTo: readonly MailAddress[];
  readonly transport: MailTransportRef;
  /**
   * The identity's signature (`signature_md`, T531); `null` for the system
   * sender, whose signature is the organization default
   * (`composeAutomationEmail` picks it).
   */
  readonly signatureMd: string | null;
}

export type ResolveSenderResult =
  | { readonly ok: true; readonly sender: ResolvedSender }
  /**
   * Unverified, disabled, out of scope, missing or of another organization
   * alike; or the system sender while the organization disabled it (T531).
   */
  | { readonly ok: false; readonly code: 'email_identity_unavailable' };

export interface SenderResolverDeps {
  readonly identities: EmailIdentitiesRepository;
  readonly mail: MailConfig | null;
  /** `deriveSecretKey(APP_MASTER_KEY, 'email-identity-smtp')`. */
  readonly smtpKey: Buffer;
}

/**
 * `resolveSender` (T530 for T514/T531): the system sender when
 * `identityId` is `null` and the organization allows it
 * (`organizations.settings.email.system_sender_enabled`, T531); else the
 * identity when an automation of `baseId` may send as it right now
 * (checked again at run time, ADR-33 §1). Never falls back from one to the
 * other.
 */
export async function resolveSender(
  deps: SenderResolverDeps,
  scope: OrgScope,
  input: {
    readonly identityId: Id<'eid'> | null;
    readonly baseId: Id<'bse'>;
    /** Language of `(via Cellhive)`: the organization's. */
    readonly locale: string | null | undefined;
    /** `orgEmailSettingsOf(settings).systemSenderEnabled` (T531). */
    readonly systemSenderEnabled: boolean;
  },
): Promise<ResolveSenderResult> {
  if (input.identityId === null) {
    if (!input.systemSenderEnabled) return { ok: false, code: 'email_identity_unavailable' };
    return {
      ok: true,
      sender: {
        identityId: null,
        mode: 'send_as',
        from: undefined,
        replyTo: [],
        transport: INSTANCE_TRANSPORT,
        signatureMd: null,
      },
    };
  }
  const identity = await deps.identities.findUsable(scope, input.identityId, input.baseId);
  if (identity === undefined) return { ok: false, code: 'email_identity_unavailable' };
  const headers = senderHeadersOf(identity, deps.mail, input.locale);
  return {
    ok: true,
    sender: {
      identityId: identity.id,
      mode: headers.mode,
      from: headers.from,
      replyTo: headers.replyTo,
      transport: identityTransportOf(identity, deps.smtpKey),
      signatureMd: identity.signature_md,
    },
  };
}
