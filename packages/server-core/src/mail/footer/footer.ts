import { safeHref, type Block, type Inline } from '@cellhive/markdown';

import { sanitizeHeaderText } from '../address.js';
import { mailLocaleOf, type MailLocale } from '../templates.js';

import type {
  EmailFooterLevel,
  EmailFooterPolicy,
  EmailIdentityMode,
  EmailInstanceFooterPolicy,
} from '@cellhive/contracts';

/**
 * Footer of automation emails (ADR-33 §4, BACKLOG T531).
 *
 * Policy, from the outside in: env `EMAIL_AUTOMATION_FOOTER` (`required`
 * forbids `none` everywhere | `org`) → the organization's `footer_policy`
 * (`required` | `author_choice`, effective only when the env is `org`) →
 * the automation's choice (`minimal` default | `full` | `none`). `none` is
 * only possible when the policies allow it **and** the message goes out as
 * a verified identity in `send_as` mode (the organization's own domain):
 * the system sender and `on_behalf` messages always carry a footer.
 *
 * The same `resolveFooter` decides when an automation is saved (refusal →
 * `422 AUTOMATION_INVALID` / `EMAIL_FOOTER_NOT_ALLOWED`) and when it runs
 * (a policy tightened after the save downgrades to `minimal`, the run does
 * not fail).
 */

/** Who the message is from, as far as the footer is concerned. */
export type FooterSender =
  /** `SMTP_FROM` (`identity_id: null`). */
  | { readonly kind: 'system' }
  /** A verified identity in its current mode (`resolveSender`). */
  | { readonly kind: 'identity'; readonly mode: EmailIdentityMode };

export interface FooterPolicyInput {
  /** `config.email.automationFooter`. */
  readonly instancePolicy: EmailInstanceFooterPolicy;
  /** `orgEmailSettingsOf(settings).footerPolicy`. */
  readonly orgPolicy: EmailFooterPolicy;
}

export interface ResolveFooterInput extends FooterPolicyInput {
  /** The automation's choice; absent = `minimal`. */
  readonly requested: EmailFooterLevel | undefined;
  readonly sender: FooterSender;
  /** `save`: refuse a forbidden `none`; `run`: fall back to `minimal`. */
  readonly phase: 'save' | 'run';
}

/** Why `none` is refused: the policies, or the sender (system / `on_behalf`). */
export type FooterRefusal = 'policy' | 'sender';

export type ResolveFooterResult =
  | {
      readonly ok: true;
      readonly footer: EmailFooterLevel;
      /** `none` was asked for but not allowed (run phase): `minimal` instead. */
      readonly downgraded: FooterRefusal | null;
    }
  | {
      readonly ok: false;
      readonly code: 'EMAIL_FOOTER_NOT_ALLOWED';
      readonly reason: FooterRefusal;
    };

/** Whether the instance and organization policies let automations choose `none`. */
export function footerNoneAllowedByPolicy(input: FooterPolicyInput): boolean {
  return input.instancePolicy === 'org' && input.orgPolicy === 'author_choice';
}

/** Whether `sender` may send without a footer (verified identity, `send_as`). */
export function senderMayOmitFooter(sender: FooterSender): boolean {
  return sender.kind === 'identity' && sender.mode === 'send_as';
}

/** The footer level a message gets (see the module comment). */
export function resolveFooter(input: ResolveFooterInput): ResolveFooterResult {
  const requested = input.requested ?? 'minimal';
  if (requested !== 'none') return { ok: true, footer: requested, downgraded: null };
  const refusal: FooterRefusal | null = !footerNoneAllowedByPolicy(input)
    ? 'policy'
    : !senderMayOmitFooter(input.sender)
      ? 'sender'
      : null;
  if (refusal === null) return { ok: true, footer: 'none', downgraded: null };
  if (input.phase === 'save')
    return { ok: false, code: 'EMAIL_FOOTER_NOT_ALLOWED', reason: refusal };
  return { ok: true, footer: 'minimal', downgraded: refusal };
}

// --- Rendering -------------------------------------------------------------

/** What `full` shows besides the organization; never read for `minimal`. */
export interface FooterAutomation {
  readonly id: string;
  readonly name: string;
  readonly baseId: string;
  readonly baseName: string;
}

export interface FooterContent {
  readonly level: Exclude<EmailFooterLevel, 'none'>;
  /** The organization's locale. */
  readonly locale: string | null | undefined;
  readonly organizationName: string;
  /** `PUBLIC_URL` (link of `full`). */
  readonly publicUrl: string;
  readonly automation: FooterAutomation;
}

interface FooterTexts {
  readonly minimal: (organization: string) => string;
  readonly full: (automation: string, base: string) => string;
  readonly open: string;
}

const TEXTS: Readonly<Record<MailLocale, FooterTexts>> = {
  en: {
    minimal: (organization) => `This email was sent automatically by Cellhive of ${organization}.`,
    full: (automation, base) => `Automation “${automation}” in base “${base}”.`,
    open: 'Open the automation (sign-in required)',
  },
  vi: {
    minimal: (organization) => `Email được gửi tự động bởi Cellhive của ${organization}.`,
    full: (automation, base) => `Automation “${automation}” trong base “${base}”.`,
    open: 'Mở automation (cần đăng nhập)',
  },
};

/** Names on one line, without control characters (they are text nodes: never parsed). */
function oneLine(value: string): string {
  return sanitizeHeaderText(value).trim();
}

/** `PUBLIC_URL/b/<base>/automations/<automation>`: the app route, no token (needs a session). */
export function automationUrlOf(publicUrl: string, automation: FooterAutomation): string {
  const root = publicUrl.replace(/\/+$/, '');
  return `${root}/b/${encodeURIComponent(automation.baseId)}/automations/${encodeURIComponent(automation.id)}`;
}

/**
 * The footer as a `packages/markdown` tree (built, never parsed: names are
 * text nodes). `minimal` names only the organization; `full` adds the
 * automation and base names and a link to the automation.
 */
export function footerBlocks(content: FooterContent): Block[] {
  const t = TEXTS[mailLocaleOf(content.locale)];
  const blocks: Block[] = [
    {
      type: 'paragraph',
      children: [{ type: 'text', text: t.minimal(oneLine(content.organizationName)) }],
    },
  ];
  if (content.level === 'full') {
    const children: Inline[] = [
      {
        type: 'text',
        text: t.full(oneLine(content.automation.name), oneLine(content.automation.baseName)),
      },
    ];
    const href = safeHref(automationUrlOf(content.publicUrl, content.automation));
    if (href !== null) {
      children.push({ type: 'break' });
      children.push({ type: 'link', href, children: [{ type: 'text', text: t.open }] });
    }
    blocks.push({ type: 'paragraph', children });
  }
  return blocks;
}
