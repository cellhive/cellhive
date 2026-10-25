import type {
  AutomationEmailPreview,
  BaseEmailIdentityDto,
  EmailFooterLevel,
  EmailIdentityMode,
  EmailRecipientValue,
  EmailSettingsDto,
  FieldDto,
  SendEmailConfig,
} from '@cellhive/contracts';

/**
 * Pure rules of the `send_email` editor (T522, ADR-33, CONTRACTS §21/§23):
 * the senders a step may use and what recipients will see, when the footer
 * may be left out, recipient tokens, attachment estimates. The server
 * decides again on save, preview and test; this only explains it up front.
 */

/** People fields: their account email is the address (CONTRACTS §21). */
export const USER_FIELD_TYPES: ReadonlySet<string> = new Set(['user', 'created_by', 'updated_by']);

/** A field whose value may hold recipients: people, or text with the `email` style. */
export function isRecipientField(field: Pick<FieldDto, 'type' | 'options'>): boolean {
  if (USER_FIELD_TYPES.has(field.type)) return true;
  if (field.type !== 'text') return false;
  const options = field.options as { style?: { type?: unknown } } | null | undefined;
  return options?.style?.type === 'email';
}

/** How a sender sends: the system sender, or a verified identity `send_as` / `on_behalf`. */
export type SenderMode = 'system' | EmailIdentityMode;

export interface SenderOption {
  /** `system`, or the identity id. */
  readonly key: string;
  readonly identityId: BaseEmailIdentityDto['id'] | null;
  readonly name: string;
  /** The identity's address; the system address when known (`SMTP_FROM`). */
  readonly email: string | null;
  readonly mode: SenderMode;
}

export const SYSTEM_SENDER_KEY = 'system';

/** What is known of the organization's email settings (org owners/admins read them). */
export interface SenderContext {
  /** `null`: not known to this person (only org owners/admins read the settings). */
  readonly systemSenderEnabled: boolean | null;
  readonly smtpFrom: string | null;
  readonly orgName: string;
}

/**
 * The senders of the picker (Quyết định S5 thiết kế #1): the system sender
 * first (unless the organization turned it off), then the verified
 * identities of the base. The current choice is kept even when it is no
 * longer offered (`missing`), so the editor can say why.
 */
export function senderOptions(
  identities: readonly BaseEmailIdentityDto[],
  context: SenderContext,
): SenderOption[] {
  const out: SenderOption[] = [];
  if (context.systemSenderEnabled !== false) {
    out.push({
      key: SYSTEM_SENDER_KEY,
      identityId: null,
      name: context.orgName,
      email: context.smtpFrom,
      mode: 'system',
    });
  }
  for (const identity of identities) {
    out.push({
      key: identity.id,
      identityId: identity.id,
      name: identity.display_name,
      email: identity.email,
      mode: identity.mode,
    });
  }
  return out;
}

export function senderKeyOf(identityId: string | null): string {
  return identityId ?? SYSTEM_SENDER_KEY;
}

/** Radio list up to this many senders, a searchable combobox above (Quyết định S5 thiết kế #1). */
export const SENDER_RADIO_MAX = 5;

/** Suffix of `on_behalf` names, in the organization's language (CONTRACTS §23.3). */
export function viaSuffix(orgLocale: string | null | undefined): string {
  const language = (orgLocale ?? '').toLowerCase().split(/[-_]/u)[0];
  return language === 'vi' ? '(qua Cellhive)' : '(via Cellhive)';
}

function named(name: string, address: string): string {
  return name.trim() === '' ? address : `${name.trim()} <${address}>`;
}

/**
 * "Recipients will see" of a sender (ADR-33 §1): `From` and the `Reply-To`
 * that goes with it. `systemAddress` stands for `SMTP_FROM` when this person
 * cannot read it.
 */
export function displayedSender(
  option: SenderOption,
  smtpFrom: string | null,
  orgLocale: string | null | undefined,
  systemAddress: string,
): { from: string; replyTo: string | null } {
  const system = smtpFrom ?? systemAddress;
  switch (option.mode) {
    case 'system':
      return { from: named(option.name, system), replyTo: null };
    case 'send_as':
      return { from: named(option.name, option.email ?? system), replyTo: null };
    case 'on_behalf':
      return {
        from: named(`${option.name} ${viaSuffix(orgLocale)}`, system),
        replyTo: option.email,
      };
  }
}

/** `"HR" <hr@corp.vn>` (a header as the server writes it) → `HR <hr@corp.vn>`. */
export function readableAddress(header: string): string {
  return header.replace(/"((?:[^"\\]|\\.)*)"\s*</gu, (_match, name: string) => {
    return `${name.replace(/\\(.)/gu, '$1')} <`;
  });
}

/** Why `none` (no footer) cannot be chosen; `null` when it can. */
export type FooterLock = 'system' | 'on_behalf' | 'policy' | null;

/**
 * Footer levels (CONTRACTS §23.4): `none` only when the policies allow it
 * **and** the sender is a verified `send_as` identity. `policyAllowsNone`
 * is `null` when unknown (the server checks on save, `EMAIL_FOOTER_NOT_ALLOWED`).
 */
export function footerLock(mode: SenderMode | null, policyAllowsNone: boolean | null): FooterLock {
  if (mode === 'system' || mode === null) return 'system';
  if (mode === 'on_behalf') return 'on_behalf';
  if (policyAllowsNone === false) return 'policy';
  return null;
}

/**
 * The footer recipients will get: `none` saved earlier but no longer
 * allowed falls back to `minimal` at run time (policy tightened, sender
 * changed — CONTRACTS §23.4).
 */
export function effectiveFooter(footer: EmailFooterLevel, lock: FooterLock): EmailFooterLevel {
  return footer === 'none' && lock !== null ? 'minimal' : footer;
}

const SEPARATORS = /[,;\s]+/u;
/** Loose check before the server parses each address (dot-atom, IDN): `x@y.z`. */
const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/u;

export function isEmailAddress(text: string): boolean {
  return text.length <= 320 && ADDRESS.test(text);
}

/** Addresses typed or pasted in a recipient box: split on `,`, `;` and spaces. */
export function splitAddresses(input: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const piece of input.split(SEPARATORS)) {
    const text = piece.trim().replace(/^<|>$/gu, '');
    if (text === '') continue;
    (isEmailAddress(text) ? valid : invalid).push(text);
  }
  return { valid, invalid };
}

/** Literal recipients as one token each (a stored list literal shows as its addresses). */
export function recipientTokens(values: readonly EmailRecipientValue[]): EmailRecipientValue[] {
  return values.flatMap((value) =>
    'literal' in value && Array.isArray(value.literal)
      ? value.literal.map((address) => ({ literal: address }))
      : [value],
  );
}

/** Lower-case addresses already in a list, to keep it free of duplicates. */
export function literalAddresses(values: readonly EmailRecipientValue[]): Set<string> {
  const out = new Set<string>();
  for (const value of recipientTokens(values)) {
    if ('literal' in value && typeof value.literal === 'string') {
      out.add(value.literal.toLowerCase());
    }
  }
  return out;
}

/** Adds addresses as literal tokens (duplicates left out). */
export function addAddresses(
  values: readonly EmailRecipientValue[],
  addresses: readonly string[],
): EmailRecipientValue[] {
  const seen = literalAddresses(values);
  const next = [...values];
  for (const address of addresses) {
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    next.push({ literal: address });
  }
  return next;
}

/** A recipient value's identity, for "already in the list" and React keys. */
export function recipientKey(value: EmailRecipientValue): string {
  if ('literal' in value) {
    return `literal:${Array.isArray(value.literal) ? value.literal.join(',') : value.literal}`;
  }
  if ('field' in value) return `field:${value.field}`;
  if ('step' in value) return `step:${value.step}:${value.path ?? ''}`;
  return `trigger:${value.trigger}`;
}

/** Reply-To choices as `<select>` values (`ADR-33 §1`: no literal, no text field). */
export type ReplyToValue = SendEmailConfig['reply_to'];

export function replyToKey(value: ReplyToValue): string {
  if (value === null) return 'default';
  if ('identity_id' in value) return `identity:${value.identity_id}`;
  if ('field' in value) return `field:${value.field}`;
  if ('run_as' in value) return 'run_as';
  return 'clicked_by';
}

export function replyToOf(key: string): ReplyToValue {
  if (key === 'run_as') return { run_as: true };
  if (key === 'clicked_by') return { trigger: 'clicked_by' };
  if (key.startsWith('identity:')) {
    return { identity_id: key.slice('identity:'.length) as `eid_${string}` };
  }
  if (key.startsWith('field:')) return { field: key.slice('field:'.length) as `fld_${string}` };
  return null;
}

/** Limits the editor shows; `null` parts are unknown to this person. */
export interface EmailLimits {
  readonly maxAttachments: number | null;
  readonly maxAttachmentBytes: number | null;
  readonly maxRecipients: number | null;
  readonly maxHtmlBytes: number | null;
  readonly testSendsPerMinute: number;
}

/** Defaults of the instance (CONTRACTS §23.2) when the settings are not readable. */
export const DEFAULT_TEST_SENDS_PER_MINUTE = 5;

export function emailLimitsOf(
  settings: EmailSettingsDto | undefined,
  preview: AutomationEmailPreview | undefined,
): EmailLimits {
  const size = preview?.warnings.find((warning) => warning.code === 'ATTACHMENTS_SIZE')?.params;
  const fromWarning = (key: string): number | null => {
    const value = size?.[key];
    return typeof value === 'number' ? value : null;
  };
  return {
    maxAttachments: settings?.automation.max_attachments ?? fromWarning('max_attachments'),
    maxAttachmentBytes:
      settings?.automation.max_attachment_bytes ?? fromWarning('max_attachment_bytes'),
    maxRecipients: settings?.limits.max_recipients ?? null,
    maxHtmlBytes: settings?.limits.max_html_bytes ?? null,
    testSendsPerMinute: settings?.limits.test_sends_per_minute ?? DEFAULT_TEST_SENDS_PER_MINUTE,
  };
}

/** Bytes of the files a preview would attach. */
export function attachmentBytes(preview: Pick<AutomationEmailPreview, 'attachments'>): number {
  return preview.attachments.reduce((total, file) => total + file.size, 0);
}

/** UTF-8 size of the preview's HTML (the server's limit is on bytes). */
export function htmlBytes(html: string): number {
  return new TextEncoder().encode(html).length;
}

/** Sends of "Send a test to me" left in the last minute, from the times of earlier sends. */
export function testSendsLeft(sentAt: readonly number[], now: number, perMinute: number): number {
  const recent = sentAt.filter((time) => now - time < 60_000).length;
  return Math.max(0, perMinute - recent);
}

/** Seconds until the oldest send of the last minute leaves the window (`0`: none). */
export function testSendWaitSeconds(sentAt: readonly number[], now: number): number {
  const recent = sentAt.filter((time) => now - time < 60_000);
  if (recent.length === 0) return 0;
  return Math.max(0, Math.ceil((Math.min(...recent) + 60_000 - now) / 1000));
}

/** Prefix of the test subject, in the organization's language (CONTRACTS §21). */
export function testPrefix(orgLocale: string | null | undefined): string {
  const language = (orgLocale ?? '').toLowerCase().split(/[-_]/u)[0];
  return language === 'vi' ? '[Thử]' : '[Test]';
}
