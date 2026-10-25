import type {
  EmailIdentityMode,
  EmailIdentityTransport,
  EmailSettingsDto,
} from '@cellhive/contracts';

/**
 * What recipients will see for an identity being typed (T533, ADR-33 §1):
 * the same rule the server applies (`identityModeOf`, `senderHeadersOf`),
 * fed by `GET /orgs/:id/email-settings` (`SMTP_FROM`, the domains sent
 * directly). Saved identities show the server's own `display` instead.
 */
export interface SenderPreview {
  readonly mode: EmailIdentityMode;
  /** `Name <address>`; `null` without instance SMTP for an `on_behalf` identity. */
  readonly from: string | null;
  readonly replyTo: string | null;
}

export interface SenderDraft {
  readonly email: string;
  readonly displayName: string;
  readonly replyTo: string;
  readonly transport: EmailIdentityTransport;
}

/** Domain of an address, lower case ASCII (IDN → punycode); `null` when not an address. */
export function domainOf(email: string): string | null {
  const at = email.trim().lastIndexOf('@');
  if (at <= 0) return null;
  const domain = email.trim().slice(at + 1);
  if (domain === '' || /[\s/?#@:]/u.test(domain)) return null;
  try {
    return new URL(`http://${domain}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Suffix of `on_behalf` names, in the organization's language (`(qua Cellhive)` for `vi`). */
export function viaSuffix(orgLocale: string | null | undefined): string {
  const language = (orgLocale ?? '').toLowerCase().split(/[-_]/u)[0];
  return language === 'vi' ? '(qua Cellhive)' : '(via Cellhive)';
}

export function modeOf(
  transport: EmailIdentityTransport,
  email: string,
  smtp: EmailSettingsDto['smtp'] | undefined,
): EmailIdentityMode {
  if (transport === 'smtp') return 'send_as';
  if (smtp?.configured !== true || smtp.from === null) return 'on_behalf';
  const address = email.trim().toLowerCase();
  if (address === smtp.from.toLowerCase()) return 'send_as';
  const domain = domainOf(address);
  return domain !== null && smtp.allowed_from_domains.includes(domain) ? 'send_as' : 'on_behalf';
}

function named(name: string, address: string): string {
  return name.trim() === '' ? `<${address}>` : `${name.trim()} <${address}>`;
}

/** The live preview of a draft; `null` until the address looks like one. */
export function previewSender(
  draft: SenderDraft,
  smtp: EmailSettingsDto['smtp'] | undefined,
  orgLocale: string | null | undefined,
): SenderPreview | null {
  const email = draft.email.trim().toLowerCase();
  if (domainOf(email) === null) return null;
  const replyTo = draft.replyTo.trim() === '' ? null : draft.replyTo.trim().toLowerCase();
  const mode = modeOf(draft.transport, email, smtp);
  if (mode === 'send_as') {
    return { mode, from: named(draft.displayName, email), replyTo };
  }
  const name = `${draft.displayName.trim()} ${viaSuffix(orgLocale)}`.trim();
  const from = smtp?.from === null || smtp?.from === undefined ? null : named(name, smtp.from);
  return { mode, from, replyTo: replyTo ?? email };
}

/** `"HR" <hr@corp.vn>` (header form of the server) → `HR <hr@corp.vn>`. */
export function readableAddress(header: string): string {
  return header.replace(/"((?:[^"\\]|\\.)*)"\s*</gu, (_match, name: string) => {
    return `${name.replace(/\\(.)/gu, '$1')} <`;
  });
}
