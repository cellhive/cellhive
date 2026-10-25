import {
  createdApiTokenSchema,
  passwordResetLinkSchema,
  REALTIME_CLOSE_CODES,
  type ApiTokenScope,
  type CreatedApiToken,
  type Id,
} from '@cellhive/contracts';
import {
  ApiTokensRepository,
  OrgMembersRepository,
  orgScope,
  PasswordResetLinks,
  PasswordResetsRepository,
  type Db,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser, PASSWORD, seedOrg, uniqueIp } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

const DAY_MS = 86_400_000;
const NEW_PASSWORD = 'Reset-Revokes-Tokens-2026';
const RESET_URL = new RegExp(`^${TEST_PUBLIC_URL}/reset/([A-Za-z0-9_-]{43})$`);

/**
 * A password reset revokes the user's API tokens in every organization
 * (BACKLOG T802, P75, CONTRACTS §12.1, §26.4): by default on redemption
 * (`revoke_tokens` absent = `true`), when an admin creates a link, and
 * never with `revoke_tokens = false`. Two api instances: WebSocket
 * connections of the revoked tokens close with 4401 on both.
 */
describe('password reset revokes API tokens (T802, P75)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: TestApp;
  let b: TestApp;
  let wsA: string;
  let wsB: string;
  let fx: RecordFixture;
  let orgB: Id<'org'>;
  const sockets: TestSocket[] = [];
  /** A reset signs u_sales1 out everywhere: their requests sign in afresh. */
  let sales1Password = PASSWORD;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    a = await startTestApp({ DATABASE_URL: database.url });
    b = await startTestApp({ DATABASE_URL: database.url });
    wsA = await listen(a.app);
    wsB = await listen(b.app);
    fx = await buildRecordFixture(a, db);
    // u_sales1 also belongs to another organization (so only the CLI or
    // forgot-password can reset them; the link is made as the CLI does).
    orgB = await seedOrg(db, 'Other');
    await new OrgMembersRepository(db).add(orgScope(orgB), fx.users.u_sales1.id, 'member');
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await Promise.all([a.close(), b.close()]);
    await db.destroy();
    await database.drop();
  });

  async function as(
    user: FixtureUser,
    method: 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) {
    if (user !== 'u_sales1') return fx.call(user, method, url, payload);
    const browser = new Browser(a.app);
    expect((await browser.login(fx.users.u_sales1.email, sales1Password)).statusCode).toBe(204);
    return browser.request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function createToken(
    user: FixtureUser,
    orgId: Id<'org'>,
    scopes: ApiTokenScope[],
  ): Promise<CreatedApiToken> {
    const response = await as(user, 'POST', `/orgs/${orgId}/me/api-tokens`, {
      name: scopes.join(' '),
      scopes,
      expires_at: new Date(Date.now() + 90 * DAY_MS).toISOString(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  function bearer(token: string, app: TestApp = a) {
    return app.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: uniqueIp(),
    });
  }

  async function expectRevoked(token: string, app: TestApp = a): Promise<void> {
    const response = await bearer(token, app);
    expect({ status: response.statusCode, code: problemOf(response.body).code }).toEqual({
      status: 401,
      code: 'TOKEN_REVOKED',
    });
  }

  async function connect(token: string, url: string): Promise<TestSocket> {
    const result = await TestSocket.open(url, {
      authorization: `Bearer ${token}`,
      forwardedFor: uniqueIp(),
    });
    if (!result.ok) throw new Error(`refused: ${String(result.status)} ${result.body}`);
    sockets.push(result.socket);
    return result.socket;
  }

  async function cliLink(userId: Id<'usr'>): Promise<string> {
    const link = await db.withTx((tx) =>
      new PasswordResetLinks(new PasswordResetsRepository(db), TEST_PUBLIC_URL).create(tx, userId, {
        source: 'cli',
      }),
    );
    return tokenOf(link.url);
  }

  function tokenOf(url: string): string {
    const match = RESET_URL.exec(url);
    if (match?.[1] === undefined) throw new Error(`not a reset URL: ${url}`);
    return match[1];
  }

  async function redeem(token: string, body: Record<string, unknown>) {
    const response = await a.app.inject({
      method: 'POST',
      url: `/api/v1/auth/password-reset/${token}`,
      payload: { password: NEW_PASSWORD, ...body },
      remoteAddress: uniqueIp(),
    });
    if (response.statusCode === 204) sales1Password = NEW_PASSWORD;
    return response;
  }

  async function auditsOf(action: string, entityId: string) {
    return db.kysely
      .selectFrom('meta.audit_logs')
      .select(['organization_id', 'actor_type', 'actor_id', 'entity_type', 'before', 'after'])
      .where('action', '=', action)
      .where('entity_id', '=', entityId)
      .orderBy('created_at')
      .execute();
  }

  it('P75: revoke_tokens = false — every token keeps working, nothing revoked', async () => {
    const kept = await createToken('u_sales1', fx.orgId, ['records:read', 'schema:read']);
    const response = await redeem(await cliLink(fx.users.u_sales1.id), { revoke_tokens: false });
    expect(response.statusCode, response.body).toBe(204);
    expect((await bearer(kept.token)).statusCode).toBe(200);
    const [reset] = (await auditsOf('auth.password_reset', fx.users.u_sales1.id)).slice(-1);
    expect(reset?.after).toMatchObject({ revoked_tokens: 0 });
    expect(await auditsOf('api_token.revoked', fx.users.u_sales1.id)).toEqual([]);
    // Leave the next test with this token to revoke.
    const revoke = await as('u_sales1', 'DELETE', `/api-tokens/${kept.id}`);
    expect(revoke.statusCode).toBe(204);
  });

  it('P75: by default — tk_sales_r, tk_sales_w and the token in the other org → 401 TOKEN_REVOKED, WS 4401 ≤ 1 s, one audit per org', async () => {
    const salesR = await createToken('u_sales1', fx.orgId, ['records:read', 'schema:read']);
    const salesW = await createToken('u_sales1', fx.orgId, ['records:write']);
    const other = await createToken('u_sales1', orgB, ['schema:read']);
    const before = await createToken('u_sales1', fx.orgId, ['schema:read']);
    const earlier = await as('u_sales1', 'DELETE', `/api-tokens/${before.id}`);
    expect(earlier.statusCode).toBe(204);
    const tokens = new ApiTokensRepository(db);
    const earlierAt = (await tokens.findById(orgScope(fx.orgId), before.id))?.revoked_at;
    // u_editor's token is not touched.
    const editor = await createToken('u_editor', fx.orgId, ['schema:read']);

    const onA = await connect(salesR.token, wsA);
    const onB = await connect(salesR.token, wsB);
    const otherOnB = await connect(other.token, wsB);
    expect(await onB.subscribe(`table:${fx.orders.id}`)).toMatchObject({ type: 'subscribed' });

    // No `revoke_tokens`: revoked (Quyết định S7 #3).
    const response = await redeem(await cliLink(fx.users.u_sales1.id), {});
    expect(response.statusCode, response.body).toBe(204);
    const since = performance.now();
    for (const socket of [onA, onB, otherOnB]) {
      expect((await socket.closed).code).toBe(REALTIME_CLOSE_CODES.unauthenticated);
    }
    expect(performance.now() - since).toBeLessThan(1_000);

    for (const token of [salesR, salesW, other]) {
      await expectRevoked(token.token);
      await expectRevoked(token.token, b);
    }
    expect((await bearer(editor.token)).statusCode).toBe(200);

    // revoked_by = the user; the earlier revocation keeps its time.
    expect(await tokens.findById(orgScope(fx.orgId), salesR.id)).toMatchObject({
      revoked_by: fx.users.u_sales1.id,
    });
    expect((await tokens.findById(orgScope(fx.orgId), before.id))?.revoked_at).toEqual(earlierAt);

    // One bulk audit per organization, with the ids and the count; no value or hash.
    const bulk = await auditsOf('api_token.revoked', fx.users.u_sales1.id);
    expect(bulk).toHaveLength(2);
    const inA = bulk.find((entry) => entry.organization_id === fx.orgId);
    const inB = bulk.find((entry) => entry.organization_id === orgB);
    expect(inA).toMatchObject({
      actor_type: 'user',
      actor_id: fx.users.u_sales1.id,
      entity_type: 'user',
      before: null,
      after: { reason: 'password_reset', count: 2 },
    });
    expect(new Set((inA?.after as { token_ids: string[] }).token_ids)).toEqual(
      new Set([salesR.id, salesW.id]),
    );
    expect(inB?.after).toEqual({ reason: 'password_reset', count: 1, token_ids: [other.id] });
    const serialized = JSON.stringify(bulk);
    for (const token of [salesR, salesW, other]) expect(serialized).not.toContain(token.token);

    // One event per token, in its organization.
    const events = await db.kysely
      .selectFrom('meta.events')
      .select(['organization_id', 'entity_id', 'payload'])
      .where('type', '=', 'api_token.revoked')
      .where('entity_id', 'in', [salesR.id, salesW.id, other.id, before.id])
      .execute();
    expect(events.filter((event) => event.entity_id === before.id)).toHaveLength(1);
    expect(events.filter((event) => event.entity_id !== before.id)).toHaveLength(3);
    expect(events.find((event) => event.entity_id === other.id)).toMatchObject({
      organization_id: orgB,
      payload: { data: { user_id: fx.users.u_sales1.id, reason: 'password_reset' } },
    });

    // auth.password_reset (one per org) counts the tokens.
    const resets = await auditsOf('auth.password_reset', fx.users.u_sales1.id);
    expect(
      resets.slice(-2).map((entry) => (entry.after as { revoked_tokens: number }).revoked_tokens),
    ).toEqual([3, 3]);
  });

  it('admin link: revokes the member’s tokens with the link by default; revoke_tokens = false keeps them', async () => {
    const member = fx.users.u_sales2;
    const token = await createToken('u_sales2', fx.orgId, ['schema:read']);

    const keep = await fx.call(
      'owner',
      'POST',
      `/orgs/${fx.orgId}/members/${member.id}/password-reset`,
      {
        revoke_tokens: false,
      },
    );
    expect(keep.statusCode, keep.body).toBe(201);
    expect((await bearer(token.token)).statusCode).toBe(200);

    const invalid = await fx.call(
      'owner',
      'POST',
      `/orgs/${fx.orgId}/members/${member.id}/password-reset`,
      { revoke_tokens: 'yes' },
    );
    expect(invalid.statusCode).toBe(422);

    const link = await fx.call(
      'owner',
      'POST',
      `/orgs/${fx.orgId}/members/${member.id}/password-reset`,
    );
    expect(link.statusCode, link.body).toBe(201);
    passwordResetLinkSchema.parse(link.json());
    await expectRevoked(token.token);
    expect(await new ApiTokensRepository(db).findById(orgScope(fx.orgId), token.id)).toMatchObject({
      revoked_by: fx.users.owner.id,
    });
    const requested = await auditsOf('auth.password_reset_requested', member.id);
    expect(
      requested.map((entry) => (entry.after as { revoked_tokens: number }).revoked_tokens),
    ).toEqual([0, 1]);
    expect(await auditsOf('api_token.revoked', member.id)).toMatchObject([
      {
        organization_id: fx.orgId,
        actor_type: 'user',
        actor_id: fx.users.owner.id,
        after: { reason: 'password_reset', count: 1, token_ids: [token.id] },
      },
    ]);
  });
});
