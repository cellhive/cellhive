import { randomBytes } from 'node:crypto';

import {
  acceptInvitationResponseSchema,
  createdApiTokenSchema,
  createdInvitationSchema,
  meIdentityListSchema,
  meResponseSchema,
  newId,
  oidcLinkStartResponseSchema,
  OIDC_STATE_COOKIE,
  SESSION_COOKIE,
  type Id,
} from '@cellhive/contracts';
import {
  OrgMembersRepository,
  orgScope,
  UserIdentitiesRepository,
  UsersRepository,
  type Db,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MetricsService } from '../../src/modules/metrics/metrics.service.js';

import { Browser, seedOrg, seedUser, setCookiesOf, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  startFakeOidc,
  type FakeOidcProvider,
  type FakeOidcUser,
  type IdTokenTweaks,
} from './fake-oidc-support.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse as InjectResponse } from 'fastify';

/**
 * Connected accounts against a fake provider over real HTTP (BACKLOG T708,
 * ADR-36 §3, CONTRACTS §27.3; matrix P63, linking part): manual linking
 * from a signed-in session, unlinking, linking by verified email
 * (`LINK_BY_EMAIL`), invitations accepted by an OIDC user, races.
 *
 * Providers of the test app (same fake IdP, different flags):
 * - `fake`: defaults (no sign-up, no linking by email);
 * - `other`: defaults, a second provider;
 * - `mail`: `LINK_BY_EMAIL=true`.
 */
describe('OIDC account linking (T708)', () => {
  let database: TestDatabase;
  let db: Db;
  let idp: FakeOidcProvider;
  let t: TestApp;
  let orgA: Id<'org'>;
  let orgB: Id<'org'>;
  let sales: SeededUser;
  let editor: SeededUser;
  let admin: SeededUser;
  let identities: UserIdentitiesRepository;
  /** Every response of the app in this file (bodies and `Location` headers), for the canary. */
  const responses: InjectResponse[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    idp = await startFakeOidc();
    orgA = await seedOrg(db, 'Alpha');
    orgB = await seedOrg(db, 'Beta');
    t = await startTestApp({
      DATABASE_URL: database.url,
      NODE_ENV: 'development',
      OIDC_PROVIDERS: 'fake,other,mail',
      ...idp.env('fake', { NAME: 'Fake IdP' }),
      ...idp.env('other', { NAME: 'Other IdP' }),
      ...idp.env('mail', { LINK_BY_EMAIL: 'true' }),
    });
    identities = new UserIdentitiesRepository(db);
    // u_sales1 belongs to two organizations: audit is written once per organization.
    sales = await seedUser(db, {
      email: 'u_sales1@example.test',
      memberships: [
        { orgId: orgA, role: 'member' },
        { orgId: orgB, role: 'member' },
      ],
    });
    editor = await seedUser(db, {
      email: 'u_editor@example.test',
      memberships: [{ orgId: orgA, role: 'member' }],
    });
    admin = await seedUser(db, {
      email: 'u_admin@example.test',
      memberships: [{ orgId: orgA, role: 'admin' }],
    });
    await identities.create({
      userId: editor.id,
      provider: 'fake',
      subject: 'sub-editor',
      email: editor.email,
    });
    idp.users.set('editor', { sub: 'sub-editor', email: editor.email, email_verified: true });
  });

  afterAll(async () => {
    await t.close();
    await idp.close();
    await db.destroy();
    await database.drop();
  });

  // --- helpers ---------------------------------------------------------------

  async function send(
    browser: Browser,
    options: Parameters<Browser['request']>[0],
  ): Promise<InjectResponse> {
    const response = await browser.request(options);
    responses.push(response);
    return response;
  }

  function hintFor(user: FakeOidcUser): string {
    const hint = `hint-${randomBytes(4).toString('hex')}`;
    idp.users.set(hint, user);
    return hint;
  }

  function locationOf(response: InjectResponse): string {
    expect(response.statusCode, response.body).toBe(302);
    return response.headers.location as string;
  }

  async function signedIn(user: SeededUser): Promise<Browser> {
    const browser = new Browser(t.app);
    expect((await browser.login(user.email)).statusCode).toBe(204);
    return browser;
  }

  /** Follows the authorization URL at the fake IdP; returns the callback path + query. */
  async function authorize(location: string, hint: string): Promise<string> {
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.issuer}/authorize`);
    url.searchParams.set('login_hint', hint);
    const response = await fetch(url, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const back = new URL(response.headers.get('location') ?? '');
    expect(back.origin).toBe(new URL(TEST_PUBLIC_URL).origin);
    return `${back.pathname}${back.search}`;
  }

  /** `POST /me/identities/:slug/start` (with CSRF) → its `authorization_url`. */
  async function linkUrl(browser: Browser, slug: string): Promise<string> {
    const started = await send(browser, {
      method: 'POST',
      url: `/api/v1/me/identities/${slug}/start`,
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.headers['cache-control']).toBe('no-store');
    return oidcLinkStartResponseSchema.parse(started.json()).authorization_url;
  }

  /** `POST /me/identities/:slug/start` → IdP → callback path (not called yet). */
  async function startLink(browser: Browser, slug: string, hint: string): Promise<string> {
    return authorize(await linkUrl(browser, slug), hint);
  }

  async function link(
    browser: Browser,
    slug: string,
    hint: string,
    tweaks?: IdTokenTweaks,
  ): Promise<InjectResponse> {
    const path = await startLink(browser, slug, hint);
    idp.tweaks = tweaks ?? null;
    try {
      return await send(browser, { method: 'GET', url: path });
    } finally {
      idp.tweaks = null;
    }
  }

  async function oidcSignIn(browser: Browser, slug: string, hint: string): Promise<InjectResponse> {
    const started = await send(browser, { method: 'GET', url: `/api/v1/auth/oidc/${slug}/start` });
    const path = await authorize(locationOf(started), hint);
    return send(browser, { method: 'GET', url: path });
  }

  async function listIdentities(browser: Browser) {
    const response = await send(browser, { method: 'GET', url: '/api/v1/me/identities' });
    expect(response.statusCode, response.body).toBe(200);
    return meIdentityListSchema.parse(response.json()).items;
  }

  async function meOf(browser: Browser) {
    const response = await send(browser, { method: 'GET', url: '/api/v1/me' });
    expect(response.statusCode, response.body).toBe(200);
    return meResponseSchema.parse(response.json());
  }

  async function auditOf(action: string, entityId: string) {
    return db.kysely
      .selectFrom('meta.audit_logs')
      .selectAll()
      .where('action', '=', action)
      .where('entity_id', '=', entityId)
      .orderBy('created_at')
      .execute();
  }

  async function newUser(
    options: { readonly password?: string | null; readonly orgs?: Id<'org'>[] } = {},
  ): Promise<SeededUser> {
    return seedUser(db, {
      ...(options.password === undefined ? {} : { password: options.password }),
      memberships: (options.orgs ?? [orgA]).map((orgId) => ({ orgId, role: 'member' as const })),
    });
  }

  /** An OIDC-only user (no password) signed in through `fake`. */
  async function oidcOnlyUser(): Promise<{ user: SeededUser; browser: Browser; sub: string }> {
    const user = await newUser({ password: null });
    const sub = `sub-${randomBytes(4).toString('hex')}`;
    await identities.create({ userId: user.id, provider: 'fake', subject: sub, email: user.email });
    const browser = new Browser(t.app);
    const hint = hintFor({ sub, email: user.email, email_verified: true });
    expect(locationOf(await oidcSignIn(browser, 'fake', hint))).toBe('/');
    return { user, browser, sub };
  }

  /** Makes the first two calls of `method` wait for each other (both pass before either goes on). */
  function barrierOn<T extends object>(
    target: T,
    method: keyof T & string,
    applies: (args: unknown[]) => boolean,
    when: 'before' | 'after',
  ): { restore: () => void; arrived: () => number } {
    const original = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target);
    let arrived = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wait = async (args: unknown[]) => {
      if (applies(args) && arrived < 2) {
        arrived += 1;
        if (arrived === 2) release();
        await barrier;
      }
    };
    const spy = vi.spyOn(target, method as never).mockImplementation((async (
      ...args: unknown[]
    ) => {
      if (when === 'before') await wait(args);
      const result = await original(...args);
      if (when === 'after') await wait(args);
      return result;
    }) as never);
    return {
      restore: () => {
        spy.mockRestore();
      },
      arrived: () => arrived,
    };
  }

  // --- manual linking ------------------------------------------------------------

  it('P63: u_sales1 signs in with the password, links, signs out, signs in with the IdP as u_sales1', async () => {
    const browser = await signedIn(sales);
    const sessionBefore = browser.sessionToken;
    expect(await listIdentities(browser)).toEqual([]);

    const hint = hintFor({
      sub: 'sub-sales',
      email: 'sales.idp@example.test',
      email_verified: true,
    });
    const path = await startLink(browser, 'fake', hint);
    // The provider comes back to the one registered redirect URI.
    expect(path.startsWith('/api/v1/auth/oidc/fake/callback?')).toBe(true);
    const callback = await send(browser, { method: 'GET', url: path });
    expect(locationOf(callback)).toBe('/account/connections');
    expect(callback.headers['cache-control']).toBe('no-store');
    // No new session: the same session goes on.
    const cookies = setCookiesOf(callback);
    expect(cookies.has(SESSION_COOKIE)).toBe(false);
    expect(cookies.get(OIDC_STATE_COOKIE)?.attributes).toContain('Max-Age=0');
    expect(browser.sessionToken).toBe(sessionBefore);
    expect((await meOf(browser)).user.id).toBe(sales.id);

    const linked = await listIdentities(browser);
    expect(linked).toEqual([
      {
        id: expect.stringMatching(/^idn_/) as string,
        provider: 'fake',
        provider_name: 'Fake IdP',
        email: 'sales.idp@example.test',
        created_at: expect.any(String) as string,
        last_login_at: null,
      },
    ]);
    // The subject is never returned.
    expect(JSON.stringify(linked)).not.toContain('sub-sales');

    const audit = await auditOf('auth.identity_linked', sales.id);
    expect(audit.map((row) => row.organization_id).sort()).toEqual([orgA, orgB].sort());
    for (const row of audit) {
      expect(row).toMatchObject({
        actor_type: 'user',
        actor_id: sales.id,
        entity_type: 'user',
        after: { identity_id: linked[0]?.id, provider: 'fake', method: 'manual' },
      });
    }

    expect((await send(browser, { method: 'POST', url: '/api/v1/auth/logout' })).statusCode).toBe(
      204,
    );
    const fresh = new Browser(t.app);
    expect(locationOf(await oidcSignIn(fresh, 'fake', hint))).toBe('/');
    expect((await meOf(fresh)).user.id).toBe(sales.id);
    expect((await listIdentities(fresh))[0]?.last_login_at).not.toBeNull();
  });

  it('P63: the identity of u_editor → IDENTITY_IN_USE, nothing changes', async () => {
    const user = await newUser();
    const browser = await signedIn(user);
    const callback = await link(browser, 'fake', 'editor');
    expect(locationOf(callback)).toBe('/account/connections?error=IDENTITY_IN_USE');
    expect(setCookiesOf(callback).has(SESSION_COOKIE)).toBe(false);
    expect(await identities.listByUser(user.id)).toEqual([]);
    expect((await identities.findByProviderSubject('fake', 'sub-editor'))?.user_id).toBe(editor.id);
    expect(await auditOf('auth.identity_linked', user.id)).toEqual([]);
    expect(t.logs.lines).toContainEqual(
      expect.objectContaining({
        msg: 'oidc link failed',
        result: 'IDENTITY_IN_USE',
        user_id: user.id,
      }),
    );
  });

  it('same provider again: same sub → replaced (email refreshed); another sub → IDENTITY_IN_USE', async () => {
    const user = await newUser();
    const browser = await signedIn(user);
    const sub = `sub-${randomBytes(4).toString('hex')}`;
    const first = hintFor({ sub, email: 'first@example.test', email_verified: true });
    expect(locationOf(await link(browser, 'fake', first))).toBe('/account/connections');
    const [linked] = await listIdentities(browser);

    const again = hintFor({ sub, email: 'second@example.test', email_verified: false });
    expect(locationOf(await link(browser, 'fake', again))).toBe('/account/connections');
    expect(await listIdentities(browser)).toEqual([
      expect.objectContaining({ id: linked?.id, email: 'second@example.test' }),
    ]);

    const otherSub = hintFor({ sub: `${sub}-2`, email: 'x@example.test', email_verified: true });
    expect(locationOf(await link(browser, 'fake', otherSub))).toBe(
      '/account/connections?error=IDENTITY_IN_USE',
    );
    expect(await identities.findByProviderSubject('fake', `${sub}-2`)).toBeUndefined();

    // Another provider is a separate connection.
    const second = hintFor({ sub, email: 'first@example.test', email_verified: true });
    expect(locationOf(await link(browser, 'other', second))).toBe('/account/connections');
    expect((await listIdentities(browser)).map((row) => row.provider_name)).toEqual([
      'Fake IdP',
      'Other IdP',
    ]);
  });

  it('the session changes during the flow → OIDC_STATE_INVALID, nothing linked', async () => {
    const user = await newUser();
    const hint = hintFor({ sub: `sub-${randomBytes(4).toString('hex')}`, email_verified: false });

    // Signed out and in again (new session of the same user).
    const relogged = await signedIn(user);
    const path1 = await startLink(relogged, 'fake', hint);
    await send(relogged, { method: 'POST', url: '/api/v1/auth/logout' });
    expect((await relogged.login(user.email)).statusCode).toBe(204);
    expect(locationOf(await send(relogged, { method: 'GET', url: path1 }))).toBe(
      '/account/connections?error=OIDC_STATE_INVALID',
    );

    // Another user signed in in the same browser.
    const switched = await signedIn(user);
    const path2 = await startLink(switched, 'fake', hint);
    expect((await switched.login(editor.email)).statusCode).toBe(204);
    expect(locationOf(await send(switched, { method: 'GET', url: path2 }))).toBe(
      '/account/connections?error=OIDC_STATE_INVALID',
    );

    // No session at all at the callback.
    const signedOut = await signedIn(user);
    const path3 = await startLink(signedOut, 'fake', hint);
    signedOut.cookies.delete(SESSION_COOKIE);
    const noSession = await send(signedOut, { method: 'GET', url: path3 });
    expect(locationOf(noSession)).toBe('/account/connections?error=OIDC_STATE_INVALID');
    expect(setCookiesOf(noSession).has(SESSION_COOKIE)).toBe(false);

    expect(await identities.listByUser(user.id)).toEqual([]);
    expect(await identities.listByUser(editor.id)).toHaveLength(1);
  });

  it('link start: POST only, session + CSRF — 401 signed out, 403 without CSRF, 404 unknown provider, GET gone', async () => {
    const anonymous = await send(new Browser(t.app), {
      method: 'POST',
      url: '/api/v1/me/identities/fake/start',
    });
    expect(anonymous.statusCode).toBe(401);
    expect(
      (await send(new Browser(t.app), { method: 'GET', url: '/api/v1/me/identities' })).statusCode,
    ).toBe(401);

    const browser = await signedIn(admin);
    const unknown = await send(browser, {
      method: 'POST',
      url: '/api/v1/me/identities/nope/start',
    });
    expect(unknown.statusCode).toBe(404);
    expect(problemOf(unknown.body).code).toBe('NOT_FOUND');
    expect(
      (await send(browser, { method: 'POST', url: '/api/v1/me/identities/Bad_Slug/start' }))
        .statusCode,
    ).toBe(422);

    // A cross-site navigation or form post carries the session cookie but not the CSRF
    // header: neither the old GET nor a POST without `X-CSRF-Token` starts a link.
    const viaGet = await send(browser, { method: 'GET', url: '/api/v1/me/identities/fake/start' });
    expect([404, 405]).toContain(viaGet.statusCode);
    expect(setCookiesOf(viaGet).has(OIDC_STATE_COOKIE)).toBe(false);
    const noCsrf = await send(browser, {
      method: 'POST',
      url: '/api/v1/me/identities/fake/start',
      csrf: false,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(problemOf(noCsrf.body).code).toBe('CSRF_INVALID');
    expect(setCookiesOf(noCsrf).has(OIDC_STATE_COOKIE)).toBe(false);
    const crossSite = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/identities/fake/start',
      headers: {
        cookie: `${SESSION_COOKIE}=${browser.sessionToken ?? ''}`,
        origin: 'https://evil.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '',
      remoteAddress: browser.ip,
    });
    responses.push(crossSite);
    expect(crossSite.statusCode).toBe(403);
    expect(setCookiesOf(crossSite).has(OIDC_STATE_COOKIE)).toBe(false);

    // With CSRF: the authorization URL (max_age=0) and a sealed state cookie for the OIDC routes.
    const started = await send(browser, {
      method: 'POST',
      url: '/api/v1/me/identities/fake/start',
    });
    expect(started.statusCode, started.body).toBe(200);
    const location = new URL(oidcLinkStartResponseSchema.parse(started.json()).authorization_url);
    expect(`${location.origin}${location.pathname}`).toBe(`${idp.issuer}/authorize`);
    expect(location.searchParams.get('redirect_uri')).toBe(
      `${TEST_PUBLIC_URL}/api/v1/auth/oidc/fake/callback`,
    );
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('max_age')).toBe('0');
    expect(setCookiesOf(started).get(OIDC_STATE_COOKIE)?.attributes).toEqual(
      expect.arrayContaining(['Path=/api/v1/auth/oidc/', 'Max-Age=600', 'HttpOnly']),
    );
    expect(setCookiesOf(started).get(OIDC_STATE_COOKIE)?.value).not.toContain(admin.id);
    // Sign-in (not link) requests do not force re-authentication.
    const signInStart = await send(new Browser(t.app), {
      method: 'GET',
      url: '/api/v1/auth/oidc/fake/start',
    });
    expect(new URL(locationOf(signInStart)).searchParams.has('max_age')).toBe(false);

    const created = await send(browser, {
      method: 'POST',
      url: `/api/v1/orgs/${orgA}/me/api-tokens`,
      payload: {
        name: 'linking',
        scopes: ['records:read', 'schema:read'],
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const token = createdApiTokenSchema.parse(created.json()).token;
    for (const [method, url] of [
      ['GET', '/api/v1/me/identities'],
      ['POST', '/api/v1/me/identities/fake/start'],
      ['DELETE', `/api/v1/me/identities/${newId('idn')}`],
    ] as const) {
      const response = await t.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      responses.push(response);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(problemOf(response.body)).toMatchObject({
        code: 'INSUFFICIENT_SCOPE',
        errors: [expect.objectContaining({ params: { required: ['session'] } })],
      });
    }
  });

  it.each<[string, IdTokenTweaks]>([
    ['missing', { authTimeIn: null }],
    ['11 minutes old', { authTimeIn: -660 }],
    ['10 minutes in the future', { authTimeIn: 600 }],
  ])(
    'link: an ID token with auth_time %s → OIDC_PROVIDER_ERROR, nothing linked',
    async (_name, tweaks) => {
      const user = await newUser();
      const browser = await signedIn(user);
      const hint = hintFor({ sub: `sub-${randomBytes(4).toString('hex')}`, email_verified: false });
      expect(locationOf(await link(browser, 'fake', hint, tweaks))).toBe(
        '/account/connections?error=OIDC_PROVIDER_ERROR',
      );
      expect(await identities.listByUser(user.id)).toEqual([]);
      expect(t.logs.lines.filter((line) => line.msg === 'oidc link failed').at(-1)).toMatchObject({
        result: 'OIDC_PROVIDER_ERROR',
        reason: 'id_token_invalid',
        library_code: 'AUTH_TIME',
      });
    },
  );

  it('sign-in (not link) does not require auth_time', async () => {
    const user = await newUser();
    const sub = `sub-${randomBytes(4).toString('hex')}`;
    await identities.create({ userId: user.id, provider: 'fake', subject: sub, email: null });
    const browser = new Browser(t.app);
    const started = await send(browser, { method: 'GET', url: '/api/v1/auth/oidc/fake/start' });
    const path = await authorize(locationOf(started), hintFor({ sub, email_verified: false }));
    idp.tweaks = { authTimeIn: null };
    try {
      expect(locationOf(await send(browser, { method: 'GET', url: path }))).toBe('/');
    } finally {
      idp.tweaks = null;
    }
  });

  // --- unlinking -------------------------------------------------------------------

  it('unlink: the last way to sign in → 422 LAST_LOGIN_METHOD; with another way → 204, audited', async () => {
    const { user, browser } = await oidcOnlyUser();
    const [only] = await listIdentities(browser);
    const refused = await send(browser, {
      method: 'DELETE',
      url: `/api/v1/me/identities/${only?.id ?? ''}`,
    });
    expect(refused.statusCode).toBe(422);
    expect(problemOf(refused.body)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ path: 'userIdentityId', code: 'LAST_LOGIN_METHOD' })],
    });
    expect(await identities.listByUser(user.id)).toHaveLength(1);

    // A second provider: either can go, but not both.
    const hint = hintFor({ sub: `sub-${randomBytes(4).toString('hex')}`, email_verified: false });
    expect(locationOf(await link(browser, 'other', hint))).toBe('/account/connections');
    const both = await listIdentities(browser);
    expect(both).toHaveLength(2);
    const removed = await send(browser, {
      method: 'DELETE',
      url: `/api/v1/me/identities/${only?.id ?? ''}`,
    });
    expect(removed.statusCode).toBe(204);
    const last = both.find((row) => row.id !== only?.id);
    expect(
      (await send(browser, { method: 'DELETE', url: `/api/v1/me/identities/${last?.id ?? ''}` }))
        .statusCode,
    ).toBe(422);

    expect(await auditOf('auth.identity_unlinked', user.id)).toEqual([
      expect.objectContaining({
        organization_id: orgA,
        actor_id: user.id,
        before: { identity_id: only?.id, provider: 'fake' },
        after: null,
      }),
    ]);
  });

  it('unlink: a user with a password removes their only identity; others/unknown → 404; CSRF required', async () => {
    const user = await newUser();
    const browser = await signedIn(user);
    const hint = hintFor({ sub: `sub-${randomBytes(4).toString('hex')}`, email_verified: false });
    expect(locationOf(await link(browser, 'fake', hint))).toBe('/account/connections');
    const [own] = await listIdentities(browser);

    const editorIdentity = await identities.findByProviderSubject('fake', 'sub-editor');
    const foreign = await send(browser, {
      method: 'DELETE',
      url: `/api/v1/me/identities/${editorIdentity?.id ?? ''}`,
    });
    expect(foreign.statusCode).toBe(404);
    expect(await identities.findByProviderSubject('fake', 'sub-editor')).toBeDefined();
    expect(
      (await send(browser, { method: 'DELETE', url: `/api/v1/me/identities/${newId('idn')}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await send(browser, { method: 'DELETE', url: '/api/v1/me/identities/not-an-id' }))
        .statusCode,
    ).toBe(422);
    const noCsrf = await send(browser, {
      method: 'DELETE',
      url: `/api/v1/me/identities/${own?.id ?? ''}`,
      csrf: false,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(problemOf(noCsrf.body).code).toBe('CSRF_INVALID');

    expect(
      (await send(browser, { method: 'DELETE', url: `/api/v1/me/identities/${own?.id ?? ''}` }))
        .statusCode,
    ).toBe(204);
    expect(await listIdentities(browser)).toEqual([]);
    // The password still works.
    expect((await new Browser(t.app).login(user.email)).statusCode).toBe(204);
  });

  // --- linking by email ------------------------------------------------------------

  it('LINK_BY_EMAIL=true + email_verified=false (or "true" as a string) → still OIDC_ACCOUNT_EXISTS', async () => {
    const user = await newUser();
    for (const emailVerified of [false, 'true'] as const) {
      const hint = hintFor({
        sub: `sub-${randomBytes(4).toString('hex')}`,
        email: user.email,
        email_verified: emailVerified,
      });
      const callback = await oidcSignIn(new Browser(t.app), 'mail', hint);
      expect(locationOf(callback)).toBe('/login?error=OIDC_ACCOUNT_EXISTS');
      expect(setCookiesOf(callback).has(SESSION_COOKIE)).toBe(false);
    }
    expect(await identities.listByUser(user.id)).toEqual([]);
    expect(await auditOf('auth.identity_linked', user.id)).toEqual([]);
  });

  it('LINK_BY_EMAIL=true + verified email → signed in as that user, identity linked, audited per organization', async () => {
    const user = await newUser({ orgs: [orgA, orgB] });
    const sub = `sub-${randomBytes(4).toString('hex')}`;
    const hint = hintFor({ sub, email: user.email.toUpperCase(), email_verified: true });
    const browser = new Browser(t.app);
    const callback = await oidcSignIn(browser, 'mail', hint);
    expect(locationOf(callback)).toBe('/');
    expect(setCookiesOf(callback).has(SESSION_COOKIE)).toBe(true);
    expect((await meOf(browser)).user.id).toBe(user.id);

    const identity = await identities.findByProviderSubject('mail', sub);
    expect(identity).toMatchObject({ user_id: user.id, email: user.email.toUpperCase() });
    expect(identity?.last_login_at).toBeInstanceOf(Date);
    const linked = await auditOf('auth.identity_linked', user.id);
    expect(linked.map((row) => row.organization_id).sort()).toEqual([orgA, orgB].sort());
    for (const row of linked) {
      expect(row.after).toEqual({ identity_id: identity?.id, provider: 'mail', method: 'email' });
    }
    const logins = await db.kysely
      .selectFrom('meta.audit_logs')
      .select('after')
      .where('action', '=', 'auth.login')
      .where('actor_id', '=', user.id)
      .execute();
    expect(logins).toContainEqual({
      after: { user_id: user.id, method: 'oidc', provider: 'mail' },
    });

    // Next time: found by (provider, sub), no second link.
    expect(locationOf(await oidcSignIn(new Browser(t.app), 'mail', hint))).toBe('/');
    expect(await auditOf('auth.identity_linked', user.id)).toHaveLength(2);
  });

  it('LINK_BY_EMAIL=true: an account already linked to another sub of the provider is not linked again', async () => {
    const user = await newUser();
    await identities.create({
      userId: user.id,
      provider: 'mail',
      subject: `sub-${randomBytes(4).toString('hex')}`,
      email: user.email,
    });
    const hint = hintFor({
      sub: `sub-${randomBytes(4).toString('hex')}`,
      email: user.email,
      email_verified: true,
    });
    expect(locationOf(await oidcSignIn(new Browser(t.app), 'mail', hint))).toBe(
      '/login?error=OIDC_ACCOUNT_EXISTS',
    );
    expect(await identities.listByUser(user.id)).toHaveLength(1);
  });

  it('LINK_BY_EMAIL=true: a disabled account is not signed in (UNAUTHENTICATED), nothing linked', async () => {
    const user = await newUser();
    await db.kysely
      .updateTable('meta.users')
      .set({ status: 'disabled' })
      .where('id', '=', user.id)
      .execute();
    const hint = hintFor({
      sub: `sub-${randomBytes(4).toString('hex')}`,
      email: user.email,
      email_verified: true,
    });
    expect(locationOf(await oidcSignIn(new Browser(t.app), 'mail', hint))).toBe(
      '/login?error=UNAUTHENTICATED',
    );
    expect(await identities.listByUser(user.id)).toEqual([]);
  });

  // --- invitations and passwords ---------------------------------------------------

  it('an invitation is accepted by an OIDC user like any user → member', async () => {
    const { user, browser } = await oidcOnlyUser();
    const owners = await signedIn(admin);
    const orgC = await seedOrg(db, 'Gamma');
    await new OrgMembersRepository(db).add(orgScope(orgC), admin.id, 'owner');
    const invited = await send(owners, {
      method: 'POST',
      url: `/api/v1/orgs/${orgC}/invitations`,
      payload: { email: user.email },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const token = new URL(createdInvitationSchema.parse(invited.json()).invite_url).pathname
      .split('/')
      .at(-1);
    const accepted = await send(browser, {
      method: 'POST',
      url: `/api/v1/invitations/${token ?? ''}/accept`,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(acceptInvitationResponseSchema.parse(accepted.json())).toMatchObject({
      user: { id: user.id },
      role: 'member',
    });
    expect((await meOf(browser)).orgs.map((org) => org.id)).toContain(orgC);

    // Another OIDC user cannot take an invitation for someone else's email.
    const stranger = await oidcOnlyUser();
    const other = await send(owners, {
      method: 'POST',
      url: `/api/v1/orgs/${orgC}/invitations`,
      payload: { email: 'someone.else@example.test' },
    });
    const otherToken = new URL(createdInvitationSchema.parse(other.json()).invite_url).pathname
      .split('/')
      .at(-1);
    const refused = await send(stranger.browser, {
      method: 'POST',
      url: `/api/v1/invitations/${otherToken ?? ''}/accept`,
    });
    expect(refused.statusCode).toBe(410);
  });

  it('an admin cannot reset the password of an OIDC-only user (422 NO_PASSWORD)', async () => {
    const { user } = await oidcOnlyUser();
    const admins = await signedIn(admin);
    const response = await send(admins, {
      method: 'POST',
      url: `/api/v1/orgs/${orgA}/members/${user.id}/password-reset`,
    });
    expect(response.statusCode).toBe(422);
    expect(problemOf(response.body)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ code: 'NO_PASSWORD' })],
    });
  });

  // --- races -----------------------------------------------------------------------

  it('race: two link callbacks of one user for two subs of one provider → one linked, one IDENTITY_IN_USE', async () => {
    const user = await newUser();
    const first = await signedIn(user);
    const second = await signedIn(user);
    const subs = [0, 1].map(() => `sub-race-${randomBytes(4).toString('hex')}`);
    const paths = await Promise.all([
      startLink(first, 'fake', hintFor({ sub: subs[0] ?? '', email_verified: false })),
      startLink(second, 'fake', hintFor({ sub: subs[1] ?? '', email_verified: false })),
    ]);
    // Both look their identity up (none) before either inserts.
    const barrier = barrierOn(
      t.app.get(UserIdentitiesRepository),
      'findByProviderSubject',
      (args) => subs.includes(args[1] as string),
      'after',
    );
    let results: InjectResponse[];
    try {
      results = await Promise.all([
        send(first, { method: 'GET', url: paths[0] }),
        send(second, { method: 'GET', url: paths[1] }),
      ]);
    } finally {
      barrier.restore();
    }
    expect(barrier.arrived()).toBe(2);
    expect(results.map(locationOf).sort()).toEqual([
      '/account/connections',
      '/account/connections?error=IDENTITY_IN_USE',
    ]);
    expect(await identities.listByUser(user.id)).toHaveLength(1);
  });

  it('race: two users link the same sub at once → one linked, the other IDENTITY_IN_USE (not a 500)', async () => {
    const users = [await newUser(), await newUser()];
    const browsers = [
      await signedIn(users[0] as SeededUser),
      await signedIn(users[1] as SeededUser),
    ];
    const sub = `sub-race-${randomBytes(4).toString('hex')}`;
    const hint = hintFor({ sub, email_verified: false });
    const paths = await Promise.all(browsers.map((browser) => startLink(browser, 'fake', hint)));
    const barrier = barrierOn(
      t.app.get(UserIdentitiesRepository),
      'findByProviderSubject',
      (args) => args[1] === sub,
      'after',
    );
    let results: InjectResponse[];
    try {
      results = await Promise.all(
        browsers.map((browser, index) => send(browser, { method: 'GET', url: paths[index] ?? '' })),
      );
    } finally {
      barrier.restore();
    }
    expect(barrier.arrived()).toBe(2);
    expect(results.map(locationOf).sort()).toEqual([
      '/account/connections',
      '/account/connections?error=IDENTITY_IN_USE',
    ]);
    const rows = await db.kysely
      .selectFrom('meta.user_identities')
      .select('user_id')
      .where('provider', '=', 'fake')
      .where('subject', '=', sub)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('race: unlinking both identities of a user without password at once → one 204, one 422', async () => {
    const { user, browser } = await oidcOnlyUser();
    const hint = hintFor({ sub: `sub-${randomBytes(4).toString('hex')}`, email_verified: false });
    expect(locationOf(await link(browser, 'other', hint))).toBe('/account/connections');
    const both = await listIdentities(browser);
    expect(both).toHaveLength(2);
    const barrier = barrierOn(
      t.app.get(UsersRepository),
      'lockById',
      (args) => args[0] === user.id,
      'before',
    );
    let results: InjectResponse[];
    try {
      results = await Promise.all(
        both.map((row) =>
          send(browser, { method: 'DELETE', url: `/api/v1/me/identities/${row.id}` }),
        ),
      );
    } finally {
      barrier.restore();
    }
    expect(barrier.arrived()).toBe(2);
    expect(results.map((response) => response.statusCode).sort()).toEqual([204, 422]);
    expect(await identities.listByUser(user.id)).toHaveLength(1);
  });

  // --- observability and secrets ---------------------------------------------------

  it('counts link callbacks by provider and result', async () => {
    const { body } = await t.app.get(MetricsService).render();
    expect(body).toMatch(/oidc_callbacks_total\{provider="fake",result="linked"\} \d+/);
    expect(body).toMatch(/oidc_callbacks_total\{provider="fake",result="identity_in_use"\} \d+/);
    expect(body).toMatch(/oidc_callbacks_total\{provider="fake",result="oidc_state_invalid"\} \d+/);
  });

  // Last: every value the fake IdP saw must be absent everywhere.
  it('canary: code, code_verifier, state, nonce, client_secret, ID token never in logs, audit, events, identities or responses', async () => {
    expect(idp.secretsSeen.size).toBeGreaterThan(40);
    const logs = t.logs.raw();
    const audit = JSON.stringify(
      await db.kysely.selectFrom('meta.audit_logs').selectAll().execute(),
    );
    const events = JSON.stringify(await db.kysely.selectFrom('meta.events').selectAll().execute());
    const identityRows = JSON.stringify(
      await db.kysely.selectFrom('meta.user_identities').selectAll().execute(),
    );
    // Responses other than the authorization URLs (which carry `state`/`nonce` by design).
    const answered = JSON.stringify(
      responses
        .filter((response) => {
          const location = response.headers.location;
          const toProvider = typeof location === 'string' && location.startsWith(idp.issuer);
          return !toProvider && !response.body.includes('authorization_url');
        })
        .map((response) => ({
          body: response.body,
          location: response.headers.location ?? null,
          cookies: [...setCookiesOf(response).keys()],
        })),
    );
    for (const secret of idp.secretsSeen) {
      expect(logs.includes(secret), 'logs').toBe(false);
      expect(audit.includes(secret), 'audit').toBe(false);
      expect(events.includes(secret), 'events').toBe(false);
      expect(identityRows.includes(secret), 'identities').toBe(false);
      expect(answered.includes(secret), 'responses').toBe(false);
    }
    expect(logs).not.toContain(idp.clientSecret);
  });
});
