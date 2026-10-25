import {
  collectImages,
  IMAGE_SOURCES,
  parseTemplate,
  substitute,
  toHtml,
  toText,
  utf8ByteLength,
  type Block,
  type ImageNode,
  type ImageResolver,
  type PlaceholderValues,
} from '@cellhive/markdown';

import { sanitizeHeaderText } from '../address.js';
import {
  footerBlocks,
  resolveFooter,
  type FooterAutomation,
  type FooterRefusal,
} from '../footer/footer.js';
import { renderEmailLayout, type EmailBody } from '../layout.js';
import { sanitizeEmailHtml } from '../render/sanitize.js';
import { signatureBlocks } from '../signature/signature.js';
import { mailLocaleOf } from '../templates.js';

import type { ResolvedSender } from '../identities/sender.js';
import type { OrgEmailSettings } from '../settings/org-email-settings.js';
import type { EmailFooterLevel, EmailInstanceFooterPolicy } from '@cellhive/contracts';

/**
 * The one composition of an automation email (BACKLOG T531 for T514;
 * ADR-32 §3, ADR-33 §3–§4): body → signature → rule → footer, in the HTML
 * and the plain-text parts alike.
 *
 * 1. Body: the Markdown template is parsed by `packages/markdown` **before**
 *    any value is known; each `{{ }}` becomes a text node (`substitute`), so
 *    record values never reach the parser.
 * 2. Signature (`include_signature`, default `true`): the identity's
 *    `signature_md`, or the organization default for the system sender;
 *    plain document whose only images are signature assets (T534).
 * 3. Body and signature go to HTML through the renderer allowlist, then the
 *    `sanitize-html` second layer; the text part comes from the same tree.
 * 4. Footer level by `resolveFooter` (run phase: a forbidden `none`
 *    becomes `minimal`), wrapped below the rule of the fixed layout (T513).
 * 5. Images (T534): `image` nodes of the body template source
 *    (`asset:`/`field:`) and of the signature (`asset:`) become
 *    `<img src="cid:…">` for the files `images` gives them (none: left
 *    out), `[alt]` in the text part. A value never creates one.
 */

/** The image nodes of an automation email, by part (to resolve before composing). */
export interface AutomationEmailImages {
  readonly body: readonly ImageNode[];
  readonly signature: readonly ImageNode[];
}

/** The signature an email of `sender` gets: the identity's, or the organization default. */
export function signatureSourceOf(
  sender: Pick<ResolvedSender, 'identityId' | 'signatureMd'>,
  orgSettings: Pick<OrgEmailSettings, 'defaultSignatureMd'>,
  includeSignature: boolean | undefined,
): string | null {
  if (includeSignature === false) return null;
  return sender.identityId === null ? orgSettings.defaultSignatureMd : sender.signatureMd;
}

/** The images of the body template and the signature, in source order. */
export function automationEmailImages(
  template: string,
  signatureSource: string | null,
): AutomationEmailImages {
  return {
    body: collectImages(parseTemplate(template, { images: IMAGE_SOURCES }).blocks),
    signature: collectImages(signatureBlocks(signatureSource)),
  };
}

export interface ComposeAutomationEmailInput {
  /** Rendered subject (one line; control characters removed again here, ≤ 255). */
  readonly subject: string;
  /** Markdown template of the body and the text of each placeholder (in source order). */
  readonly body: { readonly template: string; readonly values: PlaceholderValues };
  /** From `resolveSender` (system sender or verified identity, current mode). */
  readonly sender: Pick<ResolvedSender, 'identityId' | 'mode' | 'signatureMd'>;
  /** `orgEmailSettingsOf(organization.settings)`. */
  readonly orgSettings: OrgEmailSettings;
  /** `config.email.automationFooter` (`EMAIL_AUTOMATION_FOOTER`). */
  readonly instanceFooterPolicy: EmailInstanceFooterPolicy;
  /** The action's `footer`; absent = `minimal`. */
  readonly footer?: EmailFooterLevel;
  /** The action's `include_signature`; absent = `true`. */
  readonly includeSignature?: boolean;
  /** The organization's locale (footer language, `lang` of the document). */
  readonly locale: string | null | undefined;
  readonly organizationName: string;
  /** `PUBLIC_URL` (link of the `full` footer). */
  readonly publicUrl: string;
  /** Names and ids shown by the `full` footer only. */
  readonly automation: FooterAutomation;
  /** `EMAIL_MAX_HTML_BYTES`. */
  readonly maxHtmlBytes: number;
  /**
   * The inline images of the body and the signature (T534, e.g.
   * `InlineImageSet.resolver`); absent, images are left out of the HTML.
   */
  readonly images?: { readonly body: ImageResolver; readonly signature: ImageResolver };
}

export interface ComposedAutomationEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Footer level applied. */
  readonly footer: EmailFooterLevel;
  /** `footer: none` was asked for but is not allowed any more: `minimal` was applied. */
  readonly footerDowngraded: FooterRefusal | null;
  /** A (non-empty) signature was added. */
  readonly signature: boolean;
  /** UTF-8 size of the HTML part. */
  readonly htmlBytes: number;
}

export type ComposeAutomationEmailResult =
  | { readonly ok: true; readonly email: ComposedAutomationEmail }
  /** The HTML part is above `EMAIL_MAX_HTML_BYTES`: the step fails, nothing is cut. */
  | { readonly ok: false; readonly code: 'email_body_too_large'; readonly htmlBytes: number };

const NO_IMAGES: ImageResolver = () => [];

function rendered(blocks: readonly Block[], images: ImageResolver = NO_IMAGES): EmailBody {
  return {
    html: sanitizeEmailHtml(toHtml(blocks, { images })),
    text: toText(blocks, { images }),
  };
}

/** Body, signature and footer of an automation email, in the fixed layout (see the module comment). */
export function composeAutomationEmail(
  input: ComposeAutomationEmailInput,
): ComposeAutomationEmailResult {
  const parsed = parseTemplate(input.body.template, { images: IMAGE_SOURCES });
  const body = substitute(parsed.blocks, input.body.values);

  const signature = signatureBlocks(
    signatureSourceOf(input.sender, input.orgSettings, input.includeSignature),
  );

  const resolved = resolveFooter({
    requested: input.footer,
    instancePolicy: input.instanceFooterPolicy,
    orgPolicy: input.orgSettings.footerPolicy,
    sender:
      input.sender.identityId === null
        ? { kind: 'system' }
        : { kind: 'identity', mode: input.sender.mode },
    phase: 'run',
  });
  // The run phase never refuses; the narrowing keeps the types honest.
  const footerLevel = resolved.ok ? resolved.footer : 'minimal';
  const downgraded = resolved.ok ? resolved.downgraded : resolved.reason;

  const bodyPart = rendered(body, input.images?.body);
  const signaturePart =
    signature.length === 0 ? null : rendered(signature, input.images?.signature);
  const content: EmailBody =
    signaturePart === null
      ? bodyPart
      : {
          html: `${bodyPart.html}${signaturePart.html}`,
          text: `${bodyPart.text.trimEnd()}\n\n${signaturePart.text}`,
        };
  const footer =
    footerLevel === 'none'
      ? null
      : rendered(
          footerBlocks({
            level: footerLevel,
            locale: input.locale,
            organizationName: input.organizationName,
            publicUrl: input.publicUrl,
            automation: input.automation,
          }),
        );

  const subject = sanitizeHeaderText(input.subject);
  const email = renderEmailLayout({
    lang: mailLocaleOf(input.locale),
    title: subject,
    body: content,
    footer,
  });
  const htmlBytes = utf8ByteLength(email.html);
  if (htmlBytes > input.maxHtmlBytes) {
    return { ok: false, code: 'email_body_too_large', htmlBytes };
  }
  return {
    ok: true,
    email: {
      subject,
      html: email.html,
      text: email.text,
      footer: footerLevel,
      footerDowngraded: downgraded,
      signature: signaturePart !== null,
      htmlBytes,
    },
  };
}
