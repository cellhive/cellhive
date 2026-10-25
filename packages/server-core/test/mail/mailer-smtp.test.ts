import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createMailer,
  createMailService,
  deterministicMessageId,
  EmailSendError,
  type SendRateLimiter,
  type EmailQuota,
  type Mailer,
  type MailMessage,
  type MailTransportRef,
  type QuotaDecision,
} from '../../src/mail/index.js';
import { headerOf, startTestSmtp, type TestSmtpServer } from '../support/smtp-test-server.js';

import type { EmailLimits, MailConfig } from '../../src/config/index.js';

const LIMITS: EmailLimits = {
  maxPerHourPerOrg: 500,
  maxRecipients: 3,
  maxPerSecond: 1000,
  testSendsPerMinute: 5,
  maxHtmlBytes: 2_000,
  allowPrivateSmtpHosts: true,
  maxPerHourPerIdentity: 100,
  automationFooter: 'required',
  maxAttachments: 10,
  maxAttachmentBytes: 15 * 1024 * 1024,
  maxInlineImages: 5,
};

function mailConfig(url: string, overrides: Partial<MailConfig> = {}): MailConfig {
  return {
    url,
    from: 'Cellhive <no-reply@cellhive.test>',
    fromAddress: 'no-reply@cellhive.test',
    fromName: 'Cellhive',
    allowedFromDomains: ['cellhive.test', 'corp.test'],
    allowInsecure: true,
    ...overrides,
  };
}

const MESSAGE: MailMessage = {
  to: ['an@example.test'],
  subject: 'Ticket\r\nBcc: evil@example.test',
  text: 'Hello',
  html: '<p>Hello</p>',
  origin: { kind: 'automation', organizationId: 'org_a', automationId: 'aut_123' },
};

async function failure(promise: Promise<unknown>): Promise<EmailSendError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EmailSendError) return error;
    throw error;
  }
  throw new Error('expected an EmailSendError');
}

/** In-memory `EmailQuota` with a fixed limit per key. */
function memoryQuota(limit: number): EmailQuota & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    take(key, now = new Date()): Promise<QuotaDecision> {
      const used = counts.get(key) ?? 0;
      if (used >= limit) {
        const next = new Date(Math.floor(now.getTime() / 3_600_000 + 1) * 3_600_000);
        return Promise.resolve({ allowed: false, used, retryAt: next });
      }
      counts.set(key, used + 1);
      return Promise.resolve({ allowed: true, used: used + 1 });
    },
    release(key) {
      counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
      return Promise.resolve();
    },
    used(key) {
      return Promise.resolve({ used: counts.get(key) ?? 0, resetsAt: new Date() });
    },
  };
}

describe('Mailer over SMTP (T513)', () => {
  let smtp: TestSmtpServer;
  let mailer: Mailer;
  let rcptRule: (address: string) => { code: number; message: string } | null;
  let dataRule: () => { code: number; message: string } | null;

  beforeAll(async () => {
    smtp = await startTestSmtp({
      rcpt: (address) => rcptRule(address),
      data: () => dataRule(),
    });
    mailer = createMailService({ mail: mailConfig(smtp.url), email: LIMITS });
  });

  afterEach(() => {
    rcptRule = () => null;
    dataRule = () => null;
    smtp.messages.length = 0;
  });
  rcptRule = () => null;
  dataRule = () => null;

  afterAll(async () => {
    mailer.close();
    await smtp.close();
  });

  it('sends multipart/alternative with the mandatory headers and no Sender', async () => {
    const result = await mailer.send(MESSAGE);
    expect(result.accepted).toEqual(['a***@example.test']);
    expect(result.smtp.code).toBe(250);
    const raw = smtp.messages[0]?.raw ?? '';
    expect(headerOf(raw, 'Content-Type')).toMatch(/^multipart\/alternative;/);
    expect(raw).toContain('Content-Type: text/plain');
    expect(raw).toContain('Content-Type: text/html');
    expect(headerOf(raw, 'Auto-Submitted')).toBe('auto-generated');
    expect(headerOf(raw, 'X-Auto-Response-Suppress')).toBe('OOF, AutoReply');
    expect(headerOf(raw, 'X-Cellhive-Automation')).toBe('aut_123');
    expect(headerOf(raw, 'Sender')).toBeNull();
    expect(headerOf(raw, 'From')).toBe('Cellhive <no-reply@cellhive.test>');
    // CR/LF in the subject never become a header.
    expect(headerOf(raw, 'Subject')).toBe('Ticket Bcc: evil@example.test');
    expect(headerOf(raw, 'Bcc')).toBeNull();
    expect(smtp.messages[0]?.to).toEqual(['an@example.test']);
  });

  it('keeps a deterministic Message-ID when the same message is sent again', async () => {
    const messageId = deterministicMessageId('run_1:act_1', 'cellhive.test');
    await mailer.send({ ...MESSAGE, messageId });
    await mailer.send({ ...MESSAGE, messageId });
    const ids = smtp.messages.map((mail) => headerOf(mail.raw, 'Message-ID'));
    expect(ids).toEqual([messageId, messageId]);
    expect(messageId).not.toContain('run_1');
  });

  it('system emails have the auto headers but no automation header', async () => {
    await mailer.send({ ...MESSAGE, origin: { kind: 'system' } });
    const raw = smtp.messages[0]?.raw ?? '';
    expect(headerOf(raw, 'Auto-Submitted')).toBe('auto-generated');
    expect(headerOf(raw, 'X-Cellhive-Automation')).toBeNull();
  });

  it.each([
    [554, 'smtp_rejected', false],
    [552, 'smtp_rejected', false],
    [451, 'smtp_temporary', true],
    [421, 'smtp_temporary', true],
  ] as const)('DATA answered %i → %s (retry: %s)', async (code, kind, retryable) => {
    dataRule = () => ({ code, message: 'nope' });
    const error = await failure(mailer.send(MESSAGE));
    expect({ code: error.code, retryable: error.retryable, smtp: error.smtp?.code }).toEqual({
      code: kind,
      retryable,
      smtp: code,
    });
    // Safe to log: no address, no subject, no server text.
    expect(JSON.stringify(error.toLog())).not.toMatch(/example\.test|Ticket|nope/);
    expect(error.message).not.toMatch(/example\.test|Ticket|nope/);
  });

  it('reports recipients the server refused while others were accepted (masked)', async () => {
    rcptRule = (address) =>
      address.startsWith('gone') ? { code: 550, message: '5.1.1 no such user' } : null;
    const result = await mailer.send({
      ...MESSAGE,
      to: ['an@example.test', 'gone@example.test', 'not an address'],
    });
    expect(result.accepted).toEqual(['a***@example.test']);
    expect(result.rejected).toEqual([
      { masked: '***', code: 'invalid_address', smtp: null },
      {
        masked: 'g***@example.test',
        code: 'smtp_rejected',
        smtp: { code: 550, enhanced: '5.1.1' },
      },
    ]);
  });

  it('every recipient refused with a 4xx → smtp_temporary', async () => {
    rcptRule = () => ({ code: 450, message: 'mailbox busy' });
    const error = await failure(mailer.send(MESSAGE));
    expect(error.code).toBe('smtp_temporary');
    expect(error.retryable).toBe(true);
    expect(error.rejected).toEqual([
      { masked: 'a***@example.test', code: 'smtp_temporary', smtp: { code: 450, enhanced: null } },
    ]);
  });

  it('every recipient refused with a 5xx → smtp_rejected listing each, masked (QA S5 L1)', async () => {
    rcptRule = (address) =>
      address.startsWith('gone')
        ? { code: 550, message: '5.1.1 no such user gone@example.test' }
        : { code: 553, message: '5.1.3 bad mailbox' };
    const error = await failure(
      mailer.send({
        ...MESSAGE,
        to: ['gone@example.test', 'not an address', 'other@corp.test'],
      }),
    );
    expect({ code: error.code, retryable: error.retryable, reason: error.reason }).toEqual({
      code: 'smtp_rejected',
      retryable: false,
      reason: 'rejected',
    });
    // Invalid addresses first, then the server's refusals in RCPT order; no server text.
    expect(error.rejected).toEqual([
      { masked: '***', code: 'invalid_address', smtp: null },
      {
        masked: 'g***@example.test',
        code: 'smtp_rejected',
        smtp: { code: 550, enhanced: '5.1.1' },
      },
      { masked: 'o***@corp.test', code: 'smtp_rejected', smtp: { code: 553, enhanced: '5.1.3' } },
    ]);
    expect(error.acceptedCount).toBe(0);
    expect(JSON.stringify(error.rejected)).not.toMatch(/gone@|other@|no such user/);
    expect(JSON.stringify(error.toLog())).not.toMatch(/example\.test|corp\.test/);
    expect(smtp.messages).toHaveLength(0);
  });

  it('a failure after RCPT lists no recipient (DATA refused)', async () => {
    dataRule = () => ({ code: 554, message: 'nope' });
    const error = await failure(mailer.send(MESSAGE));
    expect(error.rejected).toEqual([]);
    expect(error.acceptedCount).toBe(0);
  });

  it('gives the rate-limit slot back after a failure and after a success', async () => {
    const slots: string[] = [];
    const limited = createMailService(
      { mail: mailConfig(smtp.url), email: LIMITS },
      {
        rateLimiter: {
          acquire: () => {
            slots.push('acquire');
            return Promise.resolve({
              release: () => {
                slots.push('release');
                return Promise.resolve();
              },
            });
          },
        } as unknown as SendRateLimiter,
      },
    );
    dataRule = () => ({ code: 554, message: 'nope' });
    await failure(limited.send(MESSAGE));
    dataRule = () => null;
    await limited.send(MESSAGE);
    expect(slots).toEqual(['acquire', 'release', 'acquire', 'release']);
    limited.close();
  });

  it('validates before connecting: too many recipients, no valid one, HTML too large', async () => {
    const before = smtp.connections;
    const many = await failure(
      mailer.send({ ...MESSAGE, to: ['a@x.test', 'b@x.test'], cc: ['c@x.test', 'd@x.test'] }),
    );
    expect(many.code).toBe('too_many_recipients');
    // Duplicates (case-insensitive, across lists) count once.
    await mailer.send({
      ...MESSAGE,
      to: ['A@x.test', 'a@X.test'],
      cc: ['a@x.test', 'b@x.test'],
      bcc: ['c@x.test'],
    });
    expect(smtp.messages[0]?.to).toEqual(['A@x.test', 'b@x.test', 'c@x.test']);
    const none = await failure(mailer.send({ ...MESSAGE, to: ['nobody'] }));
    expect(none.code).toBe('invalid_recipients');
    const big = await failure(mailer.send({ ...MESSAGE, html: 'x'.repeat(2_001) }));
    expect(big.code).toBe('email_body_too_large');
    expect(smtp.connections).toBe(before + 1);
  });

  it('converts IDN domains to punycode', async () => {
    await mailer.send({ ...MESSAGE, to: ['an@bücher.example'] });
    expect(headerOf(smtp.messages[0]?.raw ?? '', 'To')).toBe('an@xn--bcher-kva.example');
  });

  it('accepts From only as SMTP_FROM or in SMTP_ALLOWED_FROM_DOMAINS', async () => {
    await mailer.send({ ...MESSAGE, from: { address: 'hr@corp.test', name: 'HR\r\nBcc: x' } });
    expect(headerOf(smtp.messages[0]?.raw ?? '', 'From')).toBe('"HR Bcc: x" <hr@corp.test>');
    const error = await failure(
      mailer.send({ ...MESSAGE, from: { address: 'ceo@elsewhere.test' } }),
    );
    expect(error.code).toBe('invalid_sender');
    const reply = await failure(mailer.send({ ...MESSAGE, replyTo: [{ address: 'x\r\n@a' }] }));
    expect(reply.code).toBe('invalid_sender');
  });

  it('waits for the next hour once the organization quota is used', async () => {
    const quota = memoryQuota(2);
    const limited = createMailService(
      { mail: mailConfig(smtp.url), email: LIMITS },
      { orgQuota: quota },
    );
    try {
      await limited.send(MESSAGE);
      await limited.send(MESSAGE);
      const error = await failure(limited.send(MESSAGE));
      expect(error.code).toBe('email_quota_exceeded');
      expect(error.retryable).toBe(true);
      expect(error.retryAt?.getTime()).toBeGreaterThan(Date.now());
      expect(smtp.messages).toHaveLength(2);
      // System email is not counted.
      await limited.send({ ...MESSAGE, origin: { kind: 'system' } });
      // Another organization has its own quota.
      await limited.send({
        ...MESSAGE,
        origin: { kind: 'notification', organizationId: 'org_b' },
      });
      expect(quota.counts.get('org_b')).toBe(1);
      // A failed send gives its count back.
      dataRule = () => ({ code: 451, message: 'later' });
      await failure(
        limited.send({ ...MESSAGE, origin: { kind: 'notification', organizationId: 'org_b' } }),
      );
      expect(quota.counts.get('org_b')).toBe(1);
    } finally {
      limited.close();
    }
  });

  it('requires STARTTLS by default: a server without it fails as tls_failed (retried)', async () => {
    const strict = createMailService({
      mail: mailConfig(smtp.url, { allowInsecure: false }),
      email: LIMITS,
    });
    try {
      expect(strict.instance).toEqual({ host: '***', port: smtp.port, security: 'starttls' });
      const error = await failure(strict.verify());
      expect({ code: error.code, reason: error.reason }).toEqual({
        code: 'smtp_temporary',
        reason: 'tls_failed',
      });
      expect(smtp.messages).toHaveLength(0);
    } finally {
      strict.close();
    }
  });

  it('without SMTP_URL: createMailer is null, the service refuses instance sends', async () => {
    expect(createMailer({ mail: null, email: LIMITS })).toBeNull();
    const service = createMailService({ mail: null, email: LIMITS });
    expect(service.instanceConfigured).toBe(false);
    expect((await failure(service.send(MESSAGE))).code).toBe('smtp_not_configured');
    expect((await failure(service.verify())).code).toBe('smtp_not_configured');
  });
});

describe('Mailer with a sender identity SMTP (T530 interface)', () => {
  let instance: TestSmtpServer;
  let company: TestSmtpServer;
  let mailer: Mailer;
  let credentialLoads = 0;
  let password = 'hr-secret';

  const identity = (version: number): MailTransportRef => ({
    kind: 'identity',
    identityId: 'eid_hr',
    version,
    endpoint: { host: '127.0.0.1', port: company.port, security: 'none', username: 'hr' },
    credentials: () => {
      credentialLoads += 1;
      return Promise.resolve({ user: 'hr', pass: password });
    },
    fromAddress: 'hr@corp.test',
  });

  beforeAll(async () => {
    instance = await startTestSmtp();
    company = await startTestSmtp({ auth: { user: 'hr', pass: 'hr-secret' } });
  });

  afterAll(async () => {
    await instance.close();
    await company.close();
  });

  afterEach(() => {
    mailer.close();
    instance.messages.length = 0;
    company.messages.length = 0;
    password = 'hr-secret';
  });

  it('sends through the identity SMTP with its own login, not the instance one', async () => {
    mailer = createMailService({ mail: mailConfig(instance.url), email: LIMITS });
    const loadsBefore = credentialLoads;
    await mailer.send({
      ...MESSAGE,
      transport: identity(1),
      from: { address: 'HR@corp.test', name: 'Phòng Nhân sự' },
    });
    await mailer.send({ ...MESSAGE, transport: identity(1) });
    expect(company.messages.map((mail) => mail.user)).toEqual(['hr', 'hr']);
    expect(headerOf(company.messages[1]?.raw ?? '', 'From')).toBe('hr@corp.test');
    expect(headerOf(company.messages[0]?.raw ?? '', 'Auto-Submitted')).toBe('auto-generated');
    expect(instance.messages).toHaveLength(0);
    // One transport per identity version: credentials loaded once.
    expect(credentialLoads - loadsBefore).toBe(1);
    await mailer.send(MESSAGE);
    expect(instance.messages).toHaveLength(1);
  });

  it('works without instance SMTP, and only with the identity address as From', async () => {
    mailer = createMailService({ mail: null, email: LIMITS });
    await mailer.send({ ...MESSAGE, transport: identity(1) });
    expect(company.messages).toHaveLength(1);
    const error = await failure(
      mailer.send({ ...MESSAGE, transport: identity(1), from: { address: 'ceo@corp.test' } }),
    );
    expect(error.code).toBe('invalid_sender');
  });

  it('rebuilds the transport when the version changes (new password)', async () => {
    mailer = createMailService({ mail: null, email: LIMITS });
    password = 'wrong';
    const error = await failure(mailer.verify(identity(1)));
    expect({ code: error.code, reason: error.reason, smtp: error.smtp?.code }).toEqual({
      code: 'smtp_rejected',
      reason: 'auth_failed',
      smtp: 535,
    });
    password = 'hr-secret';
    // Same version: the cached transport keeps the old credentials.
    expect((await failure(mailer.send({ ...MESSAGE, transport: identity(1) }))).code).toBe(
      'smtp_rejected',
    );
    await mailer.send({ ...MESSAGE, transport: identity(2) });
    expect(company.messages).toHaveLength(1);
  });

  it('applies the organization quota and the per-identity quota hook', async () => {
    const orgQuota = memoryQuota(10);
    const identityQuota = memoryQuota(1);
    mailer = createMailService({ mail: null, email: LIMITS }, { orgQuota, identityQuota });
    await mailer.send({ ...MESSAGE, transport: identity(1) });
    const error = await failure(mailer.send({ ...MESSAGE, transport: identity(1) }));
    expect(error.code).toBe('email_quota_exceeded');
    // The organization count taken before the identity refused is given back.
    expect(orgQuota.counts.get('org_a')).toBe(1);
    expect(identityQuota.counts.get('eid_hr')).toBe(1);
  });

  it('a credential loading failure is temporary', async () => {
    mailer = createMailService({ mail: null, email: LIMITS });
    const broken: MailTransportRef = {
      ...(identity(3) as Extract<MailTransportRef, { kind: 'identity' }>),
      credentials: () => Promise.reject(new Error('cannot decrypt')),
    };
    const error = await failure(mailer.send({ ...MESSAGE, transport: broken }));
    expect({ code: error.code, retryable: error.retryable }).toEqual({
      code: 'smtp_temporary',
      retryable: true,
    });
  });
});
