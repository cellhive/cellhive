import {
  createdApiTokenSchema,
  meResponseSchema,
  type CreatedApiToken,
  type Id,
} from '@cellhive/contracts';
import { UsersRepository, type Db } from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser, PASSWORD, seedOrg, seedUser, uniqueIp, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

const NEW_PASSWORD = 'Profile-Change-Secret-2026';

/**
 * `PATCH /me` and `POST /me/password` (BACKLOG T831, CONTRACTS §12.0):
 * session only, validated, audited once per organization of the user
 * without any password or hash; a password change keeps the current
 * session, drops the others and revokes API tokens only when asked.
 */
describe('profile and password of the signed-in user (T831)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let orgA: Id<'org'>;
  let orgB: Id<'org'>;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    orgA = await seedOrg(db, 'Alpha');
    orgB = await seedOrg(db, 'Beta');
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  /** A member of both organizations: `auth.*` audit is written once per organization. */
  function newUser(): Promise<SeededUser> {
    return seedUser(db, {
      memberships: [
        { orgId: orgA, role: 'member' },
        { orgId: orgB, role: 'member' },
      ],
    });
  }

  async function signedIn(user: SeededUser, password = PASSWORD): Promise<Browser> {
    const browser = new Browser(t.app);
    const response = await browser.login(user.email, password);
    expect(response.statusCode, response.body).toBe(204);
    return browser;
  }

  function patchMe(browser: Browser, payload: unknown) {
    return browser.request({ method: 'PATCH', url: '/api/v1/me', payload: payload as object });
  }

  function changePassword(browser: Browser, payload: Record<string, unknown>) {
    return browser.request({ method: 'POST', url: '/api/v1/me/password', payload });
  }

  async function createToken(browser: Browser): Promise<CreatedApiToken> {
    const response = await browser.request({
      method: 'POST',
      url: `/api/v1/orgs/${orgA}/me/api-tokens`,
      payload: {
        name: 'integration',
        scopes: ['schema:read'],
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  function bearerMe(token: string) {
    return t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: uniqueIp(),
    });
  }

  function auditsOf(action: string, userId: Id<'usr'>) {
    return db.kysely
      .selectFrom('meta.audit_logs')
      .select(['organization_id', 'actor_type', 'actor_id', 'entity_type', 'before', 'after'])
      .where('action', '=', action)
      .where('entity_id', '=', userId)
      .orderBy('created_at')
      .execute();
  }

  describe('PATCH /me', () => {
    it('sets the given keys, returns the user as GET /me and audits only what changed', async () => {
      const user = await newUser();
      const browser = await signedIn(user);
      const response = await patchMe(browser, {
        display_name: '  Trần Văn An  ',
        timezone: 'Asia/Saigon',
      });
      expect(response.statusCode, response.body).toBe(200);
      const me = meResponseSchema.parse(response.json());
      // Trimmed; the CLDR alias is stored as its IANA primary name.
      expect(me.user.display_name).toBe('Trần Văn An');
      expect(me.timezone).toBe('Asia/Ho_Chi_Minh');
      expect(me.orgs.map((org) => org.id).sort()).toEqual([orgA, orgB].sort());

      const again = await patchMe(browser, { locale: 'vi', display_name: 'Trần Văn An' });
      expect(again.statusCode, again.body).toBe(200);
      const read = await browser.request({ method: 'GET', url: '/api/v1/me' });
      expect(meResponseSchema.parse(read.json())).toMatchObject({
        user: { display_name: 'Trần Văn An' },
        locale: 'vi',
        timezone: 'Asia/Ho_Chi_Minh',
      });
      expect(await new UsersRepository(db).findById(user.id)).toMatchObject({
        display_name: 'Trần Văn An',
        locale: 'vi',
        timezone: 'Asia/Ho_Chi_Minh',
      });

      const audits = await auditsOf('user.updated', user.id);
      // Two saves × two organizations; the unchanged display name is not repeated.
      expect(audits).toHaveLength(4);
      expect(new Set(audits.map((entry) => entry.organization_id))).toEqual(new Set([orgA, orgB]));
      expect(audits[0]).toMatchObject({
        actor_type: 'user',
        actor_id: user.id,
        entity_type: 'user',
        after: { display_name: 'Trần Văn An', timezone: 'Asia/Ho_Chi_Minh' },
      });
      expect(audits[3]).toMatchObject({ before: { locale: null }, after: { locale: 'vi' } });

      // Nothing changed: nothing written.
      expect((await patchMe(browser, { locale: 'vi' })).statusCode).toBe(200);
      expect(await auditsOf('user.updated', user.id)).toHaveLength(4);
    });

    it.each<[string, unknown, string, string]>([
      ['an empty body', {}, '', 'INVALID'],
      ['a blank display name', { display_name: '   ' }, 'display_name', 'TOO_SMALL'],
      ['a display name over 100', { display_name: 'x'.repeat(101) }, 'display_name', 'TOO_BIG'],
      ['an unsupported locale', { locale: 'fr' }, 'locale', 'INVALID_VALUE'],
      ['an unknown time zone', { timezone: 'Mars/Olympus' }, 'timezone', 'INVALID_TIME_ZONE'],
      ['an unknown key', { locale: 'vi', email: 'x@example.test' }, 'email', 'UNRECOGNIZED_KEY'],
    ])('%s → 422 VALIDATION_FAILED', async (_name, payload, path, code) => {
      const browser = await signedIn(await newUser());
      const response = await patchMe(browser, payload);
      expect(response.statusCode, response.body).toBe(422);
      expect(problemOf(response.body)).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [expect.objectContaining({ path, code })],
      });
    });

    it('without a session → 401; without the CSRF header → 403', async () => {
      const anonymous = await t.app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: { locale: 'vi' },
      });
      expect(anonymous.statusCode).toBe(401);
      const browser = await signedIn(await newUser());
      const response = await browser.request({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: { locale: 'vi' },
        csrf: false,
      });
      expect(response.statusCode).toBe(403);
      expect(problemOf(response.body)).toMatchObject({ code: 'CSRF_INVALID' });
    });
  });

  describe('POST /me/password', () => {
    it('keeps this session, drops the others, keeps API tokens by default; audit has no secret', async () => {
      const user = await newUser();
      const browser = await signedIn(user);
      const other = await signedIn(user);
      const token = await createToken(browser);

      const response = await changePassword(browser, {
        current_password: PASSWORD,
        new_password: NEW_PASSWORD,
      });
      expect(response.statusCode, response.body).toBe(204);

      expect((await browser.request({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(200);
      expect((await other.request({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
      expect((await bearerMe(token.token)).statusCode).toBe(200);
      expect((await new Browser(t.app).login(user.email, PASSWORD)).statusCode).toBe(401);
      expect((await new Browser(t.app).login(user.email, NEW_PASSWORD)).statusCode).toBe(204);

      const changed = await auditsOf('auth.password_changed', user.id);
      expect(changed).toHaveLength(2);
      expect(new Set(changed.map((entry) => entry.organization_id))).toEqual(new Set([orgA, orgB]));
      expect(changed[0]).toMatchObject({
        actor_type: 'user',
        actor_id: user.id,
        after: { revoked_sessions: 1, revoked_tokens: 0 },
      });
      const revoked = await auditsOf('auth.session_revoked', user.id);
      expect(revoked).toHaveLength(2);
      expect(revoked[0]?.after).toEqual({ reason: 'password_change', revoked_sessions: 1 });
      expect(await auditsOf('api_token.revoked', user.id)).toEqual([]);

      const stored = await new UsersRepository(db).findById(user.id);
      const written = JSON.stringify([changed, revoked]) + t.logs.raw();
      for (const secret of [PASSWORD, NEW_PASSWORD, stored?.password_hash ?? 'missing']) {
        expect(written).not.toContain(secret);
      }
    });

    it('with revoke_tokens, revokes every API token of the caller', async () => {
      const user = await newUser();
      const browser = await signedIn(user);
      const token = await createToken(browser);
      const response = await changePassword(browser, {
        current_password: PASSWORD,
        new_password: NEW_PASSWORD,
        revoke_tokens: true,
      });
      expect(response.statusCode, response.body).toBe(204);
      const bearer = await bearerMe(token.token);
      expect({ status: bearer.statusCode, code: problemOf(bearer.body).code }).toEqual({
        status: 401,
        code: 'TOKEN_REVOKED',
      });
      const [changed] = await auditsOf('auth.password_changed', user.id);
      expect(changed?.after).toEqual({ revoked_sessions: 0, revoked_tokens: 1 });
      const [bulk] = await auditsOf('api_token.revoked', user.id);
      expect(bulk).toMatchObject({
        organization_id: orgA,
        after: { reason: 'password_change', count: 1, token_ids: [token.id] },
      });
      // Only one session existed: nothing else was signed out.
      expect(await auditsOf('auth.session_revoked', user.id)).toEqual([]);
    });

    it('a wrong current password → 422 CURRENT_PASSWORD_INVALID, nothing changes', async () => {
      const user = await newUser();
      const browser = await signedIn(user);
      const other = await signedIn(user);
      const response = await changePassword(browser, {
        current_password: 'Not-The-Password-1',
        new_password: NEW_PASSWORD,
      });
      expect(response.statusCode, response.body).toBe(422);
      expect(problemOf(response.body)).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'current_password', code: 'CURRENT_PASSWORD_INVALID' }],
      });
      // Not a 401: the session stays valid.
      expect((await browser.request({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(200);
      expect((await other.request({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(200);
      expect((await new Browser(t.app).login(user.email, PASSWORD)).statusCode).toBe(204);
      expect(await auditsOf('auth.password_changed', user.id)).toEqual([]);
    });

    it.each<[string, Record<string, unknown>, string, string]>([
      ['a short new password', { new_password: 'short' }, 'new_password', 'TOO_SMALL'],
      [
        'a common new password',
        { new_password: 'password1234' },
        'new_password',
        'PASSWORD_TOO_COMMON',
      ],
      ['no current password', { current_password: '' }, 'current_password', 'TOO_SMALL'],
      [
        'revoke_tokens not a boolean',
        { revoke_tokens: 'yes' },
        'revoke_tokens',
        'EXPECTED_BOOLEAN',
      ],
    ])('%s → 422 VALIDATION_FAILED', async (_name, override, path, code) => {
      const browser = await signedIn(await newUser());
      const response = await changePassword(browser, {
        current_password: PASSWORD,
        new_password: NEW_PASSWORD,
        ...override,
      });
      expect(response.statusCode, response.body).toBe(422);
      expect(problemOf(response.body)).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [expect.objectContaining({ path, code })],
      });
    });

    it('an account without a password (external sign-in only) → 422 NO_PASSWORD', async () => {
      // Such a user signs in through OIDC; here the password is dropped after signing in.
      const user = await newUser();
      const browser = await signedIn(user);
      const users = new UsersRepository(db);
      await db.kysely
        .updateTable('meta.users')
        .set({ password_hash: null })
        .where('id', '=', user.id)
        .execute();
      const response = await changePassword(browser, {
        current_password: PASSWORD,
        new_password: NEW_PASSWORD,
      });
      expect(response.statusCode, response.body).toBe(422);
      expect(problemOf(response.body)).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [expect.objectContaining({ path: 'current_password', code: 'NO_PASSWORD' })],
      });
      expect((await users.findById(user.id))?.password_hash).toBeNull();
    });

    it('10 attempts per hour per user, then 429 RATE_LIMITED with Retry-After', async () => {
      const browser = await signedIn(await newUser());
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await changePassword(browser, {
          current_password: `Wrong-Password-${String(attempt)}`,
          new_password: NEW_PASSWORD,
        });
        expect(response.statusCode, response.body).toBe(422);
      }
      const limited = await changePassword(browser, {
        current_password: PASSWORD,
        new_password: NEW_PASSWORD,
      });
      expect(limited.statusCode).toBe(429);
      expect(problemOf(limited.body)).toMatchObject({ code: 'RATE_LIMITED' });
      expect(limited.headers['retry-after']).toBeDefined();
    });
  });

  it('API tokens cannot call either route → 403 INSUFFICIENT_SCOPE (session only)', async () => {
    const user = await newUser();
    const browser = await signedIn(user);
    const token = await createToken(browser);
    for (const [method, url, payload] of [
      ['PATCH', '/api/v1/me', { locale: 'vi' }],
      ['POST', '/api/v1/me/password', { current_password: PASSWORD, new_password: NEW_PASSWORD }],
    ] as const) {
      const response = await t.app.inject({
        method,
        url,
        payload,
        headers: { authorization: `Bearer ${token.token}` },
        remoteAddress: uniqueIp(),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(problemOf(response.body)).toMatchObject({
        code: 'INSUFFICIENT_SCOPE',
        errors: [expect.objectContaining({ params: { required: ['session'] } })],
      });
    }
    expect(await new UsersRepository(db).findById(user.id)).toMatchObject({ locale: null });
    expect((await new Browser(t.app).login(user.email, PASSWORD)).statusCode).toBe(204);
  });
});
