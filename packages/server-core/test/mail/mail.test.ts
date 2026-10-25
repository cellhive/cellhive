import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';

import {
  createMailer,
  escapeHtml,
  invitationEmail,
  mailLocaleOf,
  passwordResetEmail,
} from '../../src/mail/index.js';

const EMAIL_LIMITS = {
  maxPerHourPerOrg: 500,
  maxRecipients: 50,
  maxPerSecond: 5,
  testSendsPerMinute: 5,
  maxHtmlBytes: 102_400,
  allowPrivateSmtpHosts: true,
  maxPerHourPerIdentity: 100,
  automationFooter: 'required' as const,
  maxAttachments: 10,
  maxAttachmentBytes: 15 * 1024 * 1024,
  maxInlineImages: 5,
};

const INPUT = {
  displayName: 'An <script>',
  resetUrl: 'https://cellhive.test/reset/AbC_123-xyz?x=1&y=2',
  expiresAt: new Date('2026-09-24T03:15:00.000Z'),
};

describe('mailLocaleOf', () => {
  it.each([
    ['vi', 'vi'],
    ['vi-VN', 'vi'],
    ['VI_vn', 'vi'],
    ['en', 'en'],
    ['fr', 'en'],
    [null, 'en'],
    [undefined, 'en'],
  ])('%j → %s', (locale, expected) => {
    expect(mailLocaleOf(locale)).toBe(expected);
  });
});

describe('password reset email', () => {
  it('has English text and HTML parts with the link', () => {
    const mail = passwordResetEmail('an@example.test', { ...INPUT, locale: 'en' });
    expect(mail.to).toBe('an@example.test');
    expect(mail.subject).toBe('Reset your Cellhive password');
    expect(mail.text).toContain(INPUT.resetUrl);
    expect(mail.text).toContain('2026-09-24 03:15 UTC');
    expect(mail.html).toContain(`href="${escapeHtml(INPUT.resetUrl)}"`);
    // Values are escaped in HTML.
    expect(mail.html).toContain('An &lt;script&gt;');
    expect(mail.html).not.toContain('<script>');
  });

  it('has a Vietnamese version', () => {
    const mail = passwordResetEmail('an@example.test', { ...INPUT, locale: 'vi-VN' });
    expect(mail.subject).toBe('Đặt lại mật khẩu Cellhive');
    expect(mail.text).toContain('Xin chào An <script>,');
    expect(mail.text).toContain('hết hạn lúc 2026-09-24 03:15 UTC');
    expect(mail.html).toContain('Đặt mật khẩu mới');
  });
});

describe('invitation email', () => {
  const invite = {
    inviterName: 'Bình <b>',
    organizationName: 'Công ty Đông Á',
    inviteUrl: 'https://cellhive.test/invite/AbC_123-xyz?x=1&y=2',
    expiresAt: new Date('2026-09-30T03:15:00.000Z'),
  };

  it('has English text and HTML parts with the link', () => {
    const mail = invitationEmail('an@example.test', { ...invite, locale: 'en' });
    expect(mail.to).toBe('an@example.test');
    expect(mail.subject).toBe('You are invited to Công ty Đông Á on Cellhive');
    expect(mail.text).toContain(invite.inviteUrl);
    expect(mail.text).toContain('2026-09-30 03:15 UTC');
    expect(mail.html).toContain(`href="${escapeHtml(invite.inviteUrl)}"`);
    expect(mail.html).toContain('Bình &lt;b&gt;');
    expect(mail.html).not.toContain('<b>');
  });

  it('has a Vietnamese version', () => {
    const mail = invitationEmail('an@example.test', { ...invite, locale: 'vi' });
    expect(mail.subject).toBe('Bạn được mời tham gia Công ty Đông Á trên Cellhive');
    expect(mail.text).toContain('hết hạn lúc 2026-09-30 03:15 UTC');
    expect(mail.html).toContain('Chấp nhận lời mời');
  });
});

describe('createMailer', () => {
  it('is disabled (null) without SMTP_URL', () => {
    expect(createMailer({ mail: null, email: EMAIL_LIMITS })).toBeNull();
  });

  it('sends through the transport with the configured sender', async () => {
    const transport = createTransport({ jsonTransport: true });
    const sent: string[] = [];
    const original = transport.sendMail.bind(transport);
    transport.sendMail = async (message: Parameters<typeof original>[0]) => {
      const info = await original(message);
      sent.push(typeof info.message === 'string' ? info.message : JSON.stringify(info.message));
      return info;
    };
    const mailer = createMailer(
      {
        mail: {
          url: 'smtp://localhost:2525',
          from: 'Cellhive <no-reply@cellhive.test>',
          fromAddress: 'no-reply@cellhive.test',
          fromName: 'Cellhive',
          allowedFromDomains: ['cellhive.test'],
          allowInsecure: true,
        },
        email: EMAIL_LIMITS,
      },
      { transport },
    );
    expect(mailer).not.toBeNull();
    await mailer?.send(passwordResetEmail('an@example.test', { ...INPUT, locale: 'en' }));
    mailer?.close();
    expect(sent).toHaveLength(1);
    const message = JSON.parse(sent[0] ?? '{}') as Record<string, unknown>;
    expect(message).toMatchObject({
      from: { address: 'no-reply@cellhive.test', name: 'Cellhive' },
      to: [{ address: 'an@example.test' }],
      subject: 'Reset your Cellhive password',
    });
  });
});
