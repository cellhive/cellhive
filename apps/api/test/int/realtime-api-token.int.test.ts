import { performance } from 'node:perf_hooks';

import {
  createdApiTokenSchema,
  REALTIME_CLOSE_CODES,
  recordsResponseSchema,
  type ApiTokenScope,
  type CreatedApiToken,
  type Id,
  type RealtimeServerMessage,
  type RecordDto,
} from '@cellhive/contracts';
import {
  apiTokenChecksum,
  orgBusChannel,
  OrgMembersRepository,
  orgScope,
  REALTIME_ENVELOPE_VERSION,
  type Db,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiTokenAuthService } from '../../src/common/auth/api-token-auth.service.js';
import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { CACHE_CLIENT } from '../../src/common/tokens.js';
import { MetricsService } from '../../src/modules/metrics/metrics.service.js';
import { RealtimeBusSubscriber } from '../../src/modules/realtime/bus-subscriber.js';
import {
  API_TOKEN_RECHECK_INTERVAL_MS,
  CONNECTION_LIMIT_RETRY_AFTER_SECONDS,
  MAX_CONNECTIONS_PER_API_TOKEN,
  RealtimeLimits,
} from '../../src/modules/realtime/realtime-limits.js';
import { RealtimeRouter } from '../../src/modules/realtime/realtime-router.js';
import { RealtimeGateway } from '../../src/modules/realtime/realtime.gateway.js';

import { seedOrg, uniqueIp } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket, type OpenResult } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';
import type { Redis } from 'ioredis';

type Message = RealtimeServerMessage;

const CHALLENGE = 'Bearer error="invalid_token"';
const DAY = 86_400_000;

/**
 * T706 (ADR-36 §2, CONTRACTS §7, §26.5, P58): WebSocket connections opened
 * with `Authorization: Bearer cht_…` on two api instances sharing
 * PostgreSQL and Valkey — the handshake branch (no `Origin`, same 401s and
 * per-IP failure limit as HTTP, Bearer over cookie, 10 per token), the
 * `records:read` scope and token limits on channels, per-subscriber
 * filtering identical to cookie subscribers (T210, T313), and closing with
 * 4401 on revocation, policy off, member removal and expiry.
 * Writes go through instance A; clients listen on instance B unless stated.
 */
describe('realtime over API tokens (T706)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: TestApp;
  let b: TestApp;
  let urlA: string;
  let urlB: string;
  let fx: RecordFixture;
  let channel: string;
  let otherOrgId: Id<'org'>;
  let otherBaseId: Id<'bse'>;
  let base2: Id<'bse'>;
  let highCost: Id<'viw'>;
  let r1: Id<'rec'>, r2: Id<'rec'>;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    a = await startTestApp({ DATABASE_URL: database.url });
    b = await startTestApp({ DATABASE_URL: database.url });
    urlA = await listen(a.app);
    urlB = await listen(b.app);
    fx = await buildRecordFixture(a, db);
    channel = `table:${fx.orders.id}`;

    const created = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: [
          { fields: { title: 'r1', amount: 100, cost: 60, owner: [{ id: fx.users.u_sales1.id }] } },
          {
            fields: { title: 'r2', amount: 200, cost: 120, owner: [{ id: fx.users.u_sales2.id }] },
          },
        ],
      }),
    );
    [r1, r2] = created.map((record) => record.id) as [Id<'rec'>, Id<'rec'>];

    // "High cost" (cost > 50): a condition on a field u_sales1 cannot read (T313).
    const view = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'High cost',
      type: 'grid',
      config: { filter: { op: 'and', items: [{ field: F('cost'), operator: 'gt', value: 50 }] } },
    });
    expect(view.statusCode, view.body).toBe(201);
    highCost = view.json<{ id: Id<'viw'> }>().id;

    // Base B2 of the same organization.
    const workspaces = await fx.call('owner', 'GET', `/orgs/${fx.orgId}/workspaces`);
    const workspaceId = workspaces.json<{ items: { id: Id<'wsp'> }[] }>().items[0]?.id;
    const b2 = await fx.call('owner', 'POST', `/workspaces/${String(workspaceId)}/bases`, {
      name: 'B2',
    });
    expect(b2.statusCode, b2.body).toBe(201);
    base2 = b2.json<{ id: Id<'bse'> }>().id;

    // The owner also owns a base of another organization.
    const orgs = await fx.call('stranger', 'GET', '/orgs');
    otherOrgId = orgs.json<{ items: { id: Id<'org'> }[] }>().items[0]?.id as Id<'org'>;
    await new OrgMembersRepository(db).add(orgScope(otherOrgId), fx.users.owner.id, 'owner');
    const otherWorkspace = await fx.call('stranger', 'POST', `/orgs/${otherOrgId}/workspaces`, {
      name: 'Elsewhere',
    });
    expect(otherWorkspace.statusCode, otherWorkspace.body).toBe(201);
    const otherBase = await fx.call(
      'stranger',
      'POST',
      `/workspaces/${otherWorkspace.json<{ id: string }>().id}/bases`,
      { name: 'Other' },
    );
    expect(otherBase.statusCode, otherBase.body).toBe(201);
    otherBaseId = otherBase.json<{ id: Id<'bse'> }>().id;
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await Promise.all([a.close(), b.close()]);
    await db.destroy();
    await database.drop();
  });

  const F = (name: string): Id<'fld'> => {
    const field = fx.fld[name];
    if (field === undefined) throw new Error(`no field ${name}`);
    return field.id;
  };

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  function patch(user: FixtureUser, id: Id<'rec'>, fields: object) {
    return fx.call(user, 'PATCH', `/tables/${fx.orders.id}/records`, {
      records: [{ id, fields }],
    });
  }

  async function createToken(
    user: FixtureUser,
    scopes: ApiTokenScope[] = ['records:read'],
    extra: Record<string, unknown> = {},
    orgId: Id<'org'> = fx.orgId,
  ): Promise<CreatedApiToken> {
    const response = await fx.call(user, 'POST', `/orgs/${orgId}/me/api-tokens`, {
      name: `${user} ws`,
      scopes,
      expires_at: new Date(Date.now() + 90 * DAY).toISOString(),
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  /** Opens `/ws` with `Authorization: Bearer <token>`, no `Origin`, from a fresh client IP. */
  function openWith(
    token: string,
    url = urlB,
    extra: { cookie?: string; origin?: string } = {},
  ): Promise<OpenResult> {
    return TestSocket.open(url, {
      authorization: `Bearer ${token}`,
      forwardedFor: uniqueIp(),
      ...extra,
    });
  }

  async function connectWith(token: string, url = urlB): Promise<TestSocket> {
    const result = await openWith(token, url);
    if (!result.ok) throw new Error(`refused: ${String(result.status)} ${result.body}`);
    sockets.push(result.socket);
    return result.socket;
  }

  function expectRefused(result: OpenResult, status: number, code: string): void {
    if (result.ok) {
      sockets.push(result.socket);
      throw new Error('handshake accepted');
    }
    expect({ status: result.status, code: problemOf(result.body).code }).toEqual({ status, code });
  }

  function expect401(result: OpenResult, code: string): void {
    expectRefused(result, 401, code);
    if (!result.ok) expect(result.headers['www-authenticate']).toBe(CHALLENGE);
  }

  /** Closed with 4401 within `ms` of `since`. */
  async function expectClosed(socket: TestSocket, since: number, ms = 1_000): Promise<void> {
    expect((await socket.closed).code).toBe(REALTIME_CLOSE_CODES.unauthenticated);
    expect(performance.now() - since).toBeLessThan(ms);
  }

  const about =
    (type: Message['type'], recordId?: string) =>
    (message: Message): boolean =>
      message.type === type &&
      (recordId === undefined || ('record_id' in message && message.record_id === recordId));
  const anyAbout = (recordId: string) => (message: Message) =>
    ('record_id' in message && message.record_id === recordId) ||
    ('record_ids' in message && message.record_ids.includes(recordId as Id<'rec'>));

  describe('handshake', () => {
    it('accepts a Bearer token without Origin; the cookie branch still needs Origin (403)', async () => {
      const token = await createToken('u_sales1');
      const socket = await connectWith(token.token);
      socket.send({ type: 'ping', req_id: 'p' });
      expect(await socket.next()).toEqual({ type: 'pong', req_id: 'p' });

      const cookie = await TestSocket.open(urlB, { cookie: await fx.cookie('u_sales1') });
      expectRefused(cookie, 403, 'PERMISSION_DENIED');
      // A foreign Origin does not matter on the Bearer branch either.
      const foreign = await openWith(token.token, urlB, { origin: 'https://evil.test' });
      expect(foreign.ok).toBe(true);
      if (foreign.ok) sockets.push(foreign.socket);
    });

    it('refuses bad tokens with 401 problem+json and WWW-Authenticate, like HTTP', async () => {
      expect401(await openWith('cht_tooShort'), 'UNAUTHENTICATED');
      const random = 'Zz9'.repeat(10);
      expect401(await openWith(`cht_${random}${apiTokenChecksum(random)}`), 'UNAUTHENTICATED');
      expect401(
        await TestSocket.open(urlB, {
          authorization: 'Basic dXNlcjpwYXNz',
          forwardedFor: uniqueIp(),
        }),
        'UNAUTHENTICATED',
      );

      const revoked = await createToken('u_sales1');
      expect((await fx.call('u_sales1', 'DELETE', `/api-tokens/${revoked.id}`)).statusCode).toBe(
        204,
      );
      expect401(await openWith(revoked.token), 'TOKEN_REVOKED');

      const expired = await createToken('u_sales1');
      await sql`
        UPDATE meta.api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${expired.id}
      `.execute(db.kysely);
      expect401(await openWith(expired.token), 'TOKEN_EXPIRED');
    });

    it('Bearer wins over a valid cookie and never falls back to it', async () => {
      const cookie = await fx.cookie('u_admin');
      // An invalid token with u_admin's valid cookie (and Origin): 401.
      expect401(
        await openWith('cht_tooShort', urlB, { cookie, origin: TEST_PUBLIC_URL }),
        'UNAUTHENTICATED',
      );
      // A valid token of u_sales1 with u_admin's cookie: the connection is u_sales1's.
      const token = await createToken('u_sales1');
      const result = await openWith(token.token, urlB, { cookie, origin: TEST_PUBLIC_URL });
      if (!result.ok) throw new Error(result.body);
      sockets.push(result.socket);
      // Customers is no_perm for u_sales1, readable for u_admin.
      expect(await result.socket.subscribe(`table:${fx.customers.id}`)).toMatchObject({
        type: 'error',
        code: 'NOT_FOUND',
      });
      expect(await result.socket.subscribe(channel)).toMatchObject({ type: 'subscribed' });
    });

    it('counts failed Bearer handshakes per client IP like HTTP (429 + Retry-After)', async () => {
      const limits = b.app.get(ApiRateLimits);
      const rule = limits.bearerFailures;
      limits.bearerFailures = { limit: 2, windowSeconds: 60 };
      const ip = uniqueIp();
      const token = await createToken('u_sales1');
      try {
        const attempt = (value: string) =>
          TestSocket.open(urlB, { authorization: `Bearer ${value}`, forwardedFor: ip });
        expect401(await attempt('cht_bad1'), 'UNAUTHENTICATED');
        expect401(await attempt('cht_bad2'), 'UNAUTHENTICATED');
        // The limit is used up: even a valid token is refused from that IP, before any lookup.
        const blocked = await attempt(token.token);
        expectRefused(blocked, 429, 'RATE_LIMITED');
        if (!blocked.ok) expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
        // Another IP is not affected.
        const other = await openWith(token.token);
        expect(other.ok).toBe(true);
        if (other.ok) sockets.push(other.socket);
      } finally {
        limits.bearerFailures = rule;
      }
    });

    it(`allows ${String(MAX_CONNECTIONS_PER_API_TOKEN)} connections per token and instance (429)`, async () => {
      const token = await createToken('u_reader');
      const open: TestSocket[] = [];
      for (let index = 0; index < MAX_CONNECTIONS_PER_API_TOKEN; index += 1) {
        open.push(await connectWith(token.token));
      }
      const refused = await openWith(token.token);
      expectRefused(refused, 429, 'RATE_LIMITED');
      // Every 429 carries Retry-After (CONTRACTS §1.1).
      if (!refused.ok) {
        expect(refused.headers['retry-after']).toBe(String(CONNECTION_LIMIT_RETRY_AFTER_SECONDS));
      }
      // Another instance counts its own; another token of the same user too.
      open.push(await connectWith(token.token, urlA));
      open.push(await connectWith((await createToken('u_reader')).token));
      // The user's session connections are not counted with the token's.
      const session = await TestSocket.connect(urlB, {
        origin: TEST_PUBLIC_URL,
        cookie: await fx.cookie('u_reader'),
      });
      sockets.push(session);

      const metrics = (await b.app.get(MetricsService).render()).body;
      expect(metrics).toMatch(/^ws_connections\{auth="api_token"\} 1\d$/m);
      expect(metrics).toMatch(/^ws_connections\{auth="session"\} [1-9]\d*$/m);
      expect(metrics).not.toContain(token.id);

      // Closing one frees a slot.
      await closeSockets(open.slice(0, 1));
      await expect
        .poll(async () => (await openWith(token.token)).ok, { timeout: 5_000 })
        .toBe(true);
      await closeSockets(open);
    });
  });

  describe('subscribe', () => {
    it('P58: tk_sales_r gets exactly what u_sales1 gets over a cookie (T210)', async () => {
      const token = await createToken('u_sales1');
      const sales = await connectWith(token.token);
      expect(await sales.subscribe(channel)).toMatchObject({ type: 'subscribed', channel });
      const cookie = await TestSocket.connect(urlB, {
        origin: TEST_PUBLIC_URL,
        cookie: await fx.cookie('u_sales1'),
      });
      sockets.push(cookie);
      expect(await cookie.subscribe(channel)).toMatchObject({ type: 'subscribed' });

      // r2 is outside u_sales1's read rule; cost is no_perm.
      records(await patch('u_editor', r2, { amount: 201 }));
      records(await patch('u_editor', r1, { cost: 61 }));
      await sales.expectNone(anyAbout(r2));
      await sales.expectNone(anyAbout(r1));
      await cookie.expectNone((message) => anyAbout(r1)(message) || anyAbout(r2)(message));

      const [edit] = records(await patch('u_editor', r1, { amount: 2_000_000 }));
      const expected = {
        type: 'record.updated',
        channel,
        record_id: r1,
        version: edit?.version,
        fields: { [F('amount')]: 2_000_000 },
        actor_id: fx.users.u_editor.id,
        event_id: expect.stringMatching(/^evt_/) as unknown,
      };
      expect(await sales.next(about('record.updated', r1))).toEqual(expected);
      expect(await cookie.next(about('record.updated', r1))).toEqual(expected);
    });

    it('follows the view like a cookie subscriber (T313)', async () => {
      const token = await createToken('u_sales1');
      const sales = await connectWith(token.token);
      expect(await sales.subscribe(channel, 'v', { view: { id: highCost } })).toMatchObject({
        type: 'subscribed',
      });
      records(await patch('u_admin', r1, { cost: 10 }));
      expect(await sales.next(about('record.removed_from_view', r1))).toEqual({
        type: 'record.removed_from_view',
        channel,
        record_id: r1,
      });
      records(await patch('u_admin', r1, { cost: 70 }));
      expect(await sales.next(about('record.added', r1))).toEqual({
        type: 'record.added',
        channel,
        record_id: r1,
      });
    });

    it('P58: user: is NOT_FOUND with a token, even the own channel', async () => {
      const token = await createToken('u_sales1');
      const sales = await connectWith(token.token);
      expect(await sales.subscribe(`user:${fx.users.u_sales1.id}`, 'u')).toEqual({
        type: 'error',
        req_id: 'u',
        code: 'NOT_FOUND',
        channel: `user:${fx.users.u_sales1.id}`,
      });
    });

    it('P58: without records:read → INSUFFICIENT_SCOPE; unreachable channels stay NOT_FOUND', async () => {
      const token = await createToken('u_sales1', ['schema:read', 'records:write']);
      const socket = await connectWith(token.token);
      for (const target of [channel, `base:${fx.baseId}`]) {
        expect(await socket.subscribe(target, `s-${target}`)).toEqual({
          type: 'error',
          req_id: `s-${target}`,
          code: 'INSUFFICIENT_SCOPE',
          channel: target,
          errors: [
            {
              path: '',
              code: 'INSUFFICIENT_SCOPE',
              message: 'The API token does not allow this channel',
              params: { required: ['records:read'] },
            },
          ],
        });
      }
      // Customers is no_perm for u_sales1: 404 before the scope.
      expect(await socket.subscribe(`table:${fx.customers.id}`)).toMatchObject({
        type: 'error',
        code: 'NOT_FOUND',
      });
    });

    it('a base outside base_ids or of another organization is NOT_FOUND', async () => {
      const cookie = await TestSocket.connect(urlB, {
        origin: TEST_PUBLIC_URL,
        cookie: await fx.cookie('owner'),
      });
      sockets.push(cookie);
      // The owner's session reaches both bases.
      expect(await cookie.subscribe(`base:${base2}`)).toMatchObject({ type: 'subscribed' });
      expect(await cookie.subscribe(`base:${otherBaseId}`)).toMatchObject({ type: 'subscribed' });

      const limited = await createToken('owner', ['records:read'], { base_ids: [fx.baseId] });
      const socket = await connectWith(limited.token);
      expect(await socket.subscribe(`base:${fx.baseId}`)).toMatchObject({ type: 'subscribed' });
      expect(await socket.subscribe(channel)).toMatchObject({ type: 'subscribed' });
      for (const target of [`base:${base2}`, `base:${otherBaseId}`]) {
        expect(await socket.subscribe(target, target)).toEqual({
          type: 'error',
          req_id: target,
          code: 'NOT_FOUND',
          channel: target,
        });
      }
      // A token without base_ids still only reaches its own organization.
      const unlimited = await createToken('owner');
      const wide = await connectWith(unlimited.token);
      expect(await wide.subscribe(`base:${base2}`)).toMatchObject({ type: 'subscribed' });
      expect(await wide.subscribe(`base:${otherBaseId}`)).toMatchObject({
        type: 'error',
        code: 'NOT_FOUND',
      });
    });
  });

  describe('closing (4401)', () => {
    it('P58: revoking on instance A closes the connections on both instances within 1 s', async () => {
      const token = await createToken('u_sales1');
      const onB = await connectWith(token.token, urlB);
      expect(await onB.subscribe(channel)).toMatchObject({ type: 'subscribed' });
      // No subscription at all: still closed.
      const onA = await connectWith(token.token, urlA);
      const bystander = await connectWith((await createToken('u_sales1')).token, urlB);

      const response = await fx.call('u_sales1', 'DELETE', `/api-tokens/${token.id}`);
      expect(response.statusCode).toBe(204);
      const since = performance.now();
      await expectClosed(onB, since);
      await expectClosed(onA, since);
      bystander.send({ type: 'ping', req_id: 'still' });
      expect(await bystander.next()).toEqual({ type: 'pong', req_id: 'still' });
    });

    it('turning API tokens off closes every token connection of the organization', async () => {
      const first = await connectWith((await createToken('u_sales1')).token, urlB);
      const second = await connectWith((await createToken('u_editor')).token, urlA);
      const session = await TestSocket.connect(urlB, {
        origin: TEST_PUBLIC_URL,
        cookie: await fx.cookie('u_editor'),
      });
      sockets.push(session);
      try {
        const response = await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
          settings: { api_tokens: { enabled: false } },
        });
        expect(response.statusCode, response.body).toBe(200);
        const since = performance.now();
        await expectClosed(first, since);
        await expectClosed(second, since);
        // Session connections stay.
        session.send({ type: 'ping', req_id: 'still' });
        expect(await session.next()).toEqual({ type: 'pong', req_id: 'still' });
      } finally {
        const restored = await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
          settings: { api_tokens: { enabled: true } },
        });
        expect(restored.statusCode, restored.body).toBe(200);
      }
    });

    it('expiry closes the connection at the next periodic check', async () => {
      expect(b.app.get(RealtimeLimits).apiTokenRecheckIntervalMs).toBe(
        API_TOKEN_RECHECK_INTERVAL_MS,
      );
      expect(API_TOKEN_RECHECK_INTERVAL_MS).toBeLessThanOrEqual(60_000);
      const token = await createToken('u_sales1');
      const socket = await connectWith(token.token);
      const other = await connectWith((await createToken('u_sales1')).token);
      const gateway = b.app.get(RealtimeGateway);
      // Still valid: the check keeps it.
      await gateway.recheckApiTokens();
      socket.send({ type: 'ping', req_id: 'valid' });
      expect(await socket.next()).toEqual({ type: 'pong', req_id: 'valid' });

      await sql`
        UPDATE meta.api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${token.id}
      `.execute(db.kysely);
      // The periodic tick (every 60 s), driven by the test instead of waiting.
      const since = performance.now();
      await gateway.recheckApiTokens();
      await expectClosed(socket, since);
      other.send({ type: 'ping', req_id: 'other' });
      expect(await other.next()).toEqual({ type: 'pong', req_id: 'other' });
    });

    it('expiry is also noticed when permission.changed re-checks the subscriptions', async () => {
      const token = await createToken('u_sales1');
      const socket = await connectWith(token.token);
      expect(await socket.subscribe(`base:${fx.baseId}`)).toMatchObject({ type: 'subscribed' });
      await sql`
        UPDATE meta.api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${token.id}
      `.execute(db.kysely);
      const since = performance.now();
      await a.app.get<Redis>(CACHE_CLIENT).publish(
        orgBusChannel(fx.orgId),
        JSON.stringify({
          v: REALTIME_ENVELOPE_VERSION,
          type: 'permission.changed',
          organization_id: fx.orgId,
          base_ids: [fx.baseId],
        }),
      );
      await expectClosed(socket, since);
      // Closed, not told about the permission change.
      expect(socket.received.filter((message) => message.type === 'permission.changed')).toEqual(
        [],
      );
    });

    it('removing the member closes the connections of their tokens', async () => {
      const token = await createToken('u_out');
      const onA = await connectWith(token.token, urlA);
      const onB = await connectWith(token.token, urlB);
      const response = await fx.call(
        'owner',
        'DELETE',
        `/orgs/${fx.orgId}/members/${fx.users.u_out.id}`,
      );
      expect(response.statusCode, response.body).toBe(204);
      const since = performance.now();
      await expectClosed(onA, since);
      await expectClosed(onB, since);
      expect401(await openWith(token.token), 'UNAUTHENTICATED');
    });
  });

  /**
   * Revocations racing a handshake (T706 review): each test uses an
   * organization instance B does not listen to yet.
   */
  describe('handshake races', () => {
    async function freshOrg(): Promise<Id<'org'>> {
      const orgId = await seedOrg(db, `Race ${String(Date.now())}`);
      await new OrgMembersRepository(db).add(orgScope(orgId), fx.users.owner.id, 'owner');
      return orgId;
    }

    /** Resolves once instance B has handled the next `api_token.revoked` of the bus. */
    function revokedOnB(): Promise<void> {
      const router = b.app.get(RealtimeRouter);
      const original = router.receive.bind(router);
      return new Promise((resolve) => {
        router.receive = (busChannel: string, message: string) => {
          original(busChannel, message);
          if (message.includes('"api_token.revoked"')) {
            router.receive = original;
            resolve();
          }
        };
      });
    }

    it('a revocation published while the organization subscription is pending is not missed', async () => {
      const orgId = await freshOrg();
      const first = await createToken('owner', ['records:read'], {}, orgId);
      const second = await createToken('owner', ['records:read'], {}, orgId);
      // `subscribe` is private: reach it through a structural view.
      const bus = b.app.get<
        RealtimeBusSubscriber,
        {
          subscribe(org: Id<'org'>): Promise<void>;
          acquire(org: Id<'org'>): Promise<boolean>;
        }
      >(RealtimeBusSubscriber);
      const subscribe = bus.subscribe.bind(bus);
      const acquire = bus.acquire.bind(bus);
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      const acquired: (() => void)[] = [];
      const acquiredBy = [1, 2].map(() => new Promise<void>((resolve) => acquired.push(resolve)));
      let acquires = 0;
      // Valkey confirms the SUBSCRIBE only when the test says so.
      bus.subscribe = async (org) => {
        if (org === orgId) await gate;
        return subscribe(org);
      };
      bus.acquire = (org) => {
        if (org === orgId) acquired[acquires++]?.();
        return acquire(org);
      };
      try {
        const firstOpen = openWith(first.token);
        await acquiredBy[0];
        // The second handshake waits for the subscription the first one started.
        const secondOpen = openWith(second.token);
        await acquiredBy[1];
        // Revoked meanwhile: B does not hear it (not subscribed yet).
        expect((await fx.call('owner', 'DELETE', `/api-tokens/${second.id}`)).statusCode).toBe(204);
        await new Promise((resolve) => setTimeout(resolve, 200));
        openGate();
        expect401(await secondOpen, 'TOKEN_REVOKED');
        const opened = await firstOpen;
        expect(opened.ok).toBe(true);
        if (opened.ok) sockets.push(opened.socket);
      } finally {
        bus.subscribe = subscribe;
        bus.acquire = acquire;
        openGate();
      }
    });

    it("a revocation heard during the handshake's second token check is not missed", async () => {
      const orgId = await freshOrg();
      const token = await createToken('owner', ['records:read'], {}, orgId);
      const service = b.app.get(ApiTokenAuthService);
      const authenticate = service.authenticate.bind(service);
      let calls = 0;
      service.authenticate = async (value: string) => {
        calls += value === token.token ? 1 : 0;
        const result = await authenticate(value);
        // The second check (B just started listening) read the token before
        // the revocation committed; its envelope arrives before `accept`.
        if (value === token.token && calls === 2) {
          const heard = revokedOnB();
          expect((await fx.call('owner', 'DELETE', `/api-tokens/${token.id}`)).statusCode).toBe(
            204,
          );
          await heard;
        }
        return result;
      };
      try {
        expect401(await openWith(token.token), 'TOKEN_REVOKED');
        expect(calls).toBe(3);
      } finally {
        service.authenticate = authenticate;
      }
    });

    it('checks each token once per tick, however many connections it has', async () => {
      const token = await createToken('u_sales1');
      const open = await Promise.all([1, 2, 3].map(() => connectWith(token.token)));
      const service = b.app.get(ApiTokenAuthService);
      const authenticate = service.authenticate.bind(service);
      let calls = 0;
      service.authenticate = (value: string) => {
        if (value === token.token) calls += 1;
        return authenticate(value);
      };
      try {
        await b.app.get(RealtimeGateway).recheckApiTokens();
        expect(calls).toBe(1);
        await sql`
          UPDATE meta.api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${token.id}
        `.execute(db.kysely);
        await b.app.get(RealtimeGateway).recheckApiTokens();
        expect(calls).toBe(2);
        for (const socket of open) {
          expect((await socket.closed).code).toBe(REALTIME_CLOSE_CODES.unauthenticated);
        }
      } finally {
        service.authenticate = authenticate;
      }
    });
  });
});
