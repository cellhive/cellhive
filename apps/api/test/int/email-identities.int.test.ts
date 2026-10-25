import { once } from 'node:events';

import {
  baseDetailSchema,
  baseEmailIdentityListSchema,
  emailIdentityListSchema,
  emailIdentityMutationSchema,
  emailIdentitySchema,
  emailVerificationOutcomeSchema,
  emailVerificationPreviewSchema,
  workspaceSchema,
  type EmailIdentityDto,
  type Id,
} from '@cellhive/contracts';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  orgScope,
  type Db,
} from '@cellhive/server-core';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Browser,
  decodeQuotedPrintable,
  seedOrg,
  seedUser,
  startSmtpCapture,
  uniqueIp,
  type SeededUser,
  type SmtpCapture,
} from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';
import type { AddressInfo } from 'node:net';

const SMTP_USER = 'it@corp.test';
const SMTP_PASSWORD = 'It-Mailbox-Secret-77';
const NEW_SMTP_PASSWORD = 'It-Mailbox-Rotated-88';

interface ReceivedMail {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
  readonly user: string | null;
}

/**
 * An SMTP server with AUTH on one of the ports identities may use (only
 * 25/465/587/2525 are accepted), on 127.0.0.1 without TLS.
 */
async function startAuthSmtp(): Promise<{
  port: number;
  messages: ReceivedMail[];
  password: { value: string };
  close(): Promise<void>;
}> {
  const messages: ReceivedMail[] = [];
  const password = { value: SMTP_PASSWORD };
  for (const port of [2525, 587, 465, 25]) {
    const server = new SMTPServer({
      logger: false,
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      closeTimeout: 100,
      onAuth(auth, _session, callback) {
        if (auth.username === SMTP_USER && auth.password === password.value) {
          callback(null, { user: auth.username });
          return;
        }
        callback(Object.assign(new Error('Invalid credentials'), { responseCode: 535 }));
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          messages.push({
            from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
            to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
            raw: Buffer.concat(chunks).toString('utf8'),
            user: typeof session.user === 'string' ? session.user : null,
          });
          callback();
        });
      },
    });
    try {
      server.listen(port, '127.0.0.1');
      await Promise.race([
        once(server.server, 'listening'),
        once(server.server, 'error').then(([error]) => {
          throw error;
        }),
      ]);
    } catch {
      continue;
    }
    return {
      port: (server.server.address() as AddressInfo).port,
      messages,
      password,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    };
  }
  throw new Error('no allowed SMTP port (2525, 587, 465, 25) is free for the test server');
}

function headerOf(raw: string, name: string): string | null {
  const head = raw.split(/\r?\n\r?\n/)[0] ?? '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0 && line.slice(0, colon).toLowerCase() === name.toLowerCase()) {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}

/** Link token and 6-digit code of a verification email. */
function secretsOf(raw: string): { token: string; code: string } {
  const body = decodeQuotedPrintable(raw);
  const token = /verify-sender\?token=([A-Za-z0-9_.%-]+)/.exec(body)?.[1];
  const code = /: (\d{6})\b/.exec(body)?.[1];
  if (token === undefined || code === undefined) throw new Error('no token/code in the email');
  return { token: decodeURIComponent(token), code };
}

/** RFC 2047 `=?UTF-8?Q?…?=` / `=?UTF-8?B?…?=` words of a header, decoded. */
function decodeHeader(value: string | null): string {
  // White space between adjacent encoded words is not part of the text.
  return (value ?? '')
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?utf-8\?([qb])\?([^?]*)\?=/gi, (_match, kind: string, text: string) =>
      kind.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(decodeQuotedPrintable(text.replaceAll('_', ' ')), 'latin1').toString('utf8'),
    );
}

describe('sender identities (T530, ADR-33)', () => {
  let database: TestDatabase;
  let db: Db;
  let instance: SmtpCapture;
  let identitySmtp: Awaited<ReturnType<typeof startAuthSmtp>>;
  let app: TestApp;
  let guardedApp: TestApp;
  let org: Id<'org'>;
  let otherOrg: Id<'org'>;
  let owner: SeededUser;
  let admin: SeededUser;
  let member: SeededUser;
  let baseAdmin: SeededUser;
  let reader: SeededUser;
  let stranger: SeededUser;
  let baseA: Id<'bse'>;
  let baseB: Id<'bse'>;
  const browsers = new Map<string, Browser>();

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    instance = await startSmtpCapture();
    identitySmtp = await startAuthSmtp();
    const common = {
      DATABASE_URL: database.url,
      SMTP_URL: instance.url,
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
      SMTP_ALLOWED_FROM_DOMAINS: 'cellhive.test,corp.test',
      SMTP_ALLOW_INSECURE: 'true',
    };
    // The test SMTP servers listen on 127.0.0.1: allowed here only.
    app = await startTestApp({ ...common, SMTP_ALLOW_PRIVATE_HOSTS: 'true' });
    guardedApp = await startTestApp(common);
    org = await seedOrg(db, 'Identities');
    otherOrg = await seedOrg(db, 'Elsewhere');
    owner = await seedUser(db, { memberships: [{ orgId: org, role: 'owner' }] });
    admin = await seedUser(db, {
      memberships: [{ orgId: org, role: 'admin' }],
      displayName: 'Chị Quản Trị',
    });
    member = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
    baseAdmin = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
    reader = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
    stranger = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] });

    const workspace = await call(owner, 'POST', `/orgs/${org}/workspaces`, { name: 'Main' });
    const workspaceId = workspaceSchema.parse(workspace.json()).id;
    const bases: Id<'bse'>[] = [];
    for (const name of ['A', 'B']) {
      const base = await call(owner, 'POST', `/workspaces/${workspaceId}/bases`, { name });
      expect(base.statusCode).toBe(201);
      bases.push(baseDetailSchema.parse(base.json()).id);
    }
    [baseA = 'bse_0000000000000000', baseB = 'bse_0000000000000000'] = bases;
    await assignRole(baseA, 'system_admin', baseAdmin.id);
    await assignRole(baseB, 'system_admin', baseAdmin.id);
    await assignRole(baseA, 'system_reader', reader.id);
  });

  afterAll(async () => {
    await app.close();
    await guardedApp.close();
    await instance.close();
    await identitySmtp.close();
    await db.destroy();
    await database.drop();
  });

  async function assignRole(
    baseId: Id<'bse'>,
    kind: 'system_admin' | 'system_reader',
    userId: Id<'usr'>,
  ): Promise<void> {
    const scope = orgScope(org);
    const role = (await new BaseRolesRepository(db).listByBase(scope, baseId)).find(
      (row) => row.kind === kind,
    );
    if (role === undefined) throw new Error(`no ${kind} role`);
    await new BaseRoleMembersRepository(db).assign(scope, {
      baseId,
      roleId: role.id,
      principalType: 'user',
      principalId: userId,
    });
  }

  async function as(user: SeededUser, target: TestApp = app): Promise<Browser> {
    const key = `${user.id}:${target === app ? 'app' : target === guardedApp ? 'guarded' : 'other'}`;
    let browser = browsers.get(key);
    if (browser === undefined) {
      browser = new Browser(target.app);
      expect((await browser.login(user.email)).statusCode).toBe(204);
      browsers.set(key, browser);
    }
    return browser;
  }

  async function call(
    user: SeededUser,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    target: TestApp = app,
  ): Promise<LightMyRequestResponse> {
    const browser = await as(user, target);
    return browser.request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  /** Anonymous request (the public verification page). */
  function anonymous(url: string, payload: object): Promise<LightMyRequestResponse> {
    return app.app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      payload,
      remoteAddress: uniqueIp(),
    });
  }

  function expectProblem(
    response: LightMyRequestResponse,
    status: number,
    code: string,
    detail?: string,
  ): void {
    const problem = problemOf(response.body) as { code?: string; errors?: { code: string }[] };
    expect({ status: response.statusCode, code: problem.code }).toEqual({ status, code });
    if (detail !== undefined) expect(problem.errors?.map((error) => error.code)).toContain(detail);
  }

  function lastMailTo(messages: readonly { to: readonly string[]; raw: string }[], to: string) {
    const found = [...messages].reverse().find((message) => message.to.includes(to));
    if (found === undefined) throw new Error(`no email to ${to}`);
    return found;
  }

  async function createSystem(email: string, extra: object = {}) {
    const response = await call(admin, 'POST', `/orgs/${org}/email-identities`, {
      email,
      display_name: 'Phòng Nhân sự',
      transport: 'system',
      ...extra,
    });
    expect(response.statusCode).toBe(201);
    return emailIdentityMutationSchema.parse(response.json());
  }

  function smtpBody(overrides: object = {}) {
    return {
      host: '127.0.0.1',
      port: identitySmtp.port,
      security: 'none',
      username: SMTP_USER,
      password: SMTP_PASSWORD,
      allow_insecure: true,
      ...overrides,
    };
  }

  async function auditOf(entityId: string) {
    return db.kysely
      .selectFrom('meta.audit_logs')
      .select(['action', 'before', 'after', 'actor_type'])
      .where('organization_id', '=', org)
      .where('entity_id', '=', entityId)
      .orderBy('created_at')
      .execute();
  }

  describe('permissions', () => {
    it('lets organization owners/admins manage identities only (403 member, 404 elsewhere)', async () => {
      expect((await call(owner, 'GET', `/orgs/${org}/email-identities`)).statusCode).toBe(200);
      expect((await call(admin, 'GET', `/orgs/${org}/email-identities`)).statusCode).toBe(200);
      for (const user of [member, baseAdmin]) {
        expectProblem(
          await call(user, 'GET', `/orgs/${org}/email-identities`),
          403,
          'PERMISSION_DENIED',
        );
        expectProblem(
          await call(user, 'POST', `/orgs/${org}/email-identities`, {
            email: 'x@corp.test',
            display_name: 'X',
            transport: 'system',
          }),
          403,
          'PERMISSION_DENIED',
        );
      }
      expectProblem(await call(stranger, 'GET', `/orgs/${org}/email-identities`), 404, 'NOT_FOUND');

      const created = await createSystem('perm@corp.test');
      const id = created.identity.id;
      expectProblem(
        await call(baseAdmin, 'GET', `/email-identities/${id}`),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(baseAdmin, 'POST', `/email-identities/${id}/disable`),
        403,
        'PERMISSION_DENIED',
      );
      // Another organization: as if it did not exist.
      for (const [method, url] of [
        ['GET', `/email-identities/${id}`],
        ['PATCH', `/email-identities/${id}`],
        ['DELETE', `/email-identities/${id}`],
        ['POST', `/email-identities/${id}/send-verification`],
        ['POST', `/email-identities/${id}/verify-code`],
        ['GET', `/email-identities/${id}/usages`],
      ] as const) {
        const payload =
          method === 'PATCH'
            ? { display_name: 'x' }
            : method === 'POST' && url.endsWith('code')
              ? { code: '123456' }
              : undefined;
        expectProblem(await call(stranger, method, url, payload), 404, 'NOT_FOUND');
      }
      expect((await call(admin, 'GET', `/email-identities/${id}/usages`)).json()).toEqual({
        items: [],
        total: 0,
      });
    });
  });

  describe('transport system', () => {
    it('verifies hr@ (allowed domain, send_as) through the link: GET page does nothing, POST confirms', async () => {
      const created = await createSystem('HR@Corp.Test', { reply_to: 'jobs@corp.test' });
      expect(created.identity).toMatchObject({
        email: 'hr@corp.test',
        transport: 'system',
        mode: 'send_as',
        status: 'pending',
        smtp: null,
        display: { from: '"Phòng Nhân sự" <hr@corp.test>', reply_to: '<jobs@corp.test>' },
        verification: { pending: true, code_attempts_left: 5 },
      });
      expect(created.verification).toMatchObject({ status: 'sent', to: 'hr@corp.test' });

      const mail = lastMailTo(instance.messages, 'hr@corp.test');
      // The verification email comes from the instance sender, never the
      // unverified display name (T528, QA S5 M7).
      expect(decodeHeader(headerOf(mail.raw, 'From'))).toBe('Cellhive <noreply@cellhive.test>');
      expect(headerOf(mail.raw, 'Reply-To')).toBeNull();
      expect(headerOf(mail.raw, 'Auto-Submitted')).toBe('auto-generated');
      expect(headerOf(mail.raw, 'Sender')).toBeNull();
      const { token, code } = secretsOf(mail.raw);
      expect(token.startsWith(`${org}.`)).toBe(true);

      // The page preview (what a link scanner opening the link would trigger) changes nothing.
      const preview = await anonymous('/email-identities/verify/preview', { token });
      expect(preview.statusCode).toBe(200);
      expect(emailVerificationPreviewSchema.parse(preview.json())).toMatchObject({
        organization_name: 'Identities',
        email: 'hr@corp.test',
        display_name: 'Phòng Nhân sự',
        requested_by: 'Chị Quản Trị',
      });
      const id = created.identity.id;
      expect(
        emailIdentitySchema.parse((await call(admin, 'GET', `/email-identities/${id}`)).json())
          .status,
      ).toBe('pending');

      const confirmed = await anonymous('/email-identities/verify', { token });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json()).toEqual({ status: 'verified', email: 'hr@corp.test' });
      const identity = emailIdentitySchema.parse(
        (await call(admin, 'GET', `/email-identities/${id}`)).json(),
      );
      expect(identity).toMatchObject({
        status: 'verified',
        verified_via: 'link',
        mode: 'send_as',
        verification: { pending: false },
      });
      // Single use.
      expectProblem(
        await anonymous('/email-identities/verify', { token }),
        422,
        'EMAIL_VERIFICATION_INVALID',
        'TOKEN_INVALID',
      );

      // Audit and events: never the token or the code.
      const entries = await auditOf(id);
      expect(entries.map((entry) => entry.action)).toEqual([
        'email_identity.created',
        'email_identity.verification_sent',
        'email_identity.verified',
      ]);
      expect(entries[2]).toMatchObject({ actor_type: 'system', after: { via: 'link' } });
      const events = await db.kysely
        .selectFrom('meta.events')
        .select('payload')
        .where('entity_id', '=', id)
        .execute();
      const stored = JSON.stringify([entries, events]);
      expect(stored).not.toContain(token.split('.')[1]);
      expect(stored).not.toContain(code);
      expect(app.logs.raw()).not.toContain(token.split('.')[1]);
      expect(app.logs.raw()).not.toContain(`: ${code}`);

      // Renaming does not need a new verification; a new address does.
      const renamed = await call(admin, 'PATCH', `/email-identities/${id}`, {
        display_name: 'HR team',
        base_scope: 'selected',
        base_ids: [baseA],
      });
      expect(emailIdentityMutationSchema.parse(renamed.json())).toMatchObject({
        identity: { status: 'verified', display_name: 'HR team', base_ids: [baseA] },
        verification: null,
      });
      const moved = emailIdentityMutationSchema.parse(
        (
          await call(admin, 'PATCH', `/email-identities/${id}`, { email: 'people@corp.test' })
        ).json(),
      );
      expect(moved).toMatchObject({
        identity: { status: 'pending', email: 'people@corp.test', verified_at: null },
        verification: { status: 'sent', to: 'people@corp.test' },
      });
      const updated = (await auditOf(id)).find(
        (entry) => entry.action === 'email_identity.updated',
      );
      expect(updated).toMatchObject({
        before: { display_name: 'Phòng Nhân sự', base_scope: 'all', base_ids: [] },
        after: { display_name: 'HR team', base_scope: 'selected', base_ids: [baseA] },
      });
    });

    it('logs a verification email without SMTP as information, not as a failure (T527)', async () => {
      const bare = await startTestApp({ DATABASE_URL: database.url });
      try {
        const response = await call(
          admin,
          'POST',
          `/orgs/${org}/email-identities`,
          { email: 'no-smtp@corp.test', display_name: 'Không SMTP', transport: 'system' },
          bare,
        );
        expect(response.statusCode).toBe(201);
        const created = emailIdentityMutationSchema.parse(response.json());
        expect(created.identity.status).toBe('pending');
        expect(created.verification).toMatchObject({
          status: 'failed',
          code: 'smtp_not_configured',
        });
        const lines = bare.logs.lines.filter((line) => line['identity_id'] === created.identity.id);
        expect(lines.map((line) => [line['level'], line['msg']])).toEqual([
          ['info', 'sender identity verification email not sent: no SMTP configured'],
        ]);
      } finally {
        await bare.close();
      }
    });

    it('sends an address outside the allowed domains on behalf of Cellhive, verified by code', async () => {
      const created = await createSystem('hr-corp@gmail.com');
      expect(created.identity).toMatchObject({
        mode: 'on_behalf',
        hints: ['sent_on_behalf'],
        display: {
          from: '"Phòng Nhân sự (qua Cellhive)" <noreply@cellhive.test>',
          reply_to: '<hr-corp@gmail.com>',
        },
      });
      const mail = lastMailTo(instance.messages, 'hr-corp@gmail.com');
      expect(decodeHeader(headerOf(mail.raw, 'From'))).toBe('Cellhive <noreply@cellhive.test>');
      expect(headerOf(mail.raw, 'Reply-To')).toBeNull();
      const { code } = secretsOf(mail.raw);
      const id = created.identity.id;

      const wrong = code === '000000' ? '111111' : '000000';
      const attempt = await call(admin, 'POST', `/email-identities/${id}/verify-code`, {
        code: wrong,
      });
      expectProblem(attempt, 422, 'EMAIL_VERIFICATION_INVALID', 'CODE_INVALID');
      expect(problemOf(attempt.body)).toMatchObject({ errors: [{ params: { attempts_left: 4 } }] });
      const verified = await call(admin, 'POST', `/email-identities/${id}/verify-code`, { code });
      expect(verified.statusCode).toBe(200);
      expect(emailIdentitySchema.parse(verified.json())).toMatchObject({
        status: 'verified',
        verified_via: 'code',
        mode: 'on_behalf',
      });
    });

    it('locks the code after 5 wrong attempts until a new email; limits resends to 3 per hour', async () => {
      const created = await createSystem('lock@corp.test');
      const id = created.identity.id;
      const { code } = secretsOf(lastMailTo(instance.messages, 'lock@corp.test').raw);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        expectProblem(
          await call(admin, 'POST', `/email-identities/${id}/verify-code`, { code: wrong }),
          422,
          'EMAIL_VERIFICATION_INVALID',
          'CODE_INVALID',
        );
      }
      expectProblem(
        await call(admin, 'POST', `/email-identities/${id}/verify-code`, { code: wrong }),
        422,
        'EMAIL_VERIFICATION_INVALID',
        'CODE_LOCKED',
      );
      // Even the right code is refused now.
      expectProblem(
        await call(admin, 'POST', `/email-identities/${id}/verify-code`, { code }),
        422,
        'EMAIL_VERIFICATION_INVALID',
        'CODE_LOCKED',
      );
      // Second and third email of the hour (the creation sent the first).
      for (let send = 2; send <= 3; send += 1) {
        const resent = await call(admin, 'POST', `/email-identities/${id}/send-verification`);
        expect(resent.statusCode).toBe(200);
        expect(emailVerificationOutcomeSchema.parse(resent.json()).status).toBe('sent');
      }
      const fourth = await call(admin, 'POST', `/email-identities/${id}/send-verification`);
      expectProblem(fourth, 429, 'RATE_LIMITED');
      expect(fourth.headers['retry-after']).toBeDefined();

      const fresh = secretsOf(lastMailTo(instance.messages, 'lock@corp.test').raw);
      const verified = await call(admin, 'POST', `/email-identities/${id}/verify-code`, {
        code: fresh.code,
      });
      expect(emailIdentitySchema.parse(verified.json()).status).toBe('verified');
      expectProblem(
        await call(admin, 'POST', `/email-identities/${id}/send-verification`),
        422,
        'VALIDATION_FAILED',
        'NOT_VERIFIABLE',
      );
    });

    it('answers the same 422 for expired, replaced, foreign and malformed tokens', async () => {
      const created = await createSystem('tokens@corp.test');
      const first = secretsOf(lastMailTo(instance.messages, 'tokens@corp.test').raw);
      const secret = first.token.split('.')[1] ?? '';
      // Same secret under another organization id.
      expectProblem(
        await anonymous('/email-identities/verify', { token: `${otherOrg}.${secret}` }),
        422,
        'EMAIL_VERIFICATION_INVALID',
        'TOKEN_INVALID',
      );
      for (const token of ['garbage', `${org}.short`, `${org}.${'A'.repeat(43)}`]) {
        expectProblem(
          await anonymous('/email-identities/verify/preview', { token }),
          422,
          'EMAIL_VERIFICATION_INVALID',
          'TOKEN_INVALID',
        );
      }
      // Expired.
      await db.kysely
        .updateTable('meta.email_identity_verifications')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('identity_id', '=', created.identity.id)
        .execute();
      expectProblem(
        await anonymous('/email-identities/verify', { token: first.token }),
        422,
        'EMAIL_VERIFICATION_INVALID',
        'TOKEN_INVALID',
      );
      // Replaced by a new email.
      await call(admin, 'POST', `/email-identities/${created.identity.id}/send-verification`);
      expectProblem(
        await anonymous('/email-identities/verify/preview', { token: first.token }),
        422,
        'EMAIL_VERIFICATION_INVALID',
        'TOKEN_INVALID',
      );
      expectProblem(
        await call(admin, 'POST', `/email-identities/${created.identity.id}/test-and-verify`),
        422,
        'VALIDATION_FAILED',
        'TRANSPORT_NOT_SMTP',
      );
    });
  });

  describe('transport smtp', () => {
    it('tests and verifies with the identity SMTP; the password is write-only', async () => {
      const response = await call(admin, 'POST', `/orgs/${org}/email-identities`, {
        email: 'it@corp.test',
        display_name: 'IT',
        transport: 'smtp',
        smtp: smtpBody(),
      });
      expect(response.statusCode).toBe(201);
      expect(response.body).not.toContain(SMTP_PASSWORD);
      const created = emailIdentityMutationSchema.parse(response.json());
      expect(created.identity).toMatchObject({
        transport: 'smtp',
        mode: 'send_as',
        status: 'pending',
        smtp: {
          host: '127.0.0.1',
          port: identitySmtp.port,
          security: 'none',
          username: SMTP_USER,
          password_set: true,
        },
        hints: ['spf_dkim_alignment', 'basic_auth_restricted', 'insecure_connection'],
      });
      expect(created.verification).toMatchObject({ status: 'sent', to: 'it@corp.test' });
      // From the identity to itself, logged in with its own account.
      const mail = lastMailTo(identitySmtp.messages, 'it@corp.test');
      expect(mail).toMatchObject({ from: 'it@corp.test', user: SMTP_USER });
      const { code } = secretsOf(mail.raw);
      const id = created.identity.id;
      const verified = await call(admin, 'POST', `/email-identities/${id}/verify-code`, { code });
      expect(emailIdentitySchema.parse(verified.json())).toMatchObject({
        status: 'verified',
        mode: 'send_as',
      });

      // A second identity with the same password: another ciphertext.
      const second = await call(admin, 'POST', `/orgs/${org}/email-identities`, {
        email: 'it-team@corp.test',
        display_name: 'IT team',
        transport: 'smtp',
        smtp: smtpBody(),
      });
      expect(second.statusCode).toBe(201);
      const sealed = await db.kysely
        .selectFrom('meta.email_identities')
        .select('smtp_password_enc')
        .where('email', 'in', ['it@corp.test', 'it-team@corp.test'])
        .execute();
      expect(sealed).toHaveLength(2);
      expect(sealed[0]?.smtp_password_enc).not.toBe(sealed[1]?.smtp_password_enc);
      expect(JSON.stringify(sealed)).not.toContain(SMTP_PASSWORD);

      // Re-entering the same password changes nothing; a new one asks for verification again.
      const same = await call(admin, 'PATCH', `/email-identities/${id}`, { smtp: smtpBody() });
      expect(emailIdentityMutationSchema.parse(same.json())).toMatchObject({
        identity: { status: 'verified' },
        verification: null,
      });
      identitySmtp.password.value = NEW_SMTP_PASSWORD;
      const rotated = await call(admin, 'PATCH', `/email-identities/${id}`, {
        smtp: smtpBody({ password: NEW_SMTP_PASSWORD }),
      });
      expect(rotated.body).not.toContain(NEW_SMTP_PASSWORD);
      expect(emailIdentityMutationSchema.parse(rotated.json())).toMatchObject({
        identity: { status: 'pending', verified_at: null },
        verification: { status: 'sent' },
      });
      const credentials = (await auditOf(id)).find(
        (entry) => entry.action === 'email_identity.credentials_changed',
      );
      expect(credentials?.after).toMatchObject({ password_changed: true });

      // Neither the responses, the audit, the events nor the logs ever hold a password.
      const everything = JSON.stringify([
        await auditOf(id),
        await db.kysely
          .selectFrom('meta.events')
          .select('payload')
          .where('entity_id', '=', id)
          .execute(),
        (await call(admin, 'GET', `/orgs/${org}/email-identities`)).body,
      ]);
      for (const secret of [SMTP_PASSWORD, NEW_SMTP_PASSWORD]) {
        expect(everything).not.toContain(secret);
        expect(app.logs.raw()).not.toContain(secret);
      }
    });

    it('reports a wrong password as an authentication failure (535), not verified', async () => {
      const response = await call(admin, 'POST', `/orgs/${org}/email-identities`, {
        email: 'helpdesk@corp.test',
        display_name: 'Helpdesk',
        transport: 'smtp',
        smtp: smtpBody({ password: 'not-the-password' }),
      });
      expect(response.statusCode).toBe(201);
      const created = emailIdentityMutationSchema.parse(response.json());
      expect(created.identity.status).toBe('pending');
      expect(created.verification).toEqual({
        status: 'failed',
        step: 'auth',
        code: 'smtp_rejected',
        reason: 'auth_failed',
        smtp: { code: 535, enhanced: null },
      });
      expect(created.identity.verification.pending).toBe(false);
      const again = await call(
        admin,
        'POST',
        `/email-identities/${created.identity.id}/test-and-verify`,
      );
      expect(emailVerificationOutcomeSchema.parse(again.json())).toMatchObject({
        status: 'failed',
        step: 'auth',
        reason: 'auth_failed',
      });
      expect(app.logs.raw()).not.toContain('not-the-password');
    });

    it('validates ports, TLS confirmation and the SMTP fields', async () => {
      const post = (body: object) =>
        call(admin, 'POST', `/orgs/${org}/email-identities`, {
          email: 'val@corp.test',
          display_name: 'V',
          transport: 'smtp',
          ...body,
        });
      expectProblem(await post({ smtp: smtpBody({ port: 2526 }) }), 422, 'VALIDATION_FAILED');
      expectProblem(
        await post({ smtp: smtpBody({ allow_insecure: undefined }) }),
        422,
        'VALIDATION_FAILED',
        'INSECURE_NOT_CONFIRMED',
      );
      expectProblem(await post({}), 422, 'VALIDATION_FAILED', 'SMTP_REQUIRED');
      expectProblem(
        await post({ smtp: smtpBody({ password: undefined }) }),
        422,
        'VALIDATION_FAILED',
        'PASSWORD_REQUIRED',
      );
      expectProblem(
        await post({ transport: 'system', smtp: smtpBody() }),
        422,
        'VALIDATION_FAILED',
        'SMTP_NOT_ALLOWED',
      );
      expectProblem(
        await post({ smtp: smtpBody({ host: 'smtp://mail.corp.test' }) }),
        422,
        'VALIDATION_FAILED',
        'INVALID_FORMAT',
      );
      expectProblem(
        await post({ transport: 'system', email: 'not an address' }),
        422,
        'VALIDATION_FAILED',
        'INVALID_EMAIL',
      );
      expectProblem(
        await post({ transport: 'system', email: 'hr-corp@gmail.com' }),
        422,
        'VALIDATION_FAILED',
        'EMAIL_TAKEN',
      );
      expectProblem(
        await post({
          transport: 'system',
          base_scope: 'selected',
          base_ids: ['bse_0000000000000000'],
        }),
        422,
        'VALIDATION_FAILED',
        'UNKNOWN_BASE',
      );
    });

    it('refuses internal hosts unless SMTP_ALLOW_PRIVATE_HOSTS, and metadata always', async () => {
      for (const host of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '[::1]', 'localhost']) {
        expectProblem(
          await call(
            admin,
            'POST',
            `/orgs/${org}/email-identities`,
            {
              email: 'ssrf@corp.test',
              display_name: 'S',
              transport: 'smtp',
              smtp: smtpBody({ host }),
            },
            guardedApp,
          ),
          422,
          'VALIDATION_FAILED',
          'HOST_NOT_ALLOWED',
        );
      }
      expectProblem(
        await call(admin, 'POST', `/orgs/${org}/email-identities`, {
          email: 'meta@corp.test',
          display_name: 'M',
          transport: 'smtp',
          smtp: smtpBody({ host: '169.254.169.254' }),
        }),
        422,
        'VALIDATION_FAILED',
        'HOST_NOT_ALLOWED',
      );
      // Saved while allowed, then the instance forbids private hosts: refused at connect.
      const saved = emailIdentityMutationSchema.parse(
        (
          await call(admin, 'POST', `/orgs/${org}/email-identities`, {
            email: 'lan@corp.test',
            display_name: 'LAN',
            transport: 'smtp',
            smtp: smtpBody(),
          })
        ).json(),
      );
      const blocked = await call(
        admin,
        'POST',
        `/email-identities/${saved.identity.id}/test-and-verify`,
        undefined,
        guardedApp,
      );
      expect(emailVerificationOutcomeSchema.parse(blocked.json())).toMatchObject({
        status: 'failed',
        step: 'connect',
        code: 'smtp_rejected',
        reason: 'host_not_allowed',
      });
    });
  });

  describe('scope, disable, delete', () => {
    let identities: EmailIdentityDto[];

    beforeAll(async () => {
      identities = emailIdentityListSchema.parse(
        (await call(admin, 'GET', `/orgs/${org}/email-identities`)).json(),
      ).items;
    });

    it('lists verified identities in scope to automation managers of a base, without SMTP settings', async () => {
      const verified = identities.filter((item) => item.status === 'verified');
      expect(verified.length).toBeGreaterThan(0);
      const inA = baseEmailIdentityListSchema.parse(
        (await call(baseAdmin, 'GET', `/bases/${baseA}/email-identities`)).json(),
      );
      const inB = baseEmailIdentityListSchema.parse(
        (await call(baseAdmin, 'GET', `/bases/${baseB}/email-identities`)).json(),
      );
      const expected = (baseId: Id<'bse'>) =>
        verified
          .filter((item) => item.base_scope === 'all' || item.base_ids.includes(baseId))
          .map((item) => ({
            id: item.id,
            email: item.email,
            display_name: item.display_name,
            mode: item.mode,
          }))
          .sort((x, y) => x.email.localeCompare(y.email));
      expect(inA.items).toEqual(expected(baseA));
      expect(inB.items).toEqual(expected(baseB));
      for (const item of inA.items)
        expect(Object.keys(item).sort()).toEqual(['display_name', 'email', 'id', 'mode']);

      // A base reader does not manage automations; strangers do not see the base.
      expectProblem(
        await call(reader, 'GET', `/bases/${baseA}/email-identities`),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(stranger, 'GET', `/bases/${baseA}/email-identities`),
        404,
        'NOT_FOUND',
      );
    });

    it('disables without losing the verification, enables back, deletes', async () => {
      const target = identities.find(
        (item) => item.status === 'verified' && item.base_scope === 'all',
      );
      if (target === undefined) throw new Error('no verified identity');
      const disabled = await call(admin, 'POST', `/email-identities/${target.id}/disable`);
      expect(emailIdentitySchema.parse(disabled.json()).status).toBe('disabled');
      const listed = baseEmailIdentityListSchema.parse(
        (await call(baseAdmin, 'GET', `/bases/${baseA}/email-identities`)).json(),
      );
      expect(listed.items.map((item) => item.id)).not.toContain(target.id);
      const enabled = await call(admin, 'POST', `/email-identities/${target.id}/enable`);
      expect(emailIdentitySchema.parse(enabled.json()).status).toBe('verified');

      expect((await call(admin, 'DELETE', `/email-identities/${target.id}`)).statusCode).toBe(204);
      expectProblem(await call(admin, 'GET', `/email-identities/${target.id}`), 404, 'NOT_FOUND');
      const actions = (await auditOf(target.id)).map((entry) => entry.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'email_identity.disabled',
          'email_identity.enabled',
          'email_identity.deleted',
        ]),
      );
    });
  });

  describe('display name rule (T540, QA S5 M7)', () => {
    const REFUSED = [
      ['PayPal <a@b>', 'angle_bracket'],
      ['Support > HR', 'angle_bracket'],
      ['hr@corp', 'at_sign'],
      ['hr＠corp', 'at_sign'],
      ['HR‮TI', 'control_char'],
      ['HR\nBcc: evil@attacker.test', 'control_char'],
      ['HR⁦x', 'control_char'],
      ['https://x', 'url'],
      ['Bank www.example', 'url'],
      ['x.com', 'url'],
      ['xn--bcher-kva.de', 'url'],
      ['bücher.de', 'url'],
    ] as const;

    function expectDisplayNameRefused(response: LightMyRequestResponse, reason: string): void {
      expect(response.statusCode).toBe(422);
      const problem = problemOf(response.body) as { code?: string; errors?: unknown[] };
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors).toEqual([
        {
          path: 'display_name',
          code: 'DISPLAY_NAME_NOT_ALLOWED',
          message: expect.any(String) as unknown,
          params: { reason },
        },
      ]);
    }

    async function storedIdentity(id: Id<'eid'>) {
      return db.kysely
        .selectFrom('meta.email_identities')
        .select(['display_name', 'status', 'signature_md'])
        .where('organization_id', '=', org)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    }

    async function setStoredName(id: Id<'eid'>, name: string): Promise<void> {
      await db.kysely
        .updateTable('meta.email_identities')
        .set({ display_name: name })
        .where('organization_id', '=', org)
        .where('id', '=', id)
        .execute();
    }

    it('refuses @, < >, control characters and URLs on create with the reason, saving and sending nothing', async () => {
      const mailsBefore = instance.messages.length;
      for (const [index, [name, reason]] of REFUSED.entries()) {
        const email = `t540-create-${String(index)}@corp.test`;
        for (const user of [owner, admin]) {
          expectDisplayNameRefused(
            await call(user, 'POST', `/orgs/${org}/email-identities`, {
              email,
              display_name: name,
              transport: 'system',
            }),
            reason,
          );
        }
        const rows = await db.kysely
          .selectFrom('meta.email_identities')
          .select('id')
          .where('organization_id', '=', org)
          .where('email', '=', email)
          .execute();
        expect(rows).toEqual([]);
      }
      expect(instance.messages.length).toBe(mailsBefore);
    });

    it('refuses them on PATCH too, leaving the identity unchanged; ordinary names save', async () => {
      const created = await createSystem('t540-patch@corp.test');
      const id = created.identity.id;
      expect(created.identity.display_name_issue).toBeNull();
      for (const [name, reason] of REFUSED) {
        expectDisplayNameRefused(
          await call(admin, 'PATCH', `/email-identities/${id}`, {
            display_name: name,
            signature_md: 'Không được lưu',
          }),
          reason,
        );
      }
      expect(await storedIdentity(id)).toMatchObject({
        display_name: 'Phòng Nhân sự',
        signature_md: null,
      });
      expect((await auditOf(id)).map((entry) => entry.action)).not.toContain(
        'email_identity.updated',
      );

      for (const name of ['Nhân sự (HN)', 'Dept. IT', 'Phòng Kế toán.', 'Phòng IT', 'R&D 2.0']) {
        const response = await call(admin, 'PATCH', `/email-identities/${id}`, {
          display_name: name,
        });
        expect(response.statusCode, name).toBe(200);
        // Accepted, then stored as before: white space (the no-break space too) collapses.
        expect(emailIdentityMutationSchema.parse(response.json()).identity).toMatchObject({
          display_name: name.replace(/\s/gu, ' '),
          display_name_issue: null,
        });
      }
    });

    it('flags names saved before the rule on read, never rewrites them, and still saves a PATCH without display_name', async () => {
      const legacyNames = [
        ['Bank <a@evil.com> https://x', 'angle_bracket'],
        ['hr@corp', 'at_sign'],
        ['HR‮TI', 'control_char'],
        ['paypal.com', 'url'],
      ] as const;
      for (const [index, [legacy, reason]] of legacyNames.entries()) {
        const created = await createSystem(`t540-legacy-${String(index)}@corp.test`);
        const id = created.identity.id;
        await setStoredName(id, legacy);

        const read = emailIdentitySchema.parse(
          (await call(admin, 'GET', `/email-identities/${id}`)).json(),
        );
        expect(read).toMatchObject({ display_name: legacy, display_name_issue: reason });
        const list = emailIdentityListSchema.parse(
          (await call(owner, 'GET', `/orgs/${org}/email-identities`)).json(),
        );
        expect(list.items.find((item) => item.id === id)).toMatchObject({
          display_name: legacy,
          display_name_issue: reason,
        });

        // A change that does not name display_name keeps the legacy name.
        const signed = await call(admin, 'PATCH', `/email-identities/${id}`, {
          signature_md: 'Trân trọng',
          reply_to: 'jobs@corp.test',
        });
        expect(signed.statusCode).toBe(200);
        const signedIdentity = emailIdentityMutationSchema.parse(signed.json()).identity;
        expect(signedIdentity).toMatchObject({
          display_name: legacy,
          display_name_issue: reason,
          signature_md: 'Trân trọng',
          reply_to: 'jobs@corp.test',
        });
        expect(await storedIdentity(id)).toMatchObject({
          display_name: legacy,
          signature_md: 'Trân trọng',
        });

        // Repeating the legacy name is a new save: refused like any other.
        expectDisplayNameRefused(
          await call(admin, 'PATCH', `/email-identities/${id}`, { display_name: legacy }),
          reason,
        );

        // The organization admin fixes it: the flag clears.
        const fixed = await call(admin, 'PATCH', `/email-identities/${id}`, {
          display_name: 'Phòng Nhân sự',
        });
        expect(fixed.statusCode).toBe(200);
        expect(emailIdentityMutationSchema.parse(fixed.json()).identity).toMatchObject({
          display_name: 'Phòng Nhân sự',
          display_name_issue: null,
        });
      }
    });

    it('keeps tenants apart: a flagged identity of another organization is not found', async () => {
      const created = await createSystem('t540-tenant@corp.test');
      const id = created.identity.id;
      await setStoredName(id, 'Bank <a@evil.com>');
      expectProblem(await call(stranger, 'GET', `/email-identities/${id}`), 404, 'NOT_FOUND');
      expectProblem(
        await call(stranger, 'PATCH', `/email-identities/${id}`, { signature_md: 'x' }),
        404,
        'NOT_FOUND',
      );
      // The body is checked before the identity is looked up: the same answer
      // whether it exists or not, so the rule says nothing about other tenants.
      for (const target of [id, 'eid_A1b2C3d4E5f6G7h8']) {
        expectDisplayNameRefused(
          await call(stranger, 'PATCH', `/email-identities/${target}`, { display_name: 'a@b' }),
          'at_sign',
        );
      }
      const theirs = emailIdentityListSchema.parse(
        (await call(stranger, 'GET', `/orgs/${otherOrg}/email-identities`)).json(),
      );
      expect(theirs.items.map((item) => item.id)).not.toContain(id);
      expect(await storedIdentity(id)).toMatchObject({ display_name: 'Bank <a@evil.com>' });
    });
  });

  describe('verification email headers (T528, QA S5 M7)', () => {
    const SPOOF = 'Bank <a@evil.com> https://x';

    /** The header block of a raw message, unfolded and with RFC 2047 words decoded. */
    function headBlock(raw: string): string {
      const head = (raw.split(/\r?\n\r?\n/)[0] ?? '').replace(/\r?\n[ \t]+/g, ' ');
      return decodeHeader(head);
    }

    function expectNoSpoof(raw: string): void {
      const head = headBlock(raw);
      for (const fragment of ['Bank', 'evil', 'https://x', '(qua Cellhive)', '(via Cellhive)']) {
        expect(head).not.toContain(fragment);
      }
    }

    it('never puts an unverified display name in From/Reply-To, whatever the transport and mode', async () => {
      // Its own organization: the daily verification limit of `org` is shared by the tests above.
      const spoofOrg = await seedOrg(db, 'Spoof check');
      const spoofOwner = await seedUser(db, { memberships: [{ orgId: spoofOrg, role: 'owner' }] });
      // Since T540 such a name is refused on save; rows saved before the rule
      // keep it (written here straight into the table), and their
      // verification emails must still not carry it.
      expectProblem(
        await call(spoofOwner, 'POST', `/orgs/${spoofOrg}/email-identities`, {
          email: 'refused@corp.test',
          display_name: SPOOF,
          transport: 'system',
        }),
        422,
        'VALIDATION_FAILED',
        'DISPLAY_NAME_NOT_ALLOWED',
      );
      const create = async (body: object) => {
        const response = await call(spoofOwner, 'POST', `/orgs/${spoofOrg}/email-identities`, {
          display_name: 'Phòng Nhân sự',
          ...body,
        });
        expect(response.statusCode).toBe(201);
        const created = emailIdentityMutationSchema.parse(response.json());
        expect(created.verification).toMatchObject({ status: 'sent' });
        await db.kysely
          .updateTable('meta.email_identities')
          .set({ display_name: SPOOF })
          .where('organization_id', '=', spoofOrg)
          .where('id', '=', created.identity.id)
          .execute();
        const again = await call(
          spoofOwner,
          'POST',
          `/email-identities/${created.identity.id}/send-verification`,
        );
        expect(again.statusCode).toBe(200);
        expect(emailVerificationOutcomeSchema.parse(again.json())).toMatchObject({
          status: 'sent',
        });
        return created;
      };

      // system, send_as (allowed domain) and on_behalf (other domain): the instance sender.
      for (const email of ['spoof@corp.test', 'spoof-hr@gmail.com']) {
        await create({ email, transport: 'system', reply_to: 'reply@evil.com' });
        const mail = lastMailTo(instance.messages, email);
        expect(decodeHeader(headerOf(mail.raw, 'From'))).toBe('Cellhive <noreply@cellhive.test>');
        expect(headerOf(mail.raw, 'Reply-To')).toBeNull();
        expectNoSpoof(mail.raw);
      }

      // smtp: from the identity's own mailbox, its plain address only.
      await create({
        email: 'spoof-it@corp.test',
        transport: 'smtp',
        smtp: smtpBody({ password: identitySmtp.password.value }),
      });
      const own = identitySmtp.messages.findLast((item) => item.to.includes('spoof-it@corp.test'));
      if (own === undefined) throw new Error('no email to spoof-it@corp.test');
      expect(own.from).toBe('spoof-it@corp.test');
      expect(headerOf(own.raw, 'From')).toBe('spoof-it@corp.test');
      expect(headerOf(own.raw, 'Reply-To')).toBeNull();
      expectNoSpoof(own.raw);
    });
  });
});
