import { escapeHtml } from '../html.js';
import { EMAIL_ELEMENT_STYLES, renderEmailLayout } from '../layout.js';
import { mailLocaleOf, type MailLocale } from '../templates.js';

import type { MailMessage } from '../mailer.js';

export interface SenderVerificationEmailInput {
  readonly locale: string | null | undefined;
  /** The identity's display name: the only user-written text of the email (ADR-33 §2). */
  readonly displayName: string;
  /** The identity's address (also the recipient). */
  readonly address: string;
  /** One-time link; secret: never log it. */
  readonly verifyUrl: string;
  /** Six digits; secret: never log it. */
  readonly code: string;
  readonly expiresAt: Date;
}

interface Texts {
  readonly subject: string;
  readonly intro: (sender: string) => string;
  readonly action: string;
  readonly code: (code: string) => string;
  readonly expiry: (at: string) => string;
  readonly ignore: string;
}

const TEXTS: Readonly<Record<MailLocale, Texts>> = {
  en: {
    subject: 'Confirm this address as a Cellhive sender',
    intro: (sender) =>
      `An organization administrator on Cellhive asked to send automated emails as ${sender}. ` +
      'Confirm only if you manage this mailbox and agree.',
    action: 'Review and confirm',
    code: (code) => `Or give this code to the administrator: ${code}`,
    expiry: (at) => `The link and the code can be used once and expire at ${at}.`,
    ignore: 'If you did not expect this, ignore this email: nothing will be sent as this address.',
  },
  vi: {
    subject: 'Xác nhận địa chỉ này làm người gửi trên Cellhive',
    intro: (sender) =>
      `Quản trị viên một tổ chức trên Cellhive yêu cầu gửi email tự động dưới tên ${sender}. ` +
      'Chỉ xác nhận nếu bạn quản lý hộp thư này và đồng ý.',
    action: 'Xem và xác nhận',
    code: (code) => `Hoặc đưa mã này cho quản trị viên: ${code}`,
    expiry: (at) => `Liên kết và mã chỉ dùng được một lần và hết hạn lúc ${at}.`,
    ignore:
      'Nếu bạn không yêu cầu, hãy bỏ qua email này: sẽ không có thư nào được gửi dưới địa chỉ này.',
  },
};

function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The verification email of a sender identity (ADR-33 §2): fixed text, a
 * link to the public confirmation page and a 6-digit code. No organization
 * or base name, no requester text: only the display name and address.
 */
export function senderVerificationEmail(input: SenderVerificationEmailInput): MailMessage {
  const locale = mailLocaleOf(input.locale);
  const t = TEXTS[locale];
  const sender = `"${input.displayName}" <${input.address}>`;
  const intro = t.intro(sender);
  const codeLine = t.code(input.code);
  const expiry = t.expiry(formatUtc(input.expiresAt));
  const url = escapeHtml(input.verifyUrl);
  const html = [
    `<p style="${EMAIL_ELEMENT_STYLES.p}">${escapeHtml(intro)}</p>`,
    `<p style="${EMAIL_ELEMENT_STYLES.p}"><a href="${url}" style="${EMAIL_ELEMENT_STYLES.a}">${escapeHtml(t.action)}</a></p>`,
    `<p style="${EMAIL_ELEMENT_STYLES.p}">${escapeHtml(codeLine)}</p>`,
    `<p style="${EMAIL_ELEMENT_STYLES.p}">${escapeHtml(expiry)}</p>`,
  ].join('\n');
  const text = [intro, `${t.action}: ${input.verifyUrl}`, codeLine, expiry].join('\n\n');
  const rendered = renderEmailLayout({
    lang: locale,
    title: t.subject,
    preheader: t.subject,
    body: { html, text },
    footer: { html: escapeHtml(t.ignore), text: t.ignore },
  });
  return { to: input.address, subject: t.subject, text: rendered.text, html: rendered.html };
}
