import { Buffer } from 'node:buffer';

import { EMAIL_VERIFICATION_TOKEN_PATTERN } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { deriveSecretKey, sealSecret, unsealSecret } from '../../../src/auth/index.js';
import {
  identityHintsOf,
  identityModeOf,
  identityTransportOf,
  issueVerification,
  parseVerificationToken,
  senderDisplayOf,
  senderHeadersOf,
  senderVerificationEmail,
  verificationSenderOf,
  verificationCodeHash,
  verificationCodeMatches,
  verifySenderUrlOf,
} from '../../../src/mail/identities/index.js';

import type { MailConfig } from '../../../src/config/index.js';
import type { EmailIdentityRow } from '../../../src/db/schema.js';

const MAIL: MailConfig = {
  url: 'smtp://relay.cellhive.test:587',
  from: 'Cellhive <noreply@cellhive.test>',
  fromAddress: 'noreply@cellhive.test',
  fromName: 'Cellhive',
  allowedFromDomains: ['cellhive.test', 'corp.vn'],
  allowInsecure: false,
};

const MASTER = Buffer.alloc(32, 7);
const SMTP_KEY = deriveSecretKey(MASTER, 'email-identity-smtp');
const CODE_KEY = deriveSecretKey(MASTER, 'email-identity-code');

function identity(overrides: Partial<EmailIdentityRow> = {}): EmailIdentityRow {
  return {
    id: 'eid_HrIdentity000001',
    organization_id: 'org_SenderTestOrg001',
    email: 'hr@corp.vn',
    display_name: 'Phòng Nhân sự',
    reply_to: null,
    transport: 'system',
    mode: 'send_as',
    status: 'verified',
    status_before_disable: null,
    error_reason: null,
    verified_at: new Date(),
    verified_via: 'code',
    base_scope: 'all',
    signature_md: null,
    smtp_host: null,
    smtp_port: null,
    smtp_security: null,
    smtp_username: null,
    smtp_password_enc: null,
    smtp_version: 1,
    auth_failures: 0,
    created_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('identity mode (ADR-33 §1)', () => {
  it.each([
    ['system', 'hr@corp.vn', MAIL, 'send_as'],
    ['system', 'HR@Corp.VN', MAIL, 'send_as'],
    ['system', 'noreply@cellhive.test', MAIL, 'send_as'],
    ['system', 'hr-corp@gmail.com', MAIL, 'on_behalf'],
    ['system', 'hr@sub.corp.vn', MAIL, 'on_behalf'],
    ['system', 'hr@corp.vn', null, 'on_behalf'],
    ['smtp', 'hr-corp@gmail.com', MAIL, 'send_as'],
    ['smtp', 'hr@corp.vn', null, 'send_as'],
  ] as const)('%s %s → %s', (transport, email, mail, expected) => {
    expect(identityModeOf(transport, email, mail)).toBe(expected);
  });

  it('send_as: From is the identity, Reply-To only when set', () => {
    expect(senderHeadersOf(identity(), MAIL, 'vi')).toEqual({
      mode: 'send_as',
      from: { address: 'hr@corp.vn', name: 'Phòng Nhân sự' },
      replyTo: [],
    });
    expect(senderHeadersOf(identity({ reply_to: 'jobs@corp.vn' }), MAIL, 'vi').replyTo).toEqual([
      { address: 'jobs@corp.vn' },
    ]);
  });

  it('on_behalf: From is SMTP_FROM "(via Cellhive)", Reply-To the identity', () => {
    const gmail = identity({ email: 'hr-corp@gmail.com', display_name: 'HR' });
    expect(senderHeadersOf(gmail, MAIL, 'en')).toEqual({
      mode: 'on_behalf',
      from: { address: 'noreply@cellhive.test', name: 'HR (via Cellhive)' },
      replyTo: [{ address: 'hr-corp@gmail.com' }],
    });
    expect(senderDisplayOf(gmail, MAIL, 'vi')).toEqual({
      from: '"HR (qua Cellhive)" <noreply@cellhive.test>',
      reply_to: '<hr-corp@gmail.com>',
    });
    expect(identityHintsOf(gmail, MAIL)).toEqual(['sent_on_behalf']);
  });

  it('verification email: never the unverified display name in a header (T528, M7)', () => {
    const spoof = 'Bank <a@evil.com> https://x';
    // system: the instance sender as configured (SMTP_FROM), whatever the mode.
    for (const email of ['hr@corp.vn', 'hr-corp@gmail.com']) {
      expect(verificationSenderOf(identity({ email, display_name: spoof }))).toEqual({
        from: undefined,
        replyTo: [],
      });
    }
    // smtp: the identity's own address, without a name.
    const own = identity({ transport: 'smtp', display_name: spoof, reply_to: 'x@evil.com' });
    expect(verificationSenderOf(own)).toEqual({ from: { address: 'hr@corp.vn' }, replyTo: [] });
    expect(JSON.stringify(verificationSenderOf(own))).not.toContain('evil');
  });

  it('hints for an SMTP identity', () => {
    const own = identity({ transport: 'smtp', smtp_security: 'none' });
    expect(identityHintsOf(own, MAIL)).toEqual([
      'spf_dkim_alignment',
      'basic_auth_restricted',
      'insecure_connection',
    ]);
  });

  it('builds the identity transport, unsealing the password only on demand', async () => {
    const sealed = sealSecret(SMTP_KEY, 'app-password-1');
    const row = identity({
      transport: 'smtp',
      smtp_host: 'mail.corp.vn',
      smtp_port: 587,
      smtp_security: 'starttls',
      smtp_username: 'hr@corp.vn',
      smtp_password_enc: sealed,
      smtp_version: 4,
    });
    const ref = identityTransportOf(row, SMTP_KEY);
    expect(ref).toMatchObject({
      kind: 'identity',
      identityId: row.id,
      version: 4,
      endpoint: { host: 'mail.corp.vn', port: 587, security: 'starttls', username: 'hr@corp.vn' },
      fromAddress: 'hr@corp.vn',
    });
    expect(JSON.stringify(ref)).not.toContain('app-password-1');
    if (ref.kind !== 'identity') throw new Error('expected an identity transport');
    await expect(ref.credentials()).resolves.toEqual({
      user: 'hr@corp.vn',
      pass: 'app-password-1',
    });
    expect(identityTransportOf(identity(), SMTP_KEY)).toEqual({ kind: 'instance' });
  });
});

describe('sealed SMTP passwords', () => {
  it('differ on every seal and need the right key', () => {
    const first = sealSecret(SMTP_KEY, 'secret');
    const second = sealSecret(SMTP_KEY, 'secret');
    expect(first).not.toBe(second);
    expect(first).not.toContain('secret');
    expect(unsealSecret(SMTP_KEY, first)).toBe('secret');
    expect(() => unsealSecret(CODE_KEY, first)).toThrow();
    expect(() =>
      unsealSecret(SMTP_KEY, `${first.slice(0, -2)}${first.endsWith('AA') ? 'BB' : 'AA'}`),
    ).toThrow();
    expect(deriveSecretKey(MASTER, 'idempotency-response').equals(SMTP_KEY)).toBe(false);
  });
});

describe('verification token and code (ADR-33 §2)', () => {
  it('issues <org_id>.<secret> and a 6-digit code, stored hashed', () => {
    const issued = issueVerification(CODE_KEY, 'org_SenderTestOrg001', 'eid_HrIdentity000001');
    expect(issued.token).toMatch(EMAIL_VERIFICATION_TOKEN_PATTERN);
    expect(issued.token.startsWith('org_SenderTestOrg001.')).toBe(true);
    expect(issued.code).toMatch(/^\d{6}$/);
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.tokenHash).not.toContain(issued.token.split('.')[1]);
    expect(issued.codeHash).toBe(
      verificationCodeHash(CODE_KEY, 'eid_HrIdentity000001', issued.code),
    );
    expect(
      verificationCodeMatches(CODE_KEY, 'eid_HrIdentity000001', issued.code, issued.codeHash),
    ).toBe(true);
    // The code is bound to the identity.
    expect(
      verificationCodeMatches(CODE_KEY, 'eid_OtherIdentity001', issued.code, issued.codeHash),
    ).toBe(false);
    expect(parseVerificationToken(issued.token)).toEqual({
      organizationId: 'org_SenderTestOrg001',
      tokenHash: issued.tokenHash,
    });
  });

  it.each([
    '',
    'abc',
    'org_SenderTestOrg001',
    'org_SenderTestOrg001.short',
    'usr_SenderTestOrg001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'org_SenderTestOrg001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.x',
    'org_SenderTestOrg001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+',
  ])('rejects the token %j', (token) => {
    expect(parseVerificationToken(token)).toBeNull();
  });

  it('builds the verification email: fixed text, link, code, only the display name', () => {
    const issued = issueVerification(CODE_KEY, 'org_SenderTestOrg001', 'eid_HrIdentity000001');
    const url = verifySenderUrlOf('https://cellhive.test', issued.token);
    expect(url).toBe(
      `https://cellhive.test/verify-sender?token=${encodeURIComponent(issued.token)}`,
    );
    for (const locale of ['en', 'vi']) {
      const message = senderVerificationEmail({
        locale,
        displayName: '<b>HR</b>',
        address: 'hr@corp.vn',
        verifyUrl: url,
        code: issued.code,
        expiresAt: new Date('2026-10-06T03:00:00.000Z'),
      });
      expect(message.to).toBe('hr@corp.vn');
      expect(message.subject).not.toContain(issued.code);
      expect(message.text).toContain(issued.code);
      expect(message.text).toContain(url);
      expect(message.html).toContain(issued.code);
      expect(message.html).toContain('&lt;b&gt;HR&lt;/b&gt;');
      expect(message.html).not.toContain('<b>HR</b>');
      expect(message.html).toContain('max-width:600px');
      expect(message.text).toContain('2026-10-06 03:00 UTC');
    }
  });
});
