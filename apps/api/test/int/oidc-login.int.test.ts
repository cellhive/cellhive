import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import {
  authProvidersResponseSchema,
  CSRF_COOKIE,
  meResponseSchema,
  OIDC_STATE_COOKIE,
  SESSION_COOKIE,
  setupStatusSchema,
  type Id,
} from '@cellhive/contracts';
import {
  OrganizationsRepository,
  UserIdentitiesRepository,
  UsersRepository,
  type Db,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { OidcClient } from '../../src/common/auth/oidc/oidc-client.js';
import { OidcStateCookie } from '../../src/common/auth/oidc/state-cookie.js';
import { MetricsService } from '../../src/modules/metrics/metrics.service.js';

import { Browser, seedOrg, seedUser, setCookiesOf, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { startFakeOidc, type FakeOidcProvider, type IdTokenTweaks } from './fake-oidc-support.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse as InjectResponse } from 'fastify';

/**
 * Sign-in with OIDC against a fake provider over real HTTP (BACKLOG T707,
 * ADR-36 §3, CONTRACTS §27; matrix P63, sign-in part).
 *
 * Providers of the test app (same fake IdP, different flags):
 * - `fake`: defaults (no sign-up, no linking by email);
 * - `open`: sign-up, domain `example.test` only, joins `autoOrgSlug`;
 * - `link`: `LINK_BY_EMAIL=true` + sign-up (linking: also `oidc-linking.int`, T708);
 * - `ghost`: sign-up, joins an organization that does not exist.
 */
describe('OIDC sign-in (T707)', () => {
  let database: TestDatabase;
  let db: Db;
  let idp: FakeOidcProvider;
  let t: TestApp;
  let orgA: Id<'org'>;
  let autoOrg: Id<'org'>;
  const autoOrgSlug = `oidc-auto-${randomBytes(3).toString('hex')}`;
  let alice: SeededUser;
  let sales: SeededUser;
  let identities: UserIdentitiesRepository;
  let users: UsersRepository;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    idp = await startFakeOidc();
    orgA = await seedOrg(db, 'Alpha');
    autoOrg = (await new OrganizationsRepository(db).create({ name: 'Auto', slug: autoOrgSlug }))
      .id;
    t = await startTestApp({
      DATABASE_URL: database.url,
      // The fake IdP serves http:// (allowed with NODE_ENV=development only).
      NODE_ENV: 'development',
      OIDC_PROVIDERS: 'fake,open,link,ghost',
      ...idp.env('fake', { NAME: 'Fake IdP' }),
      ...idp.env('open', {
        ALLOW_SIGNUP: 'true',
        ALLOWED_DOMAINS: 'example.test',
        AUTO_JOIN_ORG: autoOrgSlug,
      }),
      ...idp.env('link', { LINK_BY_EMAIL: 'true', ALLOW_SIGNUP: 'true' }),
      ...idp.env('ghost', { ALLOW_SIGNUP: 'true', AUTO_JOIN_ORG: 'no-such-org' }),
    });
    identities = new UserIdentitiesRepository(db);
    users = new UsersRepository(db);
    alice = await seedUser(db, {
      email: 'alice@example.test',
      displayName: 'Alice',
      memberships: [{ orgId: orgA, role: 'member' }],
    });
    await identities.create({
      userId: alice.id,
      provider: 'fake',
      subject: 'sub-alice',
      email: 'old-alice@example.test',
    });
    idp.users.set('alice', {
      sub: 'sub-alice',
      email: 'alice@example.test',
      email_verified: true,
      name: 'Alice IdP',
    });
    sales = await seedUser(db, {
      email: 'sales1@example.test',
      memberships: [{ orgId: orgA, role: 'member' }],
    });
  });

  afterAll(async () => {
    await t.close();
    await idp.close();
    await db.destroy();
    await database.drop();
  });

  // --- helpers ---------------------------------------------------------------

  function start(browser: Browser, slug: string, next?: string): Promise<InjectResponse> {
    const query = next === undefined ? '' : `?next=${encodeURIComponent(next)}`;
    return browser.request({ method: 'GET', url: `/api/v1/auth/oidc/${slug}/start${query}` });
  }

  /** Follows the authorization URL at the fake IdP; returns the callback path + query. */
  async function authorize(location: string, hint: string): Promise<string> {
    const url = new URL(location);
    url.searchParams.set('login_hint', hint);
    const response = await fetch(url, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const back = new URL(response.headers.get('location') ?? '');
    expect(back.origin).toBe(new URL(TEST_PUBLIC_URL).origin);
    return `${back.pathname}${back.search}`;
  }

  interface SignIn {
    readonly start: InjectResponse;
    readonly callbackPath: string;
    readonly callback: InjectResponse;
  }

  async function signIn(
    browser: Browser,
    slug: string,
    hint: string,
    options: { readonly next?: string; readonly tweaks?: IdTokenTweaks } = {},
  ): Promise<SignIn> {
    const started = await start(browser, slug, options.next);
    expect(started.statusCode).toBe(302);
    const callbackPath = await authorize(started.headers.location as string, hint);
    idp.tweaks = options.tweaks ?? null;
    const callback = await browser.request({ method: 'GET', url: callbackPath });
    idp.tweaks = null;
    return { start: started, callbackPath, callback };
  }

  function locationOf(response: InjectResponse): string {
    expect(response.statusCode).toBe(302);
    return response.headers.location as string;
  }

  function expectNoSession(response: InjectResponse): void {
    const cookies = setCookiesOf(response);
    expect(cookies.has(SESSION_COOKIE)).toBe(false);
    expect(cookies.has(CSRF_COOKIE)).toBe(false);
  }

  async function auditOf(action: string) {
    return db.kysely
      .selectFrom('meta.audit_logs')
      .selectAll()
      .where('action', '=', action)
      .orderBy('created_at')
      .execute();
  }

  function newUserHint(user: Parameters<FakeOidcProvider['users']['set']>[1]): string {
    const hint = `hint-${randomBytes(4).toString('hex')}`;
    idp.users.set(hint, user);
    return hint;
  }

  // --- providers ---------------------------------------------------------------

  it('lists the providers publicly, also in GET /setup', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
    expect(response.statusCode).toBe(200);
    expect(authProvidersResponseSchema.parse(response.json())).toEqual({
      providers: [
        { slug: 'fake', name: 'Fake IdP' },
        { slug: 'open', name: 'open' },
        { slug: 'link', name: 'link' },
        { slug: 'ghost', name: 'ghost' },
      ],
      password_login: true,
    });
    const setup = await t.app.inject({ method: 'GET', url: '/api/v1/setup' });
    expect(setupStatusSchema.parse(setup.json()).auth_config.providers).toHaveLength(4);
  });

  // --- start -------------------------------------------------------------------

  it('start: redirects to the provider with code + PKCE S256 + state + nonce, in a sealed cookie', async () => {
    const browser = new Browser(t.app);
    const response = await start(browser, 'fake', '/o/acme');
    const location = new URL(locationOf(response));
    expect(`${location.origin}${location.pathname}`).toBe(`${idp.issuer}/authorize`);
    const params = location.searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe(idp.clientId);
    expect(params.get('redirect_uri')).toBe(`${TEST_PUBLIC_URL}/api/v1/auth/oidc/fake/callback`);
    expect(params.get('scope')).toBe('openid email profile');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = params.get('state') ?? '';
    const nonce = params.get('nonce') ?? '';
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).not.toBe(state);
    expect(response.headers['cache-control']).toBe('no-store');

    const cookie = setCookiesOf(response).get(OIDC_STATE_COOKIE);
    expect(cookie?.attributes).toEqual(
      expect.arrayContaining([
        'Path=/api/v1/auth/oidc/',
        'Max-Age=600',
        'SameSite=Lax',
        'HttpOnly',
      ]),
    );
    // Encrypted: neither the state, the nonce nor `next` are readable.
    const raw = Buffer.from(cookie?.value ?? '', 'base64url').toString('latin1');
    expect(raw).not.toContain(state);
    expect(raw).not.toContain(nonce);
    expect(raw).not.toContain('/o/acme');
  });

  it('start: unknown provider → 404; malformed slug → 422', async () => {
    const browser = new Browser(t.app);
    const unknown = await start(browser, 'nope');
    expect(unknown.statusCode).toBe(404);
    expect(problemOf(unknown.body).code).toBe('NOT_FOUND');
    const callback = await browser.request({
      method: 'GET',
      url: '/api/v1/auth/oidc/nope/callback?code=x&state=y',
    });
    expect(callback.statusCode).toBe(404);
    expect((await start(browser, 'Bad_Slug')).statusCode).toBe(422);
  });

  it('start: 20 per minute per IP, then back to /login?error=RATE_LIMITED', async () => {
    const browser = new Browser(t.app);
    for (let index = 0; index < 20; index += 1) {
      expect(new URL(locationOf(await start(browser, 'fake'))).origin).toBe(idp.issuer);
    }
    const limited = await start(browser, 'fake');
    expect(locationOf(limited)).toBe('/login?error=RATE_LIMITED');
    expect(setCookiesOf(limited).has(OIDC_STATE_COOKIE)).toBe(false);
  });

  // --- existing identity ---------------------------------------------------------

  it('existing identity → session, 302 next, identity updated, auth.login audited', async () => {
    const browser = new Browser(t.app);
    const { callback } = await signIn(browser, 'fake', 'alice', { next: '/o/acme?x=1#y' });
    expect(locationOf(callback)).toBe('/o/acme?x=1#y');
    expect(callback.headers['cache-control']).toBe('no-store');
    const cookies = setCookiesOf(callback);
    expect(cookies.get(SESSION_COOKIE)?.attributes).toContain('HttpOnly');
    expect(cookies.get(CSRF_COOKIE)).toBeDefined();
    // The state cookie is cleared (one use).
    expect(cookies.get(OIDC_STATE_COOKIE)?.attributes).toEqual(
      expect.arrayContaining(['Path=/api/v1/auth/oidc/', 'Max-Age=0']),
    );

    const me = await browser.request({ method: 'GET', url: '/api/v1/me' });
    expect(me.statusCode).toBe(200);
    expect(meResponseSchema.parse(me.json()).user.id).toBe(alice.id);

    const identity = await identities.findByProviderSubject('fake', 'sub-alice');
    expect(identity?.email).toBe('alice@example.test');
    expect(identity?.last_login_at).toBeInstanceOf(Date);
    // The account itself is not changed by the claims.
    expect((await users.findById(alice.id))?.display_name).toBe('Alice');

    const logins = (await auditOf('auth.login')).filter((row) => row.actor_id === alice.id);
    expect(logins.at(-1)).toMatchObject({
      organization_id: orgA,
      entity_type: 'session',
      after: { user_id: alice.id, method: 'oidc', provider: 'fake' },
    });
  });

  it.each([
    ['https://evil.test', '/'],
    ['//evil.test/x', '/'],
    ['/\\evil.test', '/'],
    ['/login?next=/x', '/'],
    ['/api/v1/me', '/'],
    ['javascript:alert(1)', '/'],
    // Dot segments that normalise into `//evil.test`.
    ['/.//evil.test', '/'],
    ['/a/..//evil.test', '/'],
    ['/%2e//evil.test', '/'],
    ['/%2E//evil.test', '/'],
    ['/./\\evil.test', '/'],
    ['/..//evil.test', '/'],
    ['/b/bse_1', '/b/bse_1'],
  ])('P63: next=%j → 302 %s', async (next, expected) => {
    const { callback } = await signIn(new Browser(t.app), 'fake', 'alice', { next });
    expect(locationOf(callback)).toBe(expected);
  });

  it('rotates the session: a session sent with the callback is revoked', async () => {
    const browser = new Browser(t.app);
    expect((await browser.login(sales.email)).statusCode).toBe(204);
    const before = await db.kysely
      .selectFrom('meta.sessions')
      .select('id')
      .where('user_id', '=', sales.id)
      .execute();
    expect(before).toHaveLength(1);
    await signIn(browser, 'fake', 'alice');
    const after = await db.kysely
      .selectFrom('meta.sessions')
      .select('id')
      .where('user_id', '=', sales.id)
      .execute();
    expect(after).toEqual([]);
  });

  it('a disabled user does not get in (UNAUTHENTICATED)', async () => {
    const user = await seedUser(db, { email: 'disabled@example.test' });
    await identities.create({ userId: user.id, provider: 'fake', subject: 'sub-off', email: null });
    await db.kysely
      .updateTable('meta.users')
      .set({ status: 'disabled' })
      .where('id', '=', user.id)
      .execute();
    const hint = newUserHint({ sub: 'sub-off', email: user.email, email_verified: true });
    const { callback } = await signIn(new Browser(t.app), 'fake', hint);
    expect(locationOf(callback)).toBe('/login?error=UNAUTHENTICATED');
    expectNoSession(callback);
    const failed = (await auditOf('auth.login_failed')).filter((row) => row.entity_id === user.id);
    expect(failed.at(-1)?.after).toEqual({
      reason: 'UNAUTHENTICATED',
      method: 'oidc',
      provider: 'fake',
    });
  });

  // --- state ---------------------------------------------------------------------

  it('P63: state: wrong value, missing cookie, replay, expiry, other provider → OIDC_STATE_INVALID', async () => {
    // Wrong `state`.
    const wrong = new Browser(t.app);
    const started = await start(wrong, 'fake');
    const path = await authorize(started.headers.location as string, 'alice');
    const tampered = new URL(path, TEST_PUBLIC_URL);
    tampered.searchParams.set('state', 'A'.repeat(43));
    const wrongState = await wrong.request({
      method: 'GET',
      url: `${tampered.pathname}${tampered.search}`,
    });
    expect(locationOf(wrongState)).toBe('/login?error=OIDC_STATE_INVALID');
    expectNoSession(wrongState);
    expect(setCookiesOf(wrongState).get(OIDC_STATE_COOKIE)?.attributes).toContain('Max-Age=0');
    // The cookie was cleared: the right state does not work afterwards either.
    const afterClear = await wrong.request({ method: 'GET', url: path });
    expect(locationOf(afterClear)).toBe('/login?error=OIDC_STATE_INVALID');

    // No cookie at all (another browser).
    const other = await start(new Browser(t.app), 'fake');
    const otherPath = await authorize(other.headers.location as string, 'alice');
    const noCookie = await new Browser(t.app).request({ method: 'GET', url: otherPath });
    expect(locationOf(noCookie)).toBe('/login?error=OIDC_STATE_INVALID');

    // Replay of a successful callback: the cookie is gone.
    const browser = new Browser(t.app);
    const done = await signIn(browser, 'fake', 'alice');
    expect(locationOf(done.callback)).toBe('/');
    browser.cookies.delete(SESSION_COOKIE);
    const replay = await browser.request({ method: 'GET', url: done.callbackPath });
    expect(locationOf(replay)).toBe('/login?error=OIDC_STATE_INVALID');
    expectNoSession(replay);
    // Even with the old cookie sent again, the code is spent at the provider.
    const cookieValue = setCookiesOf(done.start).get(OIDC_STATE_COOKIE)?.value ?? '';
    const resent = await t.app.inject({
      method: 'GET',
      url: done.callbackPath,
      headers: { cookie: `${OIDC_STATE_COOKIE}=${cookieValue}` },
      remoteAddress: browser.ip,
    });
    expect(locationOf(resent)).toBe('/login?error=OIDC_PROVIDER_ERROR');
    expectNoSession(resent);

    // Expired cookie (10 minutes).
    const stateCookie = t.app.get(OidcStateCookie);
    const late = new Browser(t.app);
    const lateStart = await start(late, 'fake');
    const latePath = await authorize(lateStart.headers.location as string, 'alice');
    stateCookie.now = () => Date.now() + 601_000;
    try {
      const expired = await late.request({ method: 'GET', url: latePath });
      expect(locationOf(expired)).toBe('/login?error=OIDC_STATE_INVALID');
    } finally {
      stateCookie.now = () => Date.now();
    }

    // A cookie of another provider.
    const mixed = new Browser(t.app);
    const mixedStart = await start(mixed, 'open');
    const mixedPath = await authorize(mixedStart.headers.location as string, 'alice');
    const misrouted = await mixed.request({
      method: 'GET',
      url: mixedPath.replace('/oidc/open/', '/oidc/fake/'),
    });
    expect(locationOf(misrouted)).toBe('/login?error=OIDC_STATE_INVALID');
  });

  it('an error from the provider → OIDC_PROVIDER_ERROR, its description never reflected', async () => {
    const browser = new Browser(t.app);
    const started = await start(browser, 'fake');
    idp.authorizeError = { error: 'access_denied', description: 'canary-description-7f3a' };
    const path = await authorize(started.headers.location as string, 'alice');
    const callback = await browser.request({ method: 'GET', url: path });
    expect(locationOf(callback)).toBe('/login?error=OIDC_PROVIDER_ERROR');
    expectNoSession(callback);
    expect(t.logs.raw()).not.toContain('canary-description-7f3a');
    expect(t.logs.lines).toContainEqual(
      expect.objectContaining({ result: 'OIDC_PROVIDER_ERROR', oauth_error: 'access_denied' }),
    );
  });

  // --- ID token validation -------------------------------------------------------

  it.each<[string, () => IdTokenTweaks, string]>([
    ['nonce', () => ({ nonce: 'not-the-nonce' }), 'id_token_invalid'],
    ['iss', () => ({ iss: 'https://evil.test' }), 'id_token_invalid'],
    ['aud', () => ({ aud: 'another-client' }), 'id_token_invalid'],
    ['several aud without azp', () => ({ aud: [idp.clientId, 'other'] }), 'id_token_invalid'],
    [
      'several aud, azp of another client',
      () => ({ aud: [idp.clientId, 'other'], azp: 'other' }),
      'id_token_invalid',
    ],
    ['exp', () => ({ expIn: -120 }), 'id_token_invalid'],
    ['iat (10 minutes old)', () => ({ iatIn: -600 }), 'id_token_invalid'],
    ['signature', () => ({ badSignature: true }), 'signature_invalid'],
  ])('a wrong ID token (%s) → OIDC_PROVIDER_ERROR, no session', async (_name, tweaks, reason) => {
    const { callback } = await signIn(new Browser(t.app), 'fake', 'alice', { tweaks: tweaks() });
    expect(locationOf(callback)).toBe('/login?error=OIDC_PROVIDER_ERROR');
    expectNoSession(callback);
    const failures = t.logs.lines.filter((line) => line.msg === 'oidc sign-in failed');
    expect(failures.at(-1)).toMatchObject({ provider: 'fake', reason });
  });

  it('accepts several audiences when azp is the client', async () => {
    const { callback } = await signIn(new Browser(t.app), 'fake', 'alice', {
      tweaks: { aud: [idp.clientId, 'another'], azp: idp.clientId },
    });
    expect(locationOf(callback)).toBe('/');
  });

  it('key rotation: an unknown kid reloads the JWKS; metadata and JWKS are cached', async () => {
    const browser = new Browser(t.app);
    expect(locationOf((await signIn(browser, 'fake', 'alice')).callback)).toBe('/');
    const discoveries = idp.count('/.well-known/openid-configuration');
    const jwksLoads = idp.count('/jwks');
    expect(locationOf((await signIn(browser, 'fake', 'alice')).callback)).toBe('/');
    expect(idp.count('/jwks')).toBe(jwksLoads);

    idp.rotateKey();
    expect(locationOf((await signIn(browser, 'fake', 'alice')).callback)).toBe('/');
    expect(idp.count('/jwks')).toBe(jwksLoads + 1);
    // One discovery per provider for the whole run (cached 1 hour).
    expect(idp.count('/.well-known/openid-configuration')).toBe(discoveries);

    // After an hour the metadata is discovered again.
    const client = t.app.get(OidcClient);
    client.now = () => Date.now() + 3_601_000;
    try {
      const later = await signIn(browser, 'fake', 'alice', {
        // `iat` is checked against the moved clock.
        tweaks: { iatIn: 3_601, expIn: 3_900 },
      });
      expect(locationOf(later.callback)).toBe('/');
      expect(idp.count('/.well-known/openid-configuration')).toBe(discoveries + 1);
    } finally {
      client.now = () => Date.now();
    }
  });

  // --- unknown identity ------------------------------------------------------------

  it('P63: email of an existing user, LINK_BY_EMAIL=false → OIDC_ACCOUNT_EXISTS, no identity, no session', async () => {
    const hint = newUserHint({
      sub: 'sub-sales',
      email: 'SALES1@example.test',
      email_verified: true,
    });
    const { callback } = await signIn(new Browser(t.app), 'fake', hint);
    expect(locationOf(callback)).toBe('/login?error=OIDC_ACCOUNT_EXISTS');
    expectNoSession(callback);
    expect(await identities.findByProviderSubject('fake', 'sub-sales')).toBeUndefined();
    expect(await identities.listByUser(sales.id)).toEqual([]);
    const failed = (await auditOf('auth.login_failed')).filter((row) => row.entity_id === sales.id);
    expect(failed.at(-1)).toMatchObject({
      organization_id: orgA,
      after: { reason: 'OIDC_ACCOUNT_EXISTS', method: 'oidc', provider: 'fake' },
    });
  });

  it('P63: LINK_BY_EMAIL=true + email_verified=false → OIDC_ACCOUNT_EXISTS (no takeover)', async () => {
    const hint = newUserHint({ sub: 'sub-sales-2', email: sales.email, email_verified: false });
    const { callback } = await signIn(new Browser(t.app), 'link', hint);
    expect(locationOf(callback)).toBe('/login?error=OIDC_ACCOUNT_EXISTS');
    expectNoSession(callback);
    expect(await identities.listByUser(sales.id)).toEqual([]);
  });

  it('LINK_BY_EMAIL=true + verified email: linked to that user and signed in (T708)', async () => {
    const hint = newUserHint({ sub: 'sub-sales-3', email: sales.email, email_verified: true });
    const browser = new Browser(t.app);
    const { callback } = await signIn(browser, 'link', hint);
    expect(locationOf(callback)).toBe('/');
    const me = await browser.request({ method: 'GET', url: '/api/v1/me' });
    expect(meResponseSchema.parse(me.json()).user.id).toBe(sales.id);
    expect(await identities.listByUser(sales.id)).toEqual([
      expect.objectContaining({ provider: 'link', subject: 'sub-sales-3' }),
    ]);
  });

  it('P63: ALLOW_SIGNUP=false → OIDC_SIGNUP_DISABLED, no account', async () => {
    const hint = newUserHint({
      sub: 'sub-new-1',
      email: 'new1@example.test',
      email_verified: true,
    });
    const { callback } = await signIn(new Browser(t.app), 'fake', hint);
    expect(locationOf(callback)).toBe('/login?error=OIDC_SIGNUP_DISABLED');
    expectNoSession(callback);
    expect(await users.findByEmail('new1@example.test')).toBeUndefined();
  });

  it.each<[string, Parameters<FakeOidcProvider['users']['set']>[1], string]>([
    [
      'email outside ALLOWED_DOMAINS',
      { sub: 'sub-d', email: 'x@other.test', email_verified: true },
      'OIDC_DOMAIN_NOT_ALLOWED',
    ],
    [
      'subdomain of an allowed domain',
      { sub: 'sub-d2', email: 'x@sub.example.test', email_verified: true },
      'OIDC_DOMAIN_NOT_ALLOWED',
    ],
    [
      'email_verified=false',
      { sub: 'sub-u', email: 'u1@example.test', email_verified: false },
      'OIDC_EMAIL_UNVERIFIED',
    ],
    [
      'email_verified="true" (a string)',
      { sub: 'sub-u2', email: 'u2@example.test', email_verified: 'true' },
      'OIDC_EMAIL_UNVERIFIED',
    ],
    ['no email', { sub: 'sub-u3' }, 'OIDC_EMAIL_UNVERIFIED'],
  ])('sign-up refused: %s → %s', async (_name, user, error) => {
    const { callback } = await signIn(new Browser(t.app), 'open', newUserHint(user));
    expect(locationOf(callback)).toBe(`/login?error=${error}`);
    expectNoSession(callback);
    expect(await identities.findByProviderSubject('open', user.sub)).toBeUndefined();
  });

  it('sign-up: account without password + identity + AUTO_JOIN_ORG member, audited', async () => {
    const hint = newUserHint({
      sub: 'sub-jit',
      email: 'Jit.User@Example.test',
      email_verified: true,
      preferred_username: 'jit',
    });
    const browser = new Browser(t.app);
    const { callback } = await signIn(browser, 'open', hint, { next: '/o/auto' });
    expect(locationOf(callback)).toBe('/o/auto');
    expect(setCookiesOf(callback).has(SESSION_COOKIE)).toBe(true);

    const user = await users.findByEmail('jit.user@example.test');
    expect(user).toMatchObject({
      display_name: 'jit',
      password_hash: null,
      locale: null,
      timezone: null,
      status: 'active',
    });
    const identity = await identities.findByProviderSubject('open', 'sub-jit');
    expect(identity).toMatchObject({ user_id: user?.id, email: 'Jit.User@Example.test' });
    expect(identity?.last_login_at).toBeInstanceOf(Date);

    const me = meResponseSchema.parse(
      (await browser.request({ method: 'GET', url: '/api/v1/me' })).json(),
    );
    expect(me.orgs).toEqual([expect.objectContaining({ id: autoOrg, role: 'member' })]);

    expect((await auditOf('user.created')).filter((row) => row.entity_id === user?.id)).toEqual([
      expect.objectContaining({
        organization_id: autoOrg,
        actor_type: 'user',
        actor_id: user?.id,
        after: {
          email: 'Jit.User@Example.test',
          display_name: 'jit',
          method: 'oidc',
          provider: 'open',
        },
      }),
    ]);
    expect((await auditOf('org_member.added')).filter((row) => row.entity_id === user?.id)).toEqual(
      [
        expect.objectContaining({
          organization_id: autoOrg,
          after: { user_id: user?.id, role: 'member', method: 'oidc', provider: 'open' },
        }),
      ],
    );
    const events = await db.kysely
      .selectFrom('meta.events')
      .select(['type', 'organization_id'])
      .where('entity_id', '=', user?.id ?? '')
      .execute();
    expect(events).toContainEqual({ type: 'org_member.added', organization_id: autoOrg });
    expect((await auditOf('auth.login')).filter((row) => row.actor_id === user?.id)).toContainEqual(
      expect.objectContaining({ organization_id: autoOrg }),
    );

    // Next time the identity is found by (provider, sub), whatever the email says.
    idp.users.set(hint, { sub: 'sub-jit', email: 'renamed@example.test', email_verified: false });
    const again = await signIn(new Browser(t.app), 'open', hint);
    expect(locationOf(again.callback)).toBe('/');
    expect((await identities.findByProviderSubject('open', 'sub-jit'))?.email).toBe(
      'renamed@example.test',
    );
  });

  it('display name: name, else preferred_username, else the part before @', async () => {
    const named = newUserHint({
      sub: 'sub-n1',
      email: 'n1@example.test',
      email_verified: true,
      name: 'Nguyễn Văn A',
      preferred_username: 'nva',
    });
    const bare = newUserHint({
      sub: 'sub-n2',
      email: 'bare.name@example.test',
      email_verified: true,
    });
    await signIn(new Browser(t.app), 'open', named);
    await signIn(new Browser(t.app), 'open', bare);
    expect((await users.findByEmail('n1@example.test'))?.display_name).toBe('Nguyễn Văn A');
    expect((await users.findByEmail('bare.name@example.test'))?.display_name).toBe('bare.name');
  });

  it('two parallel callbacks for the same new sub: one account, one identity, both signed in', async () => {
    const sub = `sub-race-${randomBytes(3).toString('hex')}`;
    const email = `${sub}@example.test`;
    const hint = newUserHint({ sub, email, email_verified: true });
    const first = new Browser(t.app);
    const second = new Browser(t.app);
    const paths = await Promise.all(
      [first, second].map(async (browser) => {
        const started = await start(browser, 'open');
        return authorize(started.headers.location as string, hint);
      }),
    );

    // Both callbacks look the identity up before either creates it: the
    // second insert then hits the unique constraints and is decided again.
    const repository = t.app.get(UserIdentitiesRepository);
    const original = repository.findByProviderSubject.bind(repository);
    let arrived = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(repository, 'findByProviderSubject')
      .mockImplementation(async (...args: Parameters<typeof original>) => {
        const found = await original(...args);
        if (args[1] === sub && arrived < 2) {
          arrived += 1;
          if (arrived === 2) release();
          await barrier;
        }
        return found;
      });
    let responses: InjectResponse[];
    try {
      responses = await Promise.all([
        first.request({ method: 'GET', url: paths[0] ?? '' }),
        second.request({ method: 'GET', url: paths[1] ?? '' }),
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(arrived).toBe(2);

    for (const response of responses) {
      expect(locationOf(response)).toBe('/');
      expect(setCookiesOf(response).has(SESSION_COOKIE)).toBe(true);
    }
    const created = await db.kysely
      .selectFrom('meta.users')
      .select('id')
      .where('email', '=', email)
      .execute();
    expect(created).toHaveLength(1);
    const identityRows = await db.kysely
      .selectFrom('meta.user_identities')
      .select('user_id')
      .where('provider', '=', 'open')
      .where('subject', '=', sub)
      .execute();
    expect(identityRows).toEqual([{ user_id: created[0]?.id }]);
  });

  it('two parallel callbacks for the same new sub that both miss the email: the second insert hits the unique violation and its retry signs in', async () => {
    const sub = `sub-race4-${randomBytes(3).toString('hex')}`;
    const email = `${sub}@example.test`;
    const hint = newUserHint({ sub, email, email_verified: true });
    const first = new Browser(t.app);
    const second = new Browser(t.app);
    const paths = await Promise.all(
      [first, second].map(async (browser) => {
        const started = await start(browser, 'open');
        return authorize(started.headers.location as string, hint);
      }),
    );

    // Both callbacks miss the identity and the email before either inserts:
    // the second `users.create` waits on the first insert, then fails with
    // 23505 once it commits; the callback decides again and signs in.
    const usersRepository = t.app.get(UsersRepository);
    const originalFind = usersRepository.findByEmail.bind(usersRepository);
    let arrived = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const find = vi
      .spyOn(usersRepository, 'findByEmail')
      .mockImplementation(async (...args: Parameters<typeof originalFind>) => {
        const found = await originalFind(...args);
        if (args[0] === email && arrived < 2) {
          arrived += 1;
          if (arrived === 2) release();
          await barrier;
        }
        return found;
      });
    const originalCreate = usersRepository.create.bind(usersRepository);
    const violations: string[] = [];
    const create = vi
      .spyOn(usersRepository, 'create')
      .mockImplementation(async (...args: Parameters<typeof originalCreate>) => {
        try {
          return await originalCreate(...args);
        } catch (error) {
          violations.push(String((error as { code?: unknown }).code));
          throw error;
        }
      });
    let responses: InjectResponse[];
    try {
      responses = await Promise.all([
        first.request({ method: 'GET', url: paths[0] ?? '' }),
        second.request({ method: 'GET', url: paths[1] ?? '' }),
      ]);
    } finally {
      find.mockRestore();
      create.mockRestore();
    }
    expect(arrived).toBe(2);
    // The path under test: exactly one unique violation, then the retry.
    expect(violations).toEqual(['23505']);

    for (const response of responses) {
      expect(locationOf(response)).toBe('/');
      expect(setCookiesOf(response).has(SESSION_COOKIE)).toBe(true);
    }
    const created = await db.kysely
      .selectFrom('meta.users')
      .select('id')
      .where('email', '=', email)
      .execute();
    expect(created).toHaveLength(1);
    const identityRows = await db.kysely
      .selectFrom('meta.user_identities')
      .select('user_id')
      .where('provider', '=', 'open')
      .where('subject', '=', sub)
      .execute();
    expect(identityRows).toEqual([{ user_id: created[0]?.id }]);
  });

  it('a parallel callback for the same new sub that commits between the lookups of the other: both signed in to one account', async () => {
    const sub = `sub-race3-${randomBytes(3).toString('hex')}`;
    const email = `${sub}@example.test`;
    const hint = newUserHint({ sub, email, email_verified: true });
    const first = new Browser(t.app);
    const second = new Browser(t.app);
    const paths = await Promise.all(
      [first, second].map(async (browser) => {
        const started = await start(browser, 'open');
        return authorize(started.headers.location as string, hint);
      }),
    );

    // Both callbacks miss the identity; the first then creates the account
    // and commits before the second looks the email up, so the second sees
    // the new user (READ COMMITTED) with no unique violation to retry on.
    const repository = t.app.get(UserIdentitiesRepository);
    const original = repository.findByProviderSubject.bind(repository);
    let firstDone: () => void = () => undefined;
    const firstFinished = new Promise<void>((resolve) => {
      firstDone = resolve;
    });
    let releaseFirst: () => void = () => undefined;
    const secondLookedUp = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let arrived = 0;
    const spy = vi
      .spyOn(repository, 'findByProviderSubject')
      .mockImplementation(async (...args: Parameters<typeof original>) => {
        const found = await original(...args);
        if (args[1] === sub && arrived < 2) {
          arrived += 1;
          if (arrived === 1) {
            await secondLookedUp;
          } else {
            releaseFirst();
            await firstFinished;
          }
        }
        return found;
      });
    let responses: InjectResponse[];
    try {
      const requests = [
        first.request({ method: 'GET', url: paths[0] ?? '' }),
        second.request({ method: 'GET', url: paths[1] ?? '' }),
      ];
      for (const request of requests) void request.then(firstDone, firstDone);
      responses = await Promise.all(requests);
    } finally {
      spy.mockRestore();
    }
    expect(arrived).toBe(2);

    for (const response of responses) {
      expect(locationOf(response)).toBe('/');
      expect(setCookiesOf(response).has(SESSION_COOKIE)).toBe(true);
    }
    const created = await db.kysely
      .selectFrom('meta.users')
      .select('id')
      .where('email', '=', email)
      .execute();
    expect(created).toHaveLength(1);
    const identityRows = await db.kysely
      .selectFrom('meta.user_identities')
      .select('user_id')
      .where('provider', '=', 'open')
      .where('subject', '=', sub)
      .execute();
    expect(identityRows).toEqual([{ user_id: created[0]?.id }]);
  });

  it('a unique violation again after the retry → OIDC_PROVIDER_ERROR, audited and logged, not a 500', async () => {
    const hint = newUserHint({
      sub: `sub-race2-${randomBytes(3).toString('hex')}`,
      email: `race2-${randomBytes(3).toString('hex')}@example.test`,
      email_verified: true,
    });
    const duplicate = () => Object.assign(new Error('duplicate key value'), { code: '23505' });
    const spy = vi
      .spyOn(t.app.get(UsersRepository), 'create')
      .mockRejectedValueOnce(duplicate())
      .mockRejectedValueOnce(duplicate());
    let callback: InjectResponse;
    let calls: number;
    try {
      ({ callback } = await signIn(new Browser(t.app), 'open', hint));
    } finally {
      calls = spy.mock.calls.length;
      spy.mockRestore();
    }
    expect(calls).toBe(2);
    expect(locationOf(callback)).toBe('/login?error=OIDC_PROVIDER_ERROR');
    expectNoSession(callback);
    expect((await auditOf('auth.login_failed')).at(-1)?.after).toEqual({
      reason: 'OIDC_PROVIDER_ERROR',
      method: 'oidc',
      provider: 'open',
    });
    expect(t.logs.lines.filter((line) => line.msg === 'oidc sign-in failed').at(-1)).toMatchObject({
      provider: 'open',
      result: 'OIDC_PROVIDER_ERROR',
      reason: 'concurrent_sign_in',
    });
  });

  it('AUTO_JOIN_ORG of a missing organization: account created without membership, logged', async () => {
    const hint = newUserHint({ sub: 'sub-ghost', email: 'ghost@else.test', email_verified: true });
    const { callback } = await signIn(new Browser(t.app), 'ghost', hint);
    expect(locationOf(callback)).toBe('/');
    const user = await users.findByEmail('ghost@else.test');
    expect(user).toBeDefined();
    const memberships = await db.kysely
      .selectFrom('meta.org_members')
      .select('organization_id')
      .where('user_id', '=', user?.id ?? 'usr_x')
      .execute();
    expect(memberships).toEqual([]);
    expect((await auditOf('user.created')).filter((row) => row.entity_id === user?.id)).toEqual([
      expect.objectContaining({ organization_id: null }),
    ]);
    expect(t.logs.lines).toContainEqual(
      expect.objectContaining({ provider: 'ghost', auto_join_org: 'no-such-org' }),
    );
  });

  // --- observability and secrets ---------------------------------------------------

  it('counts callbacks by provider and result', async () => {
    const { body } = await t.app.get(MetricsService).render();
    expect(body).toMatch(/oidc_callbacks_total\{provider="fake",result="success"\} \d+/);
    expect(body).toMatch(/oidc_callbacks_total\{provider="fake",result="oidc_state_invalid"\} \d+/);
    expect(body).toMatch(
      /oidc_callbacks_total\{provider="open",result="oidc_domain_not_allowed"\}/,
    );
  });

  // Last: every value the fake IdP saw so far must be absent everywhere.
  it('canary: code, code_verifier, state, nonce, client_secret, tokens never in logs, audit, events or errors', async () => {
    expect(idp.secretsSeen.size).toBeGreaterThan(50);
    const logs = t.logs.raw();
    const audit = JSON.stringify(
      await db.kysely.selectFrom('meta.audit_logs').selectAll().execute(),
    );
    const events = JSON.stringify(await db.kysely.selectFrom('meta.events').selectAll().execute());
    const identityRows = JSON.stringify(
      await db.kysely.selectFrom('meta.user_identities').selectAll().execute(),
    );
    for (const secret of idp.secretsSeen) {
      expect(logs.includes(secret), 'logs').toBe(false);
      expect(audit.includes(secret), 'audit').toBe(false);
      expect(events.includes(secret), 'events').toBe(false);
      expect(identityRows.includes(secret), 'identities').toBe(false);
    }
    expect(logs).not.toContain(idp.clientSecret);
  });
});
