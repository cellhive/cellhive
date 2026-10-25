import { createServer, type Server, type Socket, AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createMailService,
  EmailSendError,
  type Mailer,
  type MailTransportRef,
} from '../../../src/mail/index.js';
import { headerOf, startTestSmtp, type TestSmtpServer } from '../../support/smtp-test-server.js';

import type { EmailLimits } from '../../../src/config/index.js';
import type { HostLookup } from '../../../src/mail/identities/index.js';

const PASSWORD = 'hr-app-password-42';

const LIMITS: EmailLimits = {
  maxPerHourPerOrg: 500,
  maxRecipients: 50,
  maxPerSecond: 1000,
  testSendsPerMinute: 5,
  maxHtmlBytes: 100_000,
  allowPrivateSmtpHosts: false,
  maxPerHourPerIdentity: 100,
  automationFooter: 'required',
  maxAttachments: 10,
  maxAttachmentBytes: 15 * 1024 * 1024,
  maxInlineImages: 5,
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

/** Identity SMTP (T530) reached through `mail.corp.test`, resolved by `lookup`. */
describe('identity SMTP: AUTH, SSRF guard on connect, timeouts (T530)', () => {
  let smtp: TestSmtpServer;
  let mailer: Mailer | undefined;

  beforeAll(async () => {
    smtp = await startTestSmtp({ auth: { user: 'hr@corp.test', pass: PASSWORD } });
  });

  afterAll(async () => {
    await smtp.close();
  });

  afterEach(() => {
    mailer?.close();
    mailer = undefined;
    smtp.messages.length = 0;
    smtp.connections = 0;
  });

  function identity(pass: string, version = 1, port = smtp.port): MailTransportRef {
    return {
      kind: 'identity',
      identityId: 'eid_HrIdentity000001',
      version,
      endpoint: { host: 'mail.corp.test', port, security: 'none', username: 'hr@corp.test' },
      credentials: () => Promise.resolve({ user: 'hr@corp.test', pass }),
      fromAddress: 'hr@corp.test',
    };
  }

  function service(allowPrivate: boolean, lookup: HostLookup, timeouts = {}): Mailer {
    return createMailService(
      { mail: null, email: { ...LIMITS, allowPrivateSmtpHosts: allowPrivate } },
      { hostLookup: lookup, identityTimeouts: timeouts },
    );
  }

  const loopback: HostLookup = () => Promise.resolve(['127.0.0.1']);

  it('logs in with the identity account and sends from the identity to itself', async () => {
    mailer = service(true, loopback);
    await mailer.verify(identity(PASSWORD));
    const sent = await mailer.send({
      to: 'hr@corp.test',
      subject: 'Verify',
      text: 'code 123456',
      html: '<p>code 123456</p>',
      from: { address: 'hr@corp.test', name: 'HR' },
      transport: identity(PASSWORD),
    });
    expect(sent.accepted).toEqual(['h***@corp.test']);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toMatchObject({
      from: 'hr@corp.test',
      to: ['hr@corp.test'],
      user: 'hr@corp.test',
    });
    expect(headerOf(smtp.messages[0]?.raw ?? '', 'From')).toBe('HR <hr@corp.test>');
  });

  it('reports a wrong password as 535 auth_failed, without the password', async () => {
    mailer = service(true, loopback);
    const error = await failure(mailer.verify(identity('wrong-password', 2)));
    expect(error).toMatchObject({
      code: 'smtp_rejected',
      reason: 'auth_failed',
      retryable: false,
      smtp: { code: 535 },
    });
    const send = await failure(
      mailer.send({
        to: 'hr@corp.test',
        subject: 'x',
        text: 'x',
        html: '<p>x</p>',
        transport: identity('wrong-password', 2),
      }),
    );
    expect(send.reason).toBe('auth_failed');
    for (const err of [error, send]) {
      expect(`${err.message} ${JSON.stringify(err.toLog())} ${String(err.stack)}`).not.toContain(
        'wrong-password',
      );
    }
    expect(smtp.messages).toHaveLength(0);
  });

  it('refuses at connect a host that now resolves to a private address (DNS rebinding)', async () => {
    let calls = 0;
    const rebinding: HostLookup = () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? ['93.184.216.34'] : ['127.0.0.1']);
    };
    // The first answer is what the save-time check saw.
    await rebinding('mail.corp.test');
    mailer = service(false, rebinding);
    const error = await failure(mailer.verify(identity(PASSWORD, 3)));
    expect(error).toMatchObject({
      code: 'smtp_rejected',
      reason: 'host_not_allowed',
      retryable: false,
    });
    expect(smtp.connections).toBe(0);
  });

  it('allows the LAN server with SMTP_ALLOW_PRIVATE_HOSTS, never a metadata address', async () => {
    mailer = service(true, () => Promise.resolve(['169.254.169.254']));
    expect((await failure(mailer.verify(identity(PASSWORD, 4)))).reason).toBe('host_not_allowed');
  });

  describe('a server that accepts TCP but never greets', () => {
    let silent: Server;
    let port: number;
    const sockets = new Set<Socket>();

    beforeAll(async () => {
      silent = createServer((socket) => {
        // Never answers.
        sockets.add(socket);
      });
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
      port = (silent.address() as AddressInfo).port;
    });

    afterAll(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        silent.close(() => {
          resolve();
        });
      });
    });

    it('times out instead of holding the worker', async () => {
      mailer = service(true, loopback, { greetingTimeout: 200, socketTimeout: 500 });
      const started = Date.now();
      const error = await failure(mailer.verify(identity(PASSWORD, 5, port)));
      expect(error).toMatchObject({ code: 'smtp_temporary', retryable: true });
      expect(['timeout', 'connection_failed']).toContain(error.reason);
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });
});
