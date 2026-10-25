import { once } from 'node:events';

import { emailSettingsSchema, emailTestResultSchema, type Id } from '@cellhive/contracts';
import { EmailSendError, type Db, type Mailer } from '@cellhive/server-core';
import { sql } from 'kysely';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAILER } from '../../src/common/tokens.js';

import {
  Browser,
  decodeQuotedPrintable,
  seedOrg,
  seedUser,
  startSmtpCapture,
  type SeededUser,
  type SmtpCapture,
} from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { AddressInfo } from 'node:net';

const SMTP_PASSWORD = 'smtp-secret-pass-9';

/** An SMTP server that refuses every message with `code`. */
async function startRefusingSmtp(code: number): Promise<{ url: string; close(): Promise<void> }> {
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, _session, callback) {
      stream.resume();
      stream.on('end', () => {
        callback(Object.assign(new Error('refused'), { responseCode: code }));
      });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server.server, 'listening');
  const { port } = server.server.address() as AddressInfo;
  return {
    url: `smtp://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** `/orgs/:orgId/email-settings` (T513, CONTRACTS §23). */
describe('email settings (T513)', () => {
  let database: TestDatabase;
  let db: Db;
  let smtp: SmtpCapture;
  let mailApp: TestApp;
  let plainApp: TestApp;
  let org: Id<'org'>;
  let owner: SeededUser;
  let admin: SeededUser;
  let member: SeededUser;
  let stranger: SeededUser;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    smtp = await startSmtpCapture();
    const url = new URL(smtp.url);
    url.username = 'mailer';
    url.password = SMTP_PASSWORD;
    mailApp = await startTestApp({
      DATABASE_URL: database.url,
      SMTP_URL: url.toString(),
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
      SMTP_ALLOWED_FROM_DOMAINS: 'cellhive.test,corp.test',
      SMTP_ALLOW_INSECURE: 'true',
      EMAIL_TEST_SEND_PER_MIN: '2',
      EMAIL_MAX_PER_HOUR_PER_ORG: '3',
    });
    plainApp = await startTestApp({ DATABASE_URL: database.url });
    org = await seedOrg(db, 'Mail');
    const other = await seedOrg(db, 'Other');
    owner = await seedUser(db, { memberships: [{ orgId: org, role: 'owner' }] });
    admin = await seedUser(db, { memberships: [{ orgId: org, role: 'admin' }] });
    member = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
    stranger = await seedUser(db, { memberships: [{ orgId: other, role: 'owner' }] });
  });

  afterAll(async () => {
    await mailApp.close();
    await plainApp.close();
    await smtp.close();
    await db.destroy();
    await database.drop();
  });

  async function signedIn(app: TestApp, user: SeededUser): Promise<Browser> {
    const browser = new Browser(app.app);
    expect((await browser.login(user.email)).statusCode).toBe(204);
    return browser;
  }

  it('reports SMTP as not configured and refuses the test with 422', async () => {
    const browser = await signedIn(plainApp, owner);
    const settings = await browser.request({ url: `/api/v1/orgs/${org}/email-settings` });
    expect(settings.statusCode).toBe(200);
    expect(emailSettingsSchema.parse(settings.json()).smtp).toEqual({
      configured: false,
      host: null,
      port: null,
      security: null,
      from: null,
      from_name: null,
      allowed_from_domains: [],
    });
    const test = await browser.request({
      method: 'POST',
      url: `/api/v1/orgs/${org}/email-settings/test`,
    });
    expect(test.statusCode).toBe(422);
    expect(problemOf(test.body).code).toBe('SMTP_NOT_CONFIGURED');
  });

  it('shows the masked SMTP status and limits, never the credentials', async () => {
    const browser = await signedIn(mailApp, admin);
    const response = await browser.request({ url: `/api/v1/orgs/${org}/email-settings` });
    expect(response.statusCode).toBe(200);
    const body = emailSettingsSchema.parse(response.json());
    expect(body.smtp).toEqual({
      configured: true,
      host: '***',
      port: Number(new URL(smtp.url).port),
      security: 'none',
      from: 'noreply@cellhive.test',
      from_name: 'Cellhive',
      allowed_from_domains: ['cellhive.test', 'corp.test'],
    });
    expect(body.limits).toEqual({
      max_per_hour_per_org: 3,
      max_recipients: 50,
      max_per_second_per_process: 5,
      test_sends_per_minute: 2,
      max_html_bytes: 102_400,
      max_attachments: 10,
      max_attachment_bytes: 15 * 1024 * 1024,
      max_inline_images: 5,
    });
    expect(response.body).not.toContain(SMTP_PASSWORD);
    expect(response.body).not.toContain('mailer');
  });

  it('is for organization owners/admins: members 403, other organizations 404', async () => {
    const asMember = await signedIn(mailApp, member);
    const asStranger = await signedIn(mailApp, stranger);
    for (const [browser, status] of [
      [asMember, 403],
      [asStranger, 404],
    ] as const) {
      const get = await browser.request({ url: `/api/v1/orgs/${org}/email-settings` });
      const test = await browser.request({
        method: 'POST',
        url: `/api/v1/orgs/${org}/email-settings/test`,
      });
      expect([get.statusCode, test.statusCode]).toEqual([status, status]);
    }
    expect(smtp.messages).toHaveLength(0);
  });

  it('emails only the caller, with the mandatory headers, audited without content', async () => {
    const browser = await signedIn(mailApp, owner);
    const response = await browser.request({
      method: 'POST',
      url: `/api/v1/orgs/${org}/email-settings/test`,
    });
    expect(response.statusCode).toBe(200);
    const result = emailTestResultSchema.parse(response.json());
    expect(result).toMatchObject({ status: 'sent', to: owner.email, smtp: { code: 250 } });
    expect(smtp.messages).toHaveLength(1);
    const mail = smtp.messages[0];
    expect(mail?.to).toEqual([owner.email]);
    const raw = mail?.raw ?? '';
    expect(raw).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(raw).toMatch(/^Auto-Submitted: auto-generated$/m);
    expect(raw).toMatch(/^X-Auto-Response-Suppress: OOF, AutoReply$/m);
    expect(raw).not.toMatch(/^Sender:/m);
    // The organization locale (vi) is used when the user has none.
    expect(decodeQuotedPrintable(raw)).toContain('max-width:600px');
    const { rows } = await sql<{ after: Record<string, unknown> }>`
      SELECT after FROM meta.audit_logs
       WHERE organization_id = ${org} AND action = 'email.test_sent'
    `.execute(db.kysely);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after).toEqual({ status: 'sent', smtp_code: 250 });
    expect(JSON.stringify(rows)).not.toContain(owner.email);
    expect(mailApp.logs.raw()).not.toContain(owner.email);
  });

  it('limits test emails per user per minute (EMAIL_TEST_SEND_PER_MIN)', async () => {
    const browser = await signedIn(mailApp, admin);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await browser.request({
        method: 'POST',
        url: `/api/v1/orgs/${org}/email-settings/test`,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('reports a rejecting server as failed/smtp_rejected', async () => {
    const refusing = await startRefusingSmtp(554);
    const app = await startTestApp({
      DATABASE_URL: database.url,
      SMTP_URL: refusing.url,
      SMTP_FROM: 'noreply@cellhive.test',
      SMTP_ALLOW_INSECURE: 'true',
    });
    try {
      const browser = await signedIn(app, owner);
      const response = await browser.request({
        method: 'POST',
        url: `/api/v1/orgs/${org}/email-settings/test`,
      });
      expect(response.statusCode).toBe(200);
      expect(emailTestResultSchema.parse(response.json())).toEqual({
        status: 'failed',
        code: 'smtp_rejected',
        reason: 'rejected',
        smtp: { code: 554, enhanced: null },
      });
    } finally {
      await app.close();
      await refusing.close();
    }
  });

  it('holds organization emails over EMAIL_MAX_PER_HOUR_PER_ORG until the next hour', async () => {
    const mailer = mailApp.app.get<Mailer>(MAILER);
    const message = {
      to: 'someone@example.test',
      subject: 'Hello',
      text: 'Hello',
      html: '<p>Hello</p>',
      origin: { kind: 'notification', organizationId: org },
    } as const;
    smtp.messages.length = 0;
    for (let i = 0; i < 3; i += 1) await mailer.send(message);
    let held: unknown;
    try {
      await mailer.send(message);
    } catch (error) {
      held = error;
    }
    expect(held).toBeInstanceOf(EmailSendError);
    expect((held as EmailSendError).code).toBe('email_quota_exceeded');
    expect((held as EmailSendError).retryAt?.getUTCMinutes()).toBe(0);
    expect(smtp.messages).toHaveLength(3);
    // Another organization is not affected; system email is not counted.
    await mailer.send({ ...message, origin: { kind: 'notification', organizationId: 'org_x' } });
    await mailer.send({ ...message, origin: { kind: 'system' } });
    const browser = await signedIn(mailApp, owner);
    const settings = emailSettingsSchema.parse(
      (await browser.request({ url: `/api/v1/orgs/${org}/email-settings` })).json(),
    );
    expect(settings.usage.sent_this_hour).toBe(3);
  });
});
