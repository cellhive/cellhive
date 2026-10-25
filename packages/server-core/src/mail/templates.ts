import { escapeHtml } from './html.js';
import { EMAIL_ELEMENT_STYLES, renderEmailLayout } from './layout.js';

import type { MailMessage } from './mailer.js';

/** Languages email templates exist in (SPEC §18: `en` source, `vi` complete). */
export const MAIL_LOCALES = ['en', 'vi'] as const;
export type MailLocale = (typeof MAIL_LOCALES)[number];

/** `vi`, `vi-VN` → `vi`; anything else → `en`. */
export function mailLocaleOf(locale: string | null | undefined): MailLocale {
  const language = (locale ?? '').toLowerCase().split(/[-_]/)[0];
  return language === 'vi' ? 'vi' : 'en';
}

export { escapeHtml };

export interface PasswordResetEmailInput {
  readonly locale: string | null | undefined;
  readonly displayName: string;
  /** One-time link; secret: never log it. */
  readonly resetUrl: string;
  readonly expiresAt: Date;
}

interface PasswordResetTexts {
  readonly subject: string;
  readonly greeting: (name: string) => string;
  readonly intro: string;
  readonly action: string;
  readonly expiry: (at: string) => string;
  readonly ignore: string;
}

const PASSWORD_RESET_TEXTS: Readonly<Record<MailLocale, PasswordResetTexts>> = {
  en: {
    subject: 'Reset your Cellhive password',
    greeting: (name) => `Hello ${name},`,
    intro: 'We received a request to reset the password of your Cellhive account.',
    action: 'Set a new password',
    expiry: (at) => `This link can be used once and expires at ${at}.`,
    ignore: 'If you did not ask for this, ignore this email: your password stays the same.',
  },
  vi: {
    subject: 'Đặt lại mật khẩu Cellhive',
    greeting: (name) => `Xin chào ${name},`,
    intro: 'Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản Cellhive của bạn.',
    action: 'Đặt mật khẩu mới',
    expiry: (at) => `Liên kết chỉ dùng được một lần và hết hạn lúc ${at}.`,
    ignore: 'Nếu bạn không yêu cầu, hãy bỏ qua email này: mật khẩu của bạn không thay đổi.',
  },
};

/** `2026-09-24 03:15 UTC`: unambiguous whatever the reader's time zone. */
function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The "reset your password" email (forgot-password flow, SPEC §14.2). */
export function passwordResetEmail(to: string, input: PasswordResetEmailInput): MailMessage {
  const t = PASSWORD_RESET_TEXTS[mailLocaleOf(input.locale)];
  const expiry = t.expiry(formatUtc(input.expiresAt));
  const text = [
    t.greeting(input.displayName),
    '',
    t.intro,
    '',
    `${t.action}: ${input.resetUrl}`,
    '',
    expiry,
    t.ignore,
    '',
  ].join('\n');
  const url = escapeHtml(input.resetUrl);
  const html = [
    '<!doctype html>',
    '<html><body style="font-family:sans-serif;line-height:1.5">',
    `<p>${escapeHtml(t.greeting(input.displayName))}</p>`,
    `<p>${escapeHtml(t.intro)}</p>`,
    `<p><a href="${url}">${escapeHtml(t.action)}</a></p>`,
    `<p>${escapeHtml(expiry)}<br>${escapeHtml(t.ignore)}</p>`,
    '</body></html>',
  ].join('\n');
  return { to, subject: t.subject, text, html };
}

export interface InvitationEmailInput {
  readonly locale: string | null | undefined;
  readonly inviterName: string;
  readonly organizationName: string;
  /** One-time link; secret: never log it. */
  readonly inviteUrl: string;
  readonly expiresAt: Date;
}

interface InvitationTexts {
  readonly subject: (org: string) => string;
  readonly intro: (inviter: string, org: string) => string;
  readonly action: string;
  readonly expiry: (at: string) => string;
  readonly ignore: string;
}

const INVITATION_TEXTS: Readonly<Record<MailLocale, InvitationTexts>> = {
  en: {
    subject: (org) => `You are invited to ${org} on Cellhive`,
    intro: (inviter, org) => `${inviter} invited you to join ${org} on Cellhive.`,
    action: 'Accept the invitation',
    expiry: (at) => `This link can be used once and expires at ${at}.`,
    ignore: 'If you do not know this organization, ignore this email.',
  },
  vi: {
    subject: (org) => `Bạn được mời tham gia ${org} trên Cellhive`,
    intro: (inviter, org) => `${inviter} đã mời bạn tham gia ${org} trên Cellhive.`,
    action: 'Chấp nhận lời mời',
    expiry: (at) => `Liên kết chỉ dùng được một lần và hết hạn lúc ${at}.`,
    ignore: 'Nếu bạn không biết tổ chức này, hãy bỏ qua email này.',
  },
};

/** The "you are invited" email (SPEC §14.1A: invitations are emailed when SMTP is configured). */
export function invitationEmail(to: string, input: InvitationEmailInput): MailMessage {
  const t = INVITATION_TEXTS[mailLocaleOf(input.locale)];
  const intro = t.intro(input.inviterName, input.organizationName);
  const expiry = t.expiry(formatUtc(input.expiresAt));
  const text = [intro, '', `${t.action}: ${input.inviteUrl}`, '', expiry, t.ignore, ''].join('\n');
  const url = escapeHtml(input.inviteUrl);
  const html = [
    '<!doctype html>',
    '<html><body style="font-family:sans-serif;line-height:1.5">',
    `<p>${escapeHtml(intro)}</p>`,
    `<p><a href="${url}">${escapeHtml(t.action)}</a></p>`,
    `<p>${escapeHtml(expiry)}<br>${escapeHtml(t.ignore)}</p>`,
    '</body></html>',
  ].join('\n');
  return { to, subject: t.subject(input.organizationName), text, html };
}

export interface ConnectionTestEmailInput {
  readonly locale: string | null | undefined;
  readonly organizationName: string;
  readonly sentAt: Date;
}

interface ConnectionTestTexts {
  readonly subject: string;
  readonly intro: string;
  readonly organization: (org: string) => string;
  readonly sentAt: (at: string) => string;
  readonly ignore: string;
}

const CONNECTION_TEST_TEXTS: Readonly<Record<MailLocale, ConnectionTestTexts>> = {
  en: {
    subject: 'Cellhive: SMTP connection test',
    intro:
      'This test email confirms that Cellhive can send email through the SMTP server of this instance.',
    organization: (org) => `Requested from the email settings of ${org}.`,
    sentAt: (at) => `Sent at ${at}.`,
    ignore: 'No action is needed.',
  },
  vi: {
    subject: 'Cellhive: kiểm tra kết nối SMTP',
    intro: 'Email thử này xác nhận Cellhive gửi được email qua máy chủ SMTP của hệ thống.',
    organization: (org) => `Yêu cầu từ trang cài đặt email của ${org}.`,
    sentAt: (at) => `Gửi lúc ${at}.`,
    ignore: 'Bạn không cần làm gì thêm.',
  },
};

/**
 * The "Test connection" email (`POST /orgs/:id/email-settings/test`,
 * CONTRACTS §23): fixed text in the layout shared by Cellhive emails.
 */
export function connectionTestEmail(to: string, input: ConnectionTestEmailInput): MailMessage {
  const locale = mailLocaleOf(input.locale);
  const t = CONNECTION_TEST_TEXTS[locale];
  const lines = [
    t.intro,
    t.organization(input.organizationName),
    t.sentAt(formatUtc(input.sentAt)),
  ];
  const rendered = renderEmailLayout({
    lang: locale,
    title: t.subject,
    preheader: t.intro,
    body: {
      html: lines
        .map((line) => `<p style="${EMAIL_ELEMENT_STYLES.p}">${escapeHtml(line)}</p>`)
        .join('\n'),
      text: lines.join('\n\n'),
    },
    footer: { html: escapeHtml(t.ignore), text: t.ignore },
  });
  return { to, subject: t.subject, text: rendered.text, html: rendered.html };
}
