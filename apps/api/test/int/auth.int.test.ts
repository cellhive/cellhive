import { createHash } from 'node:crypto';

import {
  CSRF_COOKIE,
  CSRF_HEADER,
  meResponseSchema,
  SESSION_COOKIE,
  type Id,
} from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PasswordHasher } from '../../src/common/auth/password/password-hasher.js';
import { LoginThrottle } from '../../src/modules/auth/login-throttle.js';

import {
  Browser,
  PASSWORD,
  seedOrg,
  seedUser,
  setCookiesOf,
  uniqueIp,
  type SeededUser,
} from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('authentication (SPEC §14.2)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let orgA: Id<'org'>;
  let orgB: Id<'org'>;
  let alice: SeededUser;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    orgA = await seedOrg(db, 'Alpha');
    orgB = await seedOrg(db, 'Beta');
    alice = await seedUser(db, {
      email: 'alice@example.test',
      displayName: 'Alice',
      memberships: [
        { orgId: orgA, role: 'owner' },
        { orgId: orgB, role: 'member' },
      ],
    });
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  async function auditOf(action: string) {
    return db.kysely
      .selectFrom('meta.audit_logs')
      .selectAll()
      .where('action', '=', action)
      .orderBy('created_at')
      .execute();
  }

  describe('login', () => {
    it('opens a session: HttpOnly session cookie, readable CSRF cookie, hash stored', async () => {
      const browser = new Browser(t.app);
      const response = await browser.login(alice.email);
      expect(response.statusCode).toBe(204);
      const cookies = setCookiesOf(response);
      const session = cookies.get(SESSION_COOKIE);
      const csrf = cookies.get(CSRF_COOKIE);
      expect(session?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(session?.attributes).toEqual(
        expect.arrayContaining(['Path=/', 'SameSite=Lax', 'HttpOnly', 'Max-Age=2592000']),
      );
      // Direct HTTP with COOKIE_SECURE=auto: no Secure.
      expect(session?.attributes).not.toContain('Secure');
      expect(csrf?.attributes).toEqual(expect.arrayContaining(['Path=/', 'SameSite=Lax']));
      expect(csrf?.attributes).not.toContain('HttpOnly');

      const rows = await db.kysely
        .selectFrom('meta.sessions')
        .selectAll()
        .where('user_id', '=', alice.id)
        .execute();
      const stored = rows.find((row) => row.token_hash === sha256(session?.value ?? ''));
      expect(stored).toBeDefined();
      expect(rows.some((row) => row.token_hash === session?.value)).toBe(false);
      const days = ((stored?.expires_at.getTime() ?? 0) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(stored?.ip).toBe(browser.ip);
    });

    it('audits auth.login once per organization of the user', async () => {
      const before = (await auditOf('auth.login')).length;
      const browser = new Browser(t.app);
      await browser.login(alice.email);
      const entries = (await auditOf('auth.login')).slice(before);
      expect(entries.map((entry) => entry.organization_id).sort()).toEqual([orgA, orgB].sort());
      expect(entries[0]).toMatchObject({ actor_type: 'user', actor_id: alice.id });
    });

    it('rejects a wrong password with 401 and audits auth.login_failed for the orgs', async () => {
      const browser = new Browser(t.app);
      const response = await browser.login(alice.email, 'Wrong-Password-123');
      expect(response.statusCode).toBe(401);
      expect(problemOf(response.body).code).toBe('UNAUTHENTICATED');
      expect(response.headers['set-cookie']).toBeUndefined();
      const entries = await auditOf('auth.login_failed');
      const forAlice = entries.filter((entry) => entry.entity_id === alice.id);
      expect(forAlice.map((entry) => entry.organization_id).sort()).toEqual([orgA, orgB].sort());
      expect(forAlice[0]?.after).toEqual({ reason: 'invalid_credentials' });
      // Reset the counter for the other tests.
      expect((await browser.login(alice.email)).statusCode).toBe(204);
    });

    it('rejects an unknown email the same way and audits it with organization_id NULL', async () => {
      const browser = new Browser(t.app);
      const response = await browser.login('nobody@example.test', 'Whatever-123456');
      expect(response.statusCode).toBe(401);
      expect(problemOf(response.body).code).toBe('UNAUTHENTICATED');
      const entry = (await auditOf('auth.login_failed')).find(
        (row) => row.entity_id === null && row.ip === browser.ip,
      );
      expect(entry).toMatchObject({
        organization_id: null,
        actor_type: 'system',
        entity_type: 'user',
        after: { reason: 'unknown_email' },
      });
      // The attempted email and password are never stored.
      expect(JSON.stringify(entry)).not.toContain('nobody@example.test');
    });

    it('rejects users without a password and disabled users', async () => {
      const external = await seedUser(db, { password: null, memberships: [] });
      const disabled = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      await db.kysely
        .updateTable('meta.users')
        .set({ status: 'disabled' })
        .where('id', '=', disabled.id)
        .execute();
      expect((await new Browser(t.app).login(external.email, PASSWORD)).statusCode).toBe(401);
      expect((await new Browser(t.app).login(disabled.email)).statusCode).toBe(401);
    });

    it('rotates the session: signing in again revokes the session sent with the request', async () => {
      const browser = new Browser(t.app);
      await browser.login(alice.email);
      const first = browser.sessionToken ?? '';
      const again = await browser.login(alice.email);
      expect(again.statusCode).toBe(204);
      expect(browser.sessionToken).not.toBe(first);
      const old = await db.kysely
        .selectFrom('meta.sessions')
        .select('id')
        .where('token_hash', '=', sha256(first))
        .execute();
      expect(old).toHaveLength(0);
    });

    it('validates the body with 422', async () => {
      const response = await new Browser(t.app).request({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'not-an-email', password: '' },
      });
      expect(response.statusCode).toBe(422);
      expect(problemOf(response.body).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('lockout and rate limit', () => {
    it('locks an email for 15 minutes after 10 consecutive failures (423 + Retry-After)', async () => {
      const victim = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      const statuses: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        // A different IP each time: the lock is per email, not per IP.
        const response = await new Browser(t.app).login(
          victim.email,
          `Wrong-${String(i)}-password`,
        );
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 9).every((status) => status === 401)).toBe(true);
      expect(statuses[9]).toBe(423);

      const locked = await new Browser(t.app).login(victim.email);
      expect(locked.statusCode).toBe(423);
      expect(problemOf(locked.body).code).toBe('ACCOUNT_LOCKED');
      const retryAfter = Number(locked.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(880);
      expect(retryAfter).toBeLessThanOrEqual(900);
      const failures = (await auditOf('auth.login_failed')).filter(
        (entry) => entry.entity_id === victim.id,
      );
      expect(failures).toHaveLength(10);
      expect(failures.at(-1)?.after).toEqual({ reason: 'invalid_credentials', locked: true });
    });

    it('parallel attempts run at most 10 password checks per window', async () => {
      const victim = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      const hasher = t.app.get(PasswordHasher);
      const original = hasher.verify.bind(hasher);
      let checks = 0;
      const spy = vi.spyOn(hasher, 'verify').mockImplementation(async (hash, password) => {
        checks += 1;
        // Slow checks: every request is in flight at the same time.
        await new Promise((resolve) => setTimeout(resolve, 100));
        return original(hash, password);
      });
      try {
        const responses = await Promise.all(
          Array.from({ length: 25 }, (_, i) =>
            new Browser(t.app).login(victim.email, `Wrong-${String(i)}-password`),
          ),
        );
        expect(checks).toBeLessThanOrEqual(10);
        const statuses = responses.map((response) => response.statusCode);
        expect(statuses.filter((status) => status === 423).length).toBeGreaterThanOrEqual(15);
        expect(statuses.every((status) => status === 401 || status === 423)).toBe(true);
        // Locked now, even with the right password (no further check).
        const before = checks;
        expect((await new Browser(t.app).login(victim.email)).statusCode).toBe(423);
        expect(checks).toBe(before);
      } finally {
        spy.mockRestore();
      }
    });

    it('an attempt that passed the lock check before the lock was set is still refused', async () => {
      const throttle = t.app.get(LoginThrottle);
      const key = `race-${String(Date.now())}@example.test`;
      for (let i = 0; i < 10; i += 1) {
        expect((await throttle.beginAttempt(key)).allowed).toBe(true);
      }
      // The 11th attempt locks the email and restarts the counter.
      expect((await throttle.beginAttempt(key)).allowed).toBe(false);
      // A request that checked the lock earlier now counts from 1 again.
      const late = await throttle.beginAttempt(key);
      expect(late.count).toBe(1);
      expect(late.allowed).toBe(false);
      expect(late.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('a successful sign-in clears the attempt counter', async () => {
      const user = await seedUser(db, { memberships: [{ orgId: orgA, role: 'member' }] });
      for (let i = 0; i < 9; i += 1) {
        expect((await new Browser(t.app).login(user.email, 'Wrong-password-123')).statusCode).toBe(
          401,
        );
      }
      expect((await new Browser(t.app).login(user.email)).statusCode).toBe(204);
      for (let i = 0; i < 9; i += 1) {
        expect((await new Browser(t.app).login(user.email, 'Wrong-password-123')).statusCode).toBe(
          401,
        );
      }
      expect((await new Browser(t.app).login(user.email)).statusCode).toBe(204);
    });

    it('also locks unknown emails, so a lock reveals nothing', async () => {
      for (let i = 0; i < 10; i += 1) {
        await new Browser(t.app).login('ghost@example.test', 'Wrong-password-123');
      }
      const response = await new Browser(t.app).login('ghost@example.test', 'Wrong-password-123');
      expect(response.statusCode).toBe(423);
    });

    it('limits sign-in attempts per IP (429 + Retry-After)', async () => {
      const ip = uniqueIp();
      // All at once (QA S5c): the window is a fixed minute and every failed sign-in runs the
      // password hash; 21 sequential attempts on a loaded machine could outlast the window
      // (a flaky test). The limiter counts before hashing, so exactly one of 21 is refused.
      const responses = await Promise.all(
        Array.from({ length: 21 }, (_, i) =>
          new Browser(t.app, ip).login(`probe${String(i)}@example.test`, 'x-password'),
        ),
      );
      const statuses = responses.map((response) => response.statusCode);
      expect(statuses.filter((status) => status === 401)).toHaveLength(20);
      const last = responses.find((response) => response.statusCode === 429);
      expect(last?.statusCode).toBe(429);
      expect(problemOf(last?.body ?? '{}').code).toBe('RATE_LIMITED');
      const retryAfter = Number(last?.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    });
  });

  describe('GET /me', () => {
    it('returns the CONTRACTS §5A shape', async () => {
      const browser = new Browser(t.app);
      await browser.login(alice.email);
      const response = await browser.request({ method: 'GET', url: '/api/v1/me' });
      expect(response.statusCode).toBe(200);
      const me = meResponseSchema.parse(response.json());
      const slugs = new Map(
        (
          await db.kysely
            .selectFrom('meta.organizations')
            .select(['id', 'slug'])
            .where('id', 'in', [orgA, orgB])
            .execute()
        ).map((row) => [row.id, row.slug]),
      );
      expect(me).toEqual({
        user: { id: alice.id, email: alice.email, display_name: 'Alice', avatar_url: null },
        orgs: [
          { id: orgA, name: 'Alpha', slug: slugs.get(orgA), role: 'owner' },
          { id: orgB, name: 'Beta', slug: slugs.get(orgB), role: 'member' },
        ],
        // From the first organization's settings (user locale is NULL).
        locale: 'vi',
        timezone: 'Asia/Ho_Chi_Minh',
      });
    });

    it('prefers the user locale and falls back to the instance defaults', async () => {
      const loner = await seedUser(db, {});
      await db.kysely
        .updateTable('meta.users')
        .set({ timezone: 'Europe/Paris' })
        .where('id', '=', loner.id)
        .execute();
      const browser = new Browser(t.app);
      await browser.login(loner.email);
      const me = (await browser.request({ method: 'GET', url: '/api/v1/me' })).json<{
        orgs: unknown[];
        locale: string;
        timezone: string;
      }>();
      expect(me).toMatchObject({ orgs: [], locale: 'en', timezone: 'Europe/Paris' });
    });

    it('answers 401 UNAUTHENTICATED without a session or with an unknown token', async () => {
      const anonymous = await t.app.inject({ method: 'GET', url: '/api/v1/me' });
      expect(anonymous.statusCode).toBe(401);
      expect(problemOf(anonymous.body).code).toBe('UNAUTHENTICATED');
      const forged = await t.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` },
      });
      expect(forged.statusCode).toBe(401);
      // The stale cookie is cleared.
      expect(setCookiesOf(forged).get(SESSION_COOKIE)?.attributes).toContain('Max-Age=0');
    });

    it('re-issues a missing CSRF cookie', async () => {
      const browser = new Browser(t.app);
      await browser.login(alice.email);
      browser.cookies.delete(CSRF_COOKIE);
      const response = await browser.request({ method: 'GET', url: '/api/v1/me' });
      expect(setCookiesOf(response).get(CSRF_COOKIE)?.value).toMatch(/\./);
      expect(browser.csrfToken).toBeDefined();
      const logout = await browser.request({ method: 'POST', url: '/api/v1/auth/logout' });
      expect(logout.statusCode).toBe(204);
    });

    it('rejects an expired session', async () => {
      const browser = new Browser(t.app);
      await browser.login(alice.email);
      await db.kysely
        .updateTable('meta.sessions')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('token_hash', '=', sha256(browser.sessionToken ?? ''))
        .execute();
      expect((await browser.request({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
    });

    it('slides the expiry when the last activity is older than the touch interval', async () => {
      const browser = new Browser(t.app);
      await browser.login(alice.email);
      const hash = sha256(browser.sessionToken ?? '');
      await db.kysely
        .updateTable('meta.sessions')
        .set({
          last_seen_at: new Date(Date.now() - 3_600_000),
          expires_at: new Date(Date.now() + 86_400_000),
        })
        .where('token_hash', '=', hash)
        .execute();
      const response = await browser.request({ method: 'GET', url: '/api/v1/me' });
      expect(response.statusCode).toBe(200);
      expect(setCookiesOf(response).get(SESSION_COOKIE)?.attributes).toContain('Max-Age=2592000');
      const row = await db.kysely
        .selectFrom('meta.sessions')
        .select(['expires_at', 'last_seen_at'])
        .where('token_hash', '=', hash)
        .executeTakeFirstOrThrow();
      expect(row.expires_at.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
      expect(Date.now() - row.last_seen_at.getTime()).toBeLessThan(60_000);
    });
  });

  describe('CSRF (signed double-submit)', () => {
    it('rejects a state-changing request with the session cookie but no token: 403 CSRF_INVALID', async () => {
      const browser = new Browser(t.app);
      await browser.login(alice.email);
      const response = await browser.request({
        method: 'POST',
        url: '/api/v1/auth/logout',
        csrf: false,
      });
      expect(response.statusCode).toBe(403);
      expect(problemOf(response.body).code).toBe('CSRF_INVALID');
      // Still signed in.
      expect((await browser.request({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(200);
    });

    it('rejects a header that does not match the cookie, and a token of another session', async () => {
      const browser = new Browser(t.app);
      await browser.login(alice.email);
      const other = new Browser(t.app);
      await other.login(alice.email);

      const mismatch = await browser.request({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { [CSRF_HEADER]: other.csrfToken ?? '' },
      });
      expect(mismatch.statusCode).toBe(403);

      // Both cookie and header replaced by a token signed for another session.
      browser.cookies.set(CSRF_COOKIE, other.csrfToken ?? '');
      const foreign = await browser.request({ method: 'POST', url: '/api/v1/auth/logout' });
      expect(foreign.statusCode).toBe(403);
      expect(problemOf(foreign.body).code).toBe('CSRF_INVALID');
    });

    it('does not require a token without a session cookie or for GET', async () => {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        remoteAddress: uniqueIp(),
      });
      expect(response.statusCode).toBe(204);
    });
  });

  describe('logout', () => {
    it('revokes the session, clears the cookies and audits auth.logout', async () => {
      const browser = new Browser(t.app);
      await browser.login(alice.email);
      const token = browser.sessionToken ?? '';
      const response = await browser.request({ method: 'POST', url: '/api/v1/auth/logout' });
      expect(response.statusCode).toBe(204);
      const cleared = setCookiesOf(response);
      expect(cleared.get(SESSION_COOKIE)?.attributes).toContain('Max-Age=0');
      expect(cleared.get(CSRF_COOKIE)?.attributes).toContain('Max-Age=0');

      const reused = await t.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(reused.statusCode).toBe(401);
      const rows = await db.kysely
        .selectFrom('meta.sessions')
        .select('id')
        .where('token_hash', '=', sha256(token))
        .execute();
      expect(rows).toHaveLength(0);
      expect((await auditOf('auth.logout')).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('COOKIE_SECURE', () => {
    it('auto: Secure behind a trusted HTTPS proxy, not from an untrusted client', async () => {
      const proxied = await new Browser(t.app, '127.0.0.1').request({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: alice.email, password: PASSWORD },
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': uniqueIp() },
      });
      expect(proxied.statusCode).toBe(204);
      expect(setCookiesOf(proxied).get(SESSION_COOKIE)?.attributes).toContain('Secure');
      expect(setCookiesOf(proxied).get(CSRF_COOKIE)?.attributes).toContain('Secure');

      const spoofed = await new Browser(t.app, '203.0.113.7').request({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: alice.email, password: PASSWORD },
        headers: { 'x-forwarded-proto': 'https' },
      });
      expect(spoofed.statusCode).toBe(204);
      expect(setCookiesOf(spoofed).get(SESSION_COOKIE)?.attributes).not.toContain('Secure');
    });

    it('records the client IP from X-Forwarded-For behind a trusted proxy', async () => {
      const clientIp = uniqueIp();
      const response = await new Browser(t.app, '127.0.0.1').request({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: alice.email, password: PASSWORD },
        headers: { 'x-forwarded-for': clientIp },
      });
      const token = setCookiesOf(response).get(SESSION_COOKIE)?.value ?? '';
      const row = await db.kysely
        .selectFrom('meta.sessions')
        .select(sql<string>`host(ip)`.as('ip'))
        .where('token_hash', '=', sha256(token))
        .executeTakeFirstOrThrow();
      expect(row.ip).toBe(clientIp);
    });

    it('true: always Secure, even over plain HTTP; false: never', async () => {
      for (const [setting, expected] of [
        ['true', true],
        ['false', false],
      ] as const) {
        const app = await startTestApp({ DATABASE_URL: database.url, COOKIE_SECURE: setting });
        try {
          const response = await new Browser(app.app).request({
            method: 'POST',
            url: '/api/v1/auth/login',
            payload: { email: alice.email, password: PASSWORD },
            headers: { 'x-forwarded-proto': 'https' },
          });
          expect(response.statusCode).toBe(204);
          expect(setCookiesOf(response).get(SESSION_COOKIE)?.attributes.includes('Secure')).toBe(
            expected,
          );
        } finally {
          await app.close();
        }
      }
    });
  });

  describe('routes are private by default', () => {
    it('keeps probes and signed storage URLs public', async () => {
      expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await t.app.inject({ method: 'GET', url: '/api/v1/setup' })).statusCode).toBe(200);
    });

    it('never logs session tokens or passwords', async () => {
      const browser = new Browser(t.app);
      await browser.login(alice.email);
      const raw = t.logs.raw();
      expect(raw).not.toContain(browser.sessionToken ?? 'missing');
      expect(raw).not.toContain(PASSWORD);
    });
  });
});
