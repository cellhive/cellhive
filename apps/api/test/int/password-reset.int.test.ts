import { passwordResetLinkSchema, type Id } from '@cellhive/contracts';
import { PasswordResetLinks, PasswordResetsRepository, type Db } from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Browser,
  decodeQuotedPrintable,
  PASSWORD,
  seedOrg,
  seedUser,
  startSmtpCapture,
  uniqueIp,
  waitFor,
  type SeededUser,
  type SmtpCapture,
} from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  captureLogger,
  problemOf,
  startTestApp,
  TEST_PUBLIC_URL,
  type TestApp,
} from './support.js';

const NEW_PASSWORD = 'Brand-New-Secret-2026';
const RESET_URL = new RegExp(`^${TEST_PUBLIC_URL}/reset/([A-Za-z0-9_-]{43})$`);

/** Polls an async condition (jobs run in the worker). */
async function eventually(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('eventually: timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('password reset (SPEC §14.2, CONTRACTS §12.1)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let orgA: Id<'org'>;
  let orgB: Id<'org'>;
  /** Owner of A. */
  let owner: SeededUser;
  /** Admin of A. */
  let admin: SeededUser;
  /** Plain member of A only: the only kind of user an admin may reset. */
  let member: SeededUser;
  /** Member of A and of B. */
  let twoOrgs: SeededUser;
  /** Member of A, owner of B. */
  let ownerOfB: SeededUser;
  /** Admin of B only. */
  let adminOfB: SeededUser;
  /** Member of A signing in through OIDC (no password). */
  let external: SeededUser;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    orgA = await seedOrg(db, 'Alpha');
    orgB = await seedOrg(db, 'Beta');
    owner = await seedUser(db, { memberships: [{ orgId: orgA, role: 'owner' }] });
    admin = await seedUser(db, { memberships: [{ orgId: orgA, role: 'admin' }] });
    member = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
    twoOrgs = await seedUser(db, {
      memberships: [
        { orgId: orgA, role: 'member' },
        { orgId: orgB, role: 'member' },
      ],
    });
    ownerOfB = await seedUser(db, {
      memberships: [
        { orgId: orgA, role: 'member' },
        { orgId: orgB, role: 'owner' },
      ],
    });
    adminOfB = await seedUser(db, { memberships: [{ orgId: orgB, role: 'admin' }] });
    external = await seedUser(db, {
      password: null,
      memberships: [{ orgId: orgA, role: 'member' }],
    });
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  async function signedIn(user: SeededUser, app: TestApp = t): Promise<Browser> {
    const browser = new Browser(app.app);
    expect((await browser.login(user.email)).statusCode).toBe(204);
    return browser;
  }

  function resetLink(browser: Browser, orgId: string, userId: string) {
    return browser.request({
      method: 'POST',
      url: `/api/v1/orgs/${orgId}/members/${userId}/password-reset`,
    });
  }

  function redeem(token: string, password: string, app: TestApp = t) {
    return app.app.inject({
      method: 'POST',
      url: `/api/v1/auth/password-reset/${token}`,
      payload: { password },
      remoteAddress: uniqueIp(),
    });
  }

  function tokenOf(url: string): string {
    const match = RESET_URL.exec(url);
    if (match?.[1] === undefined) throw new Error(`not a reset URL: ${url}`);
    return match[1];
  }

  /** A link as the CLI creates it (`cellhive user reset-password`), or forgot-password. */
  async function cliLink(
    userId: Id<'usr'>,
    source: 'cli' | 'self_service' = 'cli',
  ): Promise<string> {
    const link = await db.withTx((tx) =>
      new PasswordResetLinks(new PasswordResetsRepository(db), TEST_PUBLIC_URL).create(tx, userId, {
        source,
      }),
    );
    return tokenOf(link.url);
  }

  describe('admin link', () => {
    it('lets an admin create a one-time 24 h link for a member of this org only', async () => {
      const browser = await signedIn(admin);
      const response = await resetLink(browser, orgA, member.id);
      expect(response.statusCode).toBe(201);
      const link = passwordResetLinkSchema.parse(response.json());
      expect(link.reset_url).toMatch(RESET_URL);
      const hours = (Date.parse(link.expires_at) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThanOrEqual(24);

      const rows = await db.kysely
        .selectFrom('meta.password_resets')
        .selectAll()
        .where('user_id', '=', member.id)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ created_by: admin.id, source: 'admin' });
      expect(rows[0]?.token_hash).not.toBe(tokenOf(link.reset_url));

      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .selectAll()
        .where('action', '=', 'auth.password_reset_requested')
        .where('entity_id', '=', member.id)
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({ organization_id: orgA, actor_id: admin.id });
      // Neither the link nor the token is logged or audited.
      expect(JSON.stringify(audit)).not.toContain(tokenOf(link.reset_url));
      expect(t.logs.raw()).not.toContain(tokenOf(link.reset_url));
    });

    it('lets the owner do it too', async () => {
      const browser = await signedIn(owner);
      expect((await resetLink(browser, orgA, member.id)).statusCode).toBe(201);
    });

    it('403 for a member who also belongs to another org', async () => {
      const response = await resetLink(await signedIn(admin), orgA, twoOrgs.id);
      expect(response.statusCode).toBe(403);
      expect(problemOf(response.body).code).toBe('PERMISSION_DENIED');
    });

    it('403 for a member who owns another org, and for an owner of this org', async () => {
      const browser = await signedIn(admin);
      const ownsB = await resetLink(browser, orgA, ownerOfB.id);
      expect(ownsB.statusCode).toBe(403);
      expect(problemOf(ownsB.body).code).toBe('PERMISSION_DENIED');
      const ownsA = await resetLink(browser, orgA, owner.id);
      expect(ownsA.statusCode).toBe(403);
    });

    it('403 for a plain member caller', async () => {
      const response = await resetLink(await signedIn(member), orgA, twoOrgs.id);
      expect(response.statusCode).toBe(403);
      expect(problemOf(response.body).code).toBe('PERMISSION_DENIED');
    });

    it('404 for an admin of another org (cannot see org A) and for a non-member target', async () => {
      const outsider = await resetLink(await signedIn(adminOfB), orgA, member.id);
      expect(outsider.statusCode).toBe(404);
      expect(problemOf(outsider.body).code).toBe('NOT_FOUND');
      const notMember = await resetLink(await signedIn(admin), orgA, adminOfB.id);
      expect(notMember.statusCode).toBe(404);
    });

    it('422 for a user without a password (external sign-in)', async () => {
      const response = await resetLink(await signedIn(admin), orgA, external.id);
      expect(response.statusCode).toBe(422);
      expect(problemOf(response.body).code).toBe('VALIDATION_FAILED');
    });

    it('401 without a session, 403 CSRF_INVALID without the token', async () => {
      const anonymous = await t.app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgA}/members/${member.id}/password-reset`,
      });
      expect(anonymous.statusCode).toBe(401);
      const browser = await signedIn(admin);
      const noCsrf = await browser.request({
        method: 'POST',
        url: `/api/v1/orgs/${orgA}/members/${member.id}/password-reset`,
        csrf: false,
      });
      expect(noCsrf.statusCode).toBe(403);
      expect(problemOf(noCsrf.body).code).toBe('CSRF_INVALID');
    });
  });

  describe('redeeming a link', () => {
    it('sets the password, revokes every session, unlocks the account; the link works once', async () => {
      const target = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      const session1 = await signedIn(target);
      const session2 = await signedIn(target);
      // Lock the account: 10 failures.
      for (let i = 0; i < 10; i += 1) {
        await new Browser(t.app).login(target.email, `Wrong-${String(i)}-password`);
      }
      expect((await new Browser(t.app).login(target.email)).statusCode).toBe(423);

      const link = (await resetLink(await signedIn(admin), orgA, target.id)).json<{
        reset_url: string;
      }>();
      const token = tokenOf(link.reset_url);

      // A weak password is refused without consuming the link.
      const weak = await redeem(token, 'password123');
      expect(weak.statusCode).toBe(422);
      expect(problemOf(weak.body)).toMatchObject({
        errors: [expect.objectContaining({ path: 'password', code: 'PASSWORD_TOO_COMMON' })],
      });

      const ok = await redeem(token, NEW_PASSWORD);
      expect(ok.statusCode).toBe(204);

      for (const browser of [session1, session2]) {
        expect((await browser.request({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
      }
      const sessions = await db.kysely
        .selectFrom('meta.sessions')
        .select('id')
        .where('user_id', '=', target.id)
        .execute();
      expect(sessions).toHaveLength(0);

      // Unlocked, and only the new password works.
      expect((await new Browser(t.app).login(target.email, PASSWORD)).statusCode).toBe(401);
      expect((await new Browser(t.app).login(target.email, NEW_PASSWORD)).statusCode).toBe(204);

      const reuse = await redeem(token, 'Another-Password-77');
      expect(reuse.statusCode).toBe(410);
      expect(problemOf(reuse.body).code).toBe('RESET_TOKEN_INVALID');

      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .selectAll()
        .where('action', '=', 'auth.password_reset')
        .where('entity_id', '=', target.id)
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({ organization_id: orgA, actor_id: target.id });
      expect(audit.after).toMatchObject({ revoked_sessions: 2 });
      const revokedAudit = await db.kysely
        .selectFrom('meta.audit_logs')
        .selectAll()
        .where('action', '=', 'auth.session_revoked')
        .where('entity_id', '=', target.id)
        .execute();
      expect(revokedAudit).toHaveLength(1);
      expect(revokedAudit[0]).toMatchObject({
        organization_id: orgA,
        actor_id: target.id,
        entity_type: 'user',
        after: { reason: 'password_reset', revoked_sessions: 2 },
      });
    });

    it('410 RESET_TOKEN_INVALID for unknown, malformed and expired tokens', async () => {
      expect((await redeem('A'.repeat(43), NEW_PASSWORD)).statusCode).toBe(410);
      expect((await redeem('short', NEW_PASSWORD)).statusCode).toBe(410);

      const link = (await resetLink(await signedIn(admin), orgA, member.id)).json<{
        reset_url: string;
      }>();
      await db.kysely
        .updateTable('meta.password_resets')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('user_id', '=', member.id)
        .where('used_at', 'is', null)
        .execute();
      const expired = await redeem(tokenOf(link.reset_url), NEW_PASSWORD);
      expect(expired.statusCode).toBe(410);
      expect(problemOf(expired.body).code).toBe('RESET_TOKEN_INVALID');
    });

    it('a newer link replaces an older unused one', async () => {
      const browser = await signedIn(admin);
      const first = (await resetLink(browser, orgA, member.id)).json<{ reset_url: string }>();
      const second = (await resetLink(browser, orgA, member.id)).json<{ reset_url: string }>();
      expect((await redeem(tokenOf(first.reset_url), NEW_PASSWORD)).statusCode).toBe(410);
      expect((await redeem(tokenOf(second.reset_url), NEW_PASSWORD)).statusCode).toBe(204);
    });

    it('audits auth.session_revoked only when sessions were revoked', async () => {
      const target = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      const link = (await resetLink(await signedIn(admin), orgA, target.id)).json<{
        reset_url: string;
      }>();
      expect((await redeem(tokenOf(link.reset_url), NEW_PASSWORD)).statusCode).toBe(204);
      const entries = await db.kysely
        .selectFrom('meta.audit_logs')
        .select('id')
        .where('action', '=', 'auth.session_revoked')
        .where('entity_id', '=', target.id)
        .execute();
      expect(entries).toEqual([]);
    });
  });

  describe('admin links are re-checked on redemption', () => {
    async function issued(issuer: SeededUser, target: SeededUser): Promise<string> {
      const response = await resetLink(await signedIn(issuer), orgA, target.id);
      expect(response.statusCode).toBe(201);
      return tokenOf(passwordResetLinkSchema.parse(response.json()).reset_url);
    }

    function setRole(orgId: Id<'org'>, userId: Id<'usr'>, role: 'owner' | 'admin' | 'member') {
      return db.kysely
        .updateTable('meta.org_members')
        .set({ role })
        .where('organization_id', '=', orgId)
        .where('user_id', '=', userId)
        .execute();
    }

    async function expectInvalid(token: string): Promise<void> {
      const response = await redeem(token, NEW_PASSWORD);
      expect(response.statusCode).toBe(410);
      expect(problemOf(response.body).code).toBe('RESET_TOKEN_INVALID');
    }

    it('410 once the target joined another organization; works again after leaving it', async () => {
      const target = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      const token = await issued(admin, target);
      await db.kysely
        .insertInto('meta.org_members')
        .values({ organization_id: orgB, user_id: target.id, role: 'member' })
        .execute();
      await expectInvalid(token);
      // The link was not consumed: once the condition holds again it works.
      await db.kysely
        .deleteFrom('meta.org_members')
        .where('organization_id', '=', orgB)
        .where('user_id', '=', target.id)
        .execute();
      expect((await redeem(token, NEW_PASSWORD)).statusCode).toBe(204);
    });

    it('410 once the target became an owner', async () => {
      const target = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      const token = await issued(admin, target);
      await setRole(orgA, target.id, 'owner');
      await expectInvalid(token);
      expect((await new Browser(t.app).login(target.email, PASSWORD)).statusCode).toBe(204);
    });

    it('410 once the issuer was demoted or removed', async () => {
      const issuer = await seedUser(db, { memberships: [{ orgId: orgA, role: 'admin' }] });
      const target = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      const token = await issued(issuer, target);
      await setRole(orgA, issuer.id, 'member');
      await expectInvalid(token);

      await setRole(orgA, issuer.id, 'admin');
      const owners = await signedIn(owner);
      const removed = await owners.request({
        method: 'DELETE',
        url: `/api/v1/orgs/${orgA}/members/${issuer.id}`,
      });
      expect(removed.statusCode).toBe(204);
      await expectInvalid(token);
      expect((await new Browser(t.app).login(target.email, PASSWORD)).statusCode).toBe(204);
    });
  });

  describe('link sources', () => {
    it('CLI links skip the admin re-check (owners, several organizations)', async () => {
      const target = await seedUser(db, {
        memberships: [
          { orgId: orgA, role: 'member' },
          { orgId: orgB, role: 'owner' },
        ],
      });
      const token = await cliLink(target.id);
      expect((await redeem(token, NEW_PASSWORD)).statusCode).toBe(204);
      expect((await new Browser(t.app).login(target.email, NEW_PASSWORD)).statusCode).toBe(204);
    });

    it('CLI links: 410 when the account is no longer active', async () => {
      const target = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      const token = await cliLink(target.id);
      await db.kysely
        .updateTable('meta.users')
        .set({ status: 'disabled' })
        .where('id', '=', target.id)
        .execute();
      const response = await redeem(token, NEW_PASSWORD);
      expect(response.statusCode).toBe(410);
      expect(problemOf(response.body).code).toBe('RESET_TOKEN_INVALID');
    });

    it('every link: 410 once the account is no longer active, and the link is not used up', async () => {
      const disable = (id: Id<'usr'>, status: 'active' | 'disabled') =>
        db.kysely.updateTable('meta.users').set({ status }).where('id', '=', id).execute();
      const target = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      // A forgot-password link mailed while the account was active.
      const selfService = await cliLink(target.id, 'self_service');
      await disable(target.id, 'disabled');
      const response = await redeem(selfService, NEW_PASSWORD);
      expect(response.statusCode).toBe(410);
      expect(problemOf(response.body).code).toBe('RESET_TOKEN_INVALID');
      // An admin link too (issued while active).
      await disable(target.id, 'active');
      const admins = await signedIn(admin);
      const issued = await resetLink(admins, orgA, target.id);
      expect(issued.statusCode).toBe(201);
      const adminToken = tokenOf(passwordResetLinkSchema.parse(issued.json()).reset_url);
      await disable(target.id, 'disabled');
      expect((await redeem(adminToken, NEW_PASSWORD)).statusCode).toBe(410);
      // The password never changed; once active again the unused link works.
      await disable(target.id, 'active');
      expect((await new Browser(t.app).login(target.email, PASSWORD)).statusCode).toBe(204);
      expect((await redeem(adminToken, NEW_PASSWORD)).statusCode).toBe(204);
    });

    it('an admin link stops working once its issuer is deleted (created_by set to NULL)', async () => {
      const issuer = await seedUser(db, { memberships: [{ orgId: orgA, role: 'admin' }] });
      const target = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      const response = await resetLink(await signedIn(issuer), orgA, target.id);
      const token = tokenOf(passwordResetLinkSchema.parse(response.json()).reset_url);
      await db.kysely.deleteFrom('meta.sessions').where('user_id', '=', issuer.id).execute();
      await db.kysely.deleteFrom('meta.users').where('id', '=', issuer.id).execute();
      const row = await db.kysely
        .selectFrom('meta.password_resets')
        .select(['source', 'created_by'])
        .where('user_id', '=', target.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ source: 'admin', created_by: null });
      expect((await redeem(token, NEW_PASSWORD)).statusCode).toBe(410);
    });
  });

  describe('forgot password', () => {
    let smtp: SmtpCapture;
    let mailApp: TestApp;
    let mailWorker: WorkerHandle | undefined;

    beforeAll(async () => {
      smtp = await startSmtpCapture();
      mailApp = await startTestApp({
        DATABASE_URL: database.url,
        SMTP_URL: smtp.url,
        SMTP_ALLOW_INSECURE: 'true',
        SMTP_FROM: 'Cellhive <no-reply@cellhive.test>',
      });
    });

    afterAll(async () => {
      await mailWorker?.close();
      await mailApp.close();
      await smtp.close();
    });

    function forgot(app: TestApp, email: string, ip = uniqueIp()) {
      return app.app.inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        payload: { email },
        remoteAddress: ip,
      });
    }

    async function pendingEmailJobs(): Promise<number> {
      const { rows } = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM graphile_worker.jobs
         WHERE task_identifier = 'auth.password_reset_email'
      `.execute(db.kysely);
      return Number(rows[0]?.count ?? '0');
    }

    /** Runs the queued `auth.password_reset_email` jobs with the worker of `app`'s config. */
    async function drain(app: TestApp): Promise<void> {
      if (app === mailApp) {
        mailWorker ??= await createWorker(mailApp.config, {
          logger: captureLogger().logger,
          pollIntervalMs: 100,
        });
        await eventually(async () => (await pendingEmailJobs()) === 0);
        return;
      }
      const worker = await createWorker(app.config, {
        logger: captureLogger().logger,
        pollIntervalMs: 100,
      });
      try {
        await eventually(async () => (await pendingEmailJobs()) === 0);
      } finally {
        await worker.close();
      }
    }

    it('without SMTP: 202, a job, and nothing is sent or created', async () => {
      const count = async () =>
        (await db.kysely.selectFrom('meta.password_resets').select('id').execute()).length;
      const before = await count();
      const response = await forgot(t, member.email);
      expect(response.statusCode).toBe(202);
      expect(response.body).toBe('');
      expect(await pendingEmailJobs()).toBe(1);
      await drain(t);
      expect(await count()).toBe(before);
    });

    it('known and unknown emails get identical responses after identical work', async () => {
      const known = await seedUser(db, { memberships: [{ orgId: orgB, role: 'member' }] });
      const responses = [
        await forgot(mailApp, known.email),
        await forgot(mailApp, 'nobody-at-all@example.test'),
      ];
      const shape = (response: (typeof responses)[number]) => {
        const headers = Object.fromEntries(
          Object.entries(response.headers).filter(
            ([name]) => !['x-request-id', 'date'].includes(name),
          ),
        );
        return { status: response.statusCode, body: response.body, headers };
      };
      expect(shape(responses[0] as (typeof responses)[number])).toEqual(
        shape(responses[1] as (typeof responses)[number]),
      );
      // Both only enqueued a job: no user lookup, no link yet.
      expect(await pendingEmailJobs()).toBe(2);
      const links = await db.kysely
        .selectFrom('meta.password_resets')
        .select('id')
        .where('user_id', '=', known.id)
        .execute();
      expect(links).toEqual([]);
      await drain(mailApp);
      await waitFor(() => smtp.messages.some((mail) => mail.to.includes(known.email)));
      expect(
        smtp.messages.filter((mail) => mail.to.includes('nobody-at-all@example.test')),
      ).toEqual([]);
    });

    it('with SMTP, unknown email or account without password: 202 and no mail', async () => {
      const sent = smtp.messages.length;
      expect((await forgot(mailApp, 'nobody@example.test')).statusCode).toBe(202);
      expect((await forgot(mailApp, external.email)).statusCode).toBe(202);
      await drain(mailApp);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(smtp.messages).toHaveLength(sent);
    });

    it('with SMTP, known email: 202 and a working link by email', async () => {
      const target = await seedUser(db, { memberships: [{ orgId: orgB, role: 'member' }] });
      const ip = uniqueIp();
      const response = await forgot(mailApp, target.email.toUpperCase(), ip);
      expect(response.statusCode).toBe(202);
      await drain(mailApp);
      await waitFor(() => smtp.messages.some((mail) => mail.to.includes(target.email)));
      const mail = smtp.messages.find((item) => item.to.includes(target.email));
      expect(mail?.to).toEqual([target.email]);
      const body = decodeQuotedPrintable(mail?.raw ?? '');
      expect(body).toContain('Reset your Cellhive password');
      const match = new RegExp(`${TEST_PUBLIC_URL}/reset/([A-Za-z0-9_-]{43})`).exec(body);
      const token = match?.[1] ?? '';
      expect(token).toHaveLength(43);
      expect(mailApp.logs.raw()).not.toContain(token);

      expect((await redeem(token, NEW_PASSWORD, mailApp)).statusCode).toBe(204);
      expect((await new Browser(mailApp.app).login(target.email, NEW_PASSWORD)).statusCode).toBe(
        204,
      );
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .selectAll()
        .where('action', '=', 'auth.password_reset_requested')
        .where('entity_id', '=', target.id)
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({
        organization_id: orgB,
        actor_type: 'system',
        ip,
        request_id: response.headers['x-request-id'],
      });
    });

    it.each(['admin', 'cli'] as const)(
      'does not cancel a %s link; a newer self-service link replaces the older one',
      async (source) => {
        const target = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
        let issuedToken: string;
        if (source === 'admin') {
          const adminLink = await resetLink(await signedIn(admin), orgA, target.id);
          expect(adminLink.statusCode).toBe(201);
          issuedToken = tokenOf(passwordResetLinkSchema.parse(adminLink.json()).reset_url);
        } else {
          issuedToken = await cliLink(target.id);
        }

        const selfServiceTokens: string[] = [];
        for (let i = 0; i < 2; i += 1) {
          const sent = smtp.messages.filter((mail) => mail.to.includes(target.email)).length;
          expect((await forgot(mailApp, target.email)).statusCode).toBe(202);
          await drain(mailApp);
          await waitFor(
            () => smtp.messages.filter((mail) => mail.to.includes(target.email)).length > sent,
          );
          const mails = smtp.messages.filter((mail) => mail.to.includes(target.email));
          const body = decodeQuotedPrintable(mails.at(-1)?.raw ?? '');
          const match = new RegExp(`${TEST_PUBLIC_URL}/reset/([A-Za-z0-9_-]{43})`).exec(body);
          selfServiceTokens.push(match?.[1] ?? '');
        }
        const rows = await db.kysely
          .selectFrom('meta.password_resets')
          .select('source')
          .where('user_id', '=', target.id)
          .where('used_at', 'is', null)
          .execute();
        expect(rows.map((row) => row.source).sort()).toEqual([source, 'self_service'].sort());

        // The older self-service link is gone; the issued link still works.
        expect((await redeem(selfServiceTokens[0] ?? '', NEW_PASSWORD)).statusCode).toBe(410);
        expect((await redeem(issuedToken, NEW_PASSWORD)).statusCode).toBe(204);
      },
    );

    it('an admin or CLI link replaces every earlier unused link of the user', async () => {
      const target = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      const firstCli = await cliLink(target.id);
      const adminLink = await resetLink(await signedIn(admin), orgA, target.id);
      const adminToken = tokenOf(passwordResetLinkSchema.parse(adminLink.json()).reset_url);
      expect((await redeem(firstCli, NEW_PASSWORD)).statusCode).toBe(410);
      const secondCli = await cliLink(target.id);
      expect((await redeem(adminToken, NEW_PASSWORD)).statusCode).toBe(410);
      expect((await redeem(secondCli, NEW_PASSWORD)).statusCode).toBe(204);
    });

    it('limits requests to 5 per hour per email (429 + Retry-After)', async () => {
      const email = 'limited@example.test';
      const statuses: number[] = [];
      let last;
      for (let i = 0; i < 6; i += 1) {
        last = await forgot(mailApp, email);
        statuses.push(last.statusCode);
      }
      expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
      expect(problemOf(last?.body ?? '{}').code).toBe('RATE_LIMITED');
      expect(Number(last?.headers['retry-after'])).toBeGreaterThan(3500);
    });

    it('limits requests to 20 per hour per IP', async () => {
      const ip = uniqueIp();
      const statuses: number[] = [];
      for (let i = 0; i < 21; i += 1) {
        statuses.push((await forgot(mailApp, `ip${String(i)}@example.test`, ip)).statusCode);
      }
      expect(statuses.filter((status) => status === 202)).toHaveLength(20);
      expect(statuses[20]).toBe(429);
    });
  });
});
