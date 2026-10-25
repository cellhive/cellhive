import {
  baseDetailSchema,
  fieldSchema,
  jobAcceptedSchema,
  REALTIME_CLOSE_CODES,
  REALTIME_MAX_MESSAGE_BYTES,
  roleListSchema,
  roleWithAdjustmentsSchema,
  tableSchema,
  workspaceSchema,
  type Id,
  type RealtimeServerMessage,
  type TableDto,
} from '@cellhive/contracts';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SessionService } from '../../src/common/auth/session.service.js';
import { MetricsService } from '../../src/modules/metrics/metrics.service.js';
import {
  CONNECTION_LIMIT_RETRY_AFTER_SECONDS,
  MAX_CONNECTIONS_PER_USER,
  RealtimeLimits,
} from '../../src/modules/realtime/realtime-limits.js';
import { RealtimeGateway } from '../../src/modules/realtime/realtime.gateway.js';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';
import type { LightMyRequestResponse } from 'fastify';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const ORIGIN = TEST_PUBLIC_URL;

/**
 * T209: the WebSocket gateway on `/ws` (CONTRACTS §7) on two api instances
 * sharing PostgreSQL and Valkey: handshake checks, protocol, access checks
 * at subscribe, fan-out across instances, permission re-checks, limits and
 * job progress published by the worker.
 */
describe('realtime gateway (T209)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: TestApp;
  let b: TestApp;
  let urlA: string;
  let urlB: string;
  let worker: WorkerHandle | undefined;
  let org: Id<'org'>;
  let owner: SeededUser;
  let reader: SeededUser;
  let revoked: SeededUser;
  let outsider: SeededUser;
  let stranger: SeededUser;
  let workspaceId: Id<'wsp'>;
  let baseId: Id<'bse'>;
  let orders: TableDto;
  let customers: TableDto;
  const browsers = new Map<string, Browser>();
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    a = await startTestApp({ DATABASE_URL: database.url });
    b = await startTestApp({ DATABASE_URL: database.url });
    urlA = await listen(a.app);
    urlB = await listen(b.app);

    org = await seedOrg(db, 'Realtime');
    const otherOrg = await seedOrg(db, 'Elsewhere');
    const member = (role: 'owner' | 'member') => ({ memberships: [{ orgId: org, role }] });
    owner = await seedUser(db, member('owner'));
    reader = await seedUser(db, member('member'));
    revoked = await seedUser(db, member('member'));
    outsider = await seedUser(db, member('member'));
    stranger = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] });

    workspaceId = workspaceSchema.parse(
      (await call(owner, 'POST', `/orgs/${org}/workspaces`, { name: 'Main' })).json(),
    ).id;
    baseId = baseDetailSchema.parse(
      (await call(owner, 'POST', `/workspaces/${workspaceId}/bases`, { name: 'CRM' })).json(),
    ).id;
    orders = await createTable(baseId, 'Orders');
    customers = await createTable(baseId, 'Customers');
    const roles = roleListSchema.parse((await call(owner, 'GET', `/bases/${baseId}/roles`)).json());
    const readerRole = roles.items.find((role) => role.kind === 'system_reader');
    if (readerRole === undefined) throw new Error('no reader role');
    for (const user of [reader, revoked]) {
      const assigned = await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: user.id,
        role_id: readerRole.id,
      });
      expect(assigned.statusCode).toBe(200);
    }
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await worker?.close();
    await Promise.all([a.close(), b.close()]);
    await db.destroy();
    await database.drop();
  });

  async function as(user: SeededUser): Promise<Browser> {
    let browser = browsers.get(user.id);
    if (browser === undefined) {
      browser = new Browser(a.app);
      expect((await browser.login(user.email)).statusCode).toBe(204);
      browsers.set(user.id, browser);
    }
    return browser;
  }

  async function call(
    user: SeededUser,
    method: Method,
    url: string,
    payload?: object,
  ): Promise<LightMyRequestResponse> {
    return (await as(user)).request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function createTable(base: Id<'bse'>, name: string): Promise<TableDto> {
    const response = await call(owner, 'POST', `/bases/${base}/tables`, { name });
    expect(response.statusCode).toBe(201);
    return tableSchema.parse(response.json());
  }

  /** A signed-in WebSocket of `user` on the instance at `url`. */
  async function connect(user: SeededUser, url: string): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, {
      origin: ORIGIN,
      cookie: (await as(user)).cookieHeader(),
    });
    sockets.push(socket);
    return socket;
  }

  const isType =
    (type: RealtimeServerMessage['type'], channel?: string) =>
    (message: RealtimeServerMessage): boolean =>
      message.type === type &&
      (channel === undefined || ('channel' in message && message.channel === channel));

  describe('handshake', () => {
    it('refuses a connection without a session (401)', async () => {
      const result = await TestSocket.open(urlA, { origin: ORIGIN });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(401);
      expect(JSON.parse(result.body)).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });

      const forged = await TestSocket.open(urlA, { origin: ORIGIN, cookie: 'ob_session=nope' });
      expect(forged).toMatchObject({ ok: false, status: 401 });
    });

    it('refuses a foreign or missing Origin even with a valid session (403)', async () => {
      const cookie = (await as(owner)).cookieHeader();
      for (const origin of ['https://evil.test', 'http://cellhive.test', undefined]) {
        const result = await TestSocket.open(urlA, {
          cookie,
          ...(origin === undefined ? {} : { origin }),
        });
        expect(result).toMatchObject({ ok: false, status: 403 });
        if (!result.ok)
          expect(JSON.parse(result.body)).toMatchObject({ code: 'PERMISSION_DENIED' });
      }
    });

    it('refuses other paths (404)', async () => {
      const result = await TestSocket.open(urlA.replace('/ws', '/wsx'), {
        origin: ORIGIN,
        cookie: (await as(owner)).cookieHeader(),
      });
      expect(result).toMatchObject({ ok: false, status: 404 });
    });

    it(`limits a user to ${String(MAX_CONNECTIONS_PER_USER)} connections per instance (429)`, async () => {
      const open: TestSocket[] = [];
      for (let index = 0; index < MAX_CONNECTIONS_PER_USER; index += 1) {
        open.push(await connect(outsider, urlA));
      }
      const refused = await TestSocket.open(urlA, {
        origin: ORIGIN,
        cookie: (await as(outsider)).cookieHeader(),
      });
      expect(refused).toMatchObject({ ok: false, status: 429 });
      // Every 429 carries Retry-After (CONTRACTS §1.1).
      if (!refused.ok) {
        expect(refused.headers['retry-after']).toBe(String(CONNECTION_LIMIT_RETRY_AFTER_SECONDS));
      }
      // The other instance counts its own connections.
      const elsewhere = await connect(outsider, urlB);
      elsewhere.close();
      for (const socket of open) socket.close();
      await Promise.all(open.map((socket) => socket.closed));
    });
  });

  describe('protocol', () => {
    it('answers ping with pong', async () => {
      const socket = await connect(reader, urlA);
      socket.send({ type: 'ping', req_id: 'p1' });
      expect(await socket.next()).toEqual({ type: 'pong', req_id: 'p1' });
      socket.send({ type: 'ping' });
      expect(await socket.next()).toEqual({ type: 'pong' });
    });

    it('reports invalid messages without closing, and closes after too many', async () => {
      const socket = await connect(reader, urlA);
      socket.send('{not json');
      expect(await socket.next()).toMatchObject({
        type: 'error',
        req_id: null,
        code: 'VALIDATION_FAILED',
        errors: [{ code: 'MALFORMED_JSON' }],
      });
      socket.send({ type: 'hello', req_id: 'h1' });
      expect(await socket.next()).toMatchObject({
        type: 'error',
        req_id: 'h1',
        code: 'VALIDATION_FAILED',
      });
      socket.send({ type: 'subscribe', channel: 'table:nope', req_id: 's1' });
      expect(await socket.next()).toMatchObject({ type: 'error', req_id: 's1' });
      socket.send({ type: 'ping', req_id: 'still-open' });
      expect(await socket.next()).toEqual({ type: 'pong', req_id: 'still-open' });

      for (let index = 0; index < 7; index += 1) socket.send('[]');
      expect((await socket.closed).code).toBe(REALTIME_CLOSE_CODES.policyViolation);
    });

    it('closes the connection on a message over the size limit (1009)', async () => {
      const socket = await connect(reader, urlA);
      socket.send({ type: 'ping', req_id: 'x'.repeat(REALTIME_MAX_MESSAGE_BYTES) });
      expect((await socket.closed).code).toBe(REALTIME_CLOSE_CODES.messageTooBig);
    });

    it('drops a peer that stops answering protocol pings', async () => {
      const gateway = a.app.get(RealtimeGateway);
      const silent = await TestSocket.connect(urlA, {
        origin: ORIGIN,
        cookie: (await as(reader)).cookieHeader(),
        autoPong: false,
      });
      sockets.push(silent);
      const lively = await connect(reader, urlA);
      gateway.heartbeat();
      await new Promise((resolve) => setTimeout(resolve, 200));
      gateway.heartbeat();
      // Terminated without a close frame.
      expect((await silent.closed).code).toBe(1006);
      lively.send({ type: 'ping', req_id: 'alive' });
      expect(await lively.next()).toEqual({ type: 'pong', req_id: 'alive' });
    });

    it('closes with 4401 once the session has ended', async () => {
      const browser = new Browser(a.app);
      expect((await browser.login(reader.email)).statusCode).toBe(204);
      const socket = await TestSocket.connect(urlA, {
        origin: ORIGIN,
        cookie: browser.cookieHeader(),
      });
      sockets.push(socket);
      const limits = a.app.get(RealtimeLimits);
      const interval = limits.sessionRecheckIntervalMs;
      limits.sessionRecheckIntervalMs = 0;
      try {
        expect(
          (await browser.request({ method: 'POST', url: '/api/v1/auth/logout' })).statusCode,
        ).toBe(204);
        a.app.get(RealtimeGateway).heartbeat();
        expect((await socket.closed).code).toBe(REALTIME_CLOSE_CODES.unauthenticated);
      } finally {
        limits.sessionRecheckIntervalMs = interval;
      }
    });
  });

  describe('session end', () => {
    /** A socket of a fresh sign-in of `user` on instance B, subscribed to `user:<id>`. */
    async function signedIn(user: SeededUser): Promise<{ browser: Browser; socket: TestSocket }> {
      const browser = new Browser(a.app);
      expect((await browser.login(user.email)).statusCode).toBe(204);
      const socket = await TestSocket.connect(urlB, {
        origin: ORIGIN,
        cookie: browser.cookieHeader(),
      });
      sockets.push(socket);
      expect(await socket.subscribe(`user:${user.id}`)).toMatchObject({ type: 'subscribed' });
      return { browser, socket };
    }

    /** The close code, or `open` when the socket is still open after `ms`. */
    async function closedWithin(socket: TestSocket, ms: number): Promise<number | 'open'> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'open'>((resolve) => {
        timer = setTimeout(() => {
          resolve('open');
        }, ms);
      });
      const result = await Promise.race([socket.closed.then(({ code }) => code), timeout]);
      clearTimeout(timer);
      return result;
    }

    it('closes the sockets of a signed-out session on every instance at once', async () => {
      const user = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
      const ended = await signedIn(user);
      const other = await signedIn(user);
      // Signed out through instance A, no periodic check involved.
      expect(
        (await ended.browser.request({ method: 'POST', url: '/api/v1/auth/logout' })).statusCode,
      ).toBe(204);
      expect(await closedWithin(ended.socket, 5_000)).toBe(REALTIME_CLOSE_CODES.unauthenticated);
      // Another session of the same user stays.
      other.socket.send({ type: 'ping', req_id: 'still' });
      expect(await other.socket.next()).toEqual({ type: 'pong', req_id: 'still' });
    });

    it('closes the sockets of every session of a user whose sessions are all revoked', async () => {
      const user = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
      const first = await signedIn(user);
      const second = await signedIn(user);
      const sessions = a.app.get(SessionService);
      await db.withTx((tx) => sessions.revokeAllOfUser(user.id, tx));
      expect(await closedWithin(first.socket, 5_000)).toBe(REALTIME_CLOSE_CODES.unauthenticated);
      expect(await closedWithin(second.socket, 5_000)).toBe(REALTIME_CLOSE_CODES.unauthenticated);
    });

    it('never slides the session expiry from the periodic WebSocket check', async () => {
      const user = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
      const { socket } = await signedIn(user);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await db.kysely
        .updateTable('meta.sessions')
        .set({ last_seen_at: new Date(Date.now() - 60 * 60 * 1000), expires_at: expiresAt })
        .where('user_id', '=', user.id)
        .execute();
      const limits = b.app.get(RealtimeLimits);
      const interval = limits.sessionRecheckIntervalMs;
      limits.sessionRecheckIntervalMs = 0;
      try {
        b.app.get(RealtimeGateway).heartbeat();
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        limits.sessionRecheckIntervalMs = interval;
      }
      socket.send({ type: 'ping', req_id: 'checked' });
      expect(await socket.next()).toEqual({ type: 'pong', req_id: 'checked' });
      const row = await db.kysely
        .selectFrom('meta.sessions')
        .select(['expires_at'])
        .where('user_id', '=', user.id)
        .executeTakeFirstOrThrow();
      expect(row.expires_at.getTime()).toBe(expiresAt.getTime());
    });
  });

  describe('subscribe', () => {
    it('confirms readable channels', async () => {
      const socket = await connect(reader, urlA);
      for (const channel of [`base:${baseId}`, `table:${orders.id}`, `user:${reader.id}`]) {
        expect(await socket.subscribe(channel, `r-${channel}`)).toEqual({
          type: 'subscribed',
          req_id: `r-${channel}`,
          channel,
        });
      }
      // Subscribing again is idempotent.
      expect(await socket.subscribe(`base:${baseId}`, 'again')).toMatchObject({
        type: 'subscribed',
      });
      socket.send({ type: 'unsubscribe', channel: `base:${baseId}` });
      socket.send({ type: 'unsubscribe', channel: `base:${baseId}` });
      socket.send({ type: 'ping', req_id: 'after' });
      expect(await socket.next()).toEqual({ type: 'pong', req_id: 'after' });
    });

    it('answers NOT_FOUND for anything not readable, whatever the reason', async () => {
      const cases: [SeededUser, string][] = [
        [outsider, `base:${baseId}`],
        [outsider, `table:${orders.id}`],
        [stranger, `table:${orders.id}`],
        [stranger, `base:${baseId}`],
        [reader, `user:${owner.id}`],
        [reader, 'table:tbl_A1b2C3d4E5f6G7h8'],
        [reader, 'base:bse_A1b2C3d4E5f6G7h8'],
      ];
      for (const [user, channel] of cases) {
        const socket = await connect(user, urlB);
        expect(await socket.subscribe(channel, 'q')).toEqual({
          type: 'error',
          req_id: 'q',
          code: 'NOT_FOUND',
          channel,
        });
        socket.close();
      }
    });
  });

  describe('fan-out', () => {
    it('a schema change made through instance A reaches a client of instance B', async () => {
      const socket = await connect(reader, urlB);
      expect(await socket.subscribe(`table:${orders.id}`)).toMatchObject({ type: 'subscribed' });
      expect(await socket.subscribe(`base:${baseId}`)).toMatchObject({ type: 'subscribed' });

      const created = await call(owner, 'POST', `/tables/${orders.id}/fields`, {
        name: 'amount',
        type: 'number',
      });
      expect(created.statusCode).toBe(201);
      const fieldId = fieldSchema.parse(created.json()).id;
      expect(await socket.next(isType('schema.changed', `table:${orders.id}`))).toEqual({
        type: 'schema.changed',
        channel: `table:${orders.id}`,
        entity: 'field',
        entity_id: fieldId,
        action: 'created',
      });
      // A new field is part of every role's access: permission_version moved.
      expect(await socket.next(isType('permission.changed', `base:${baseId}`))).toEqual({
        type: 'permission.changed',
        channel: `base:${baseId}`,
      });

      // Table-level changes also go to the base channel.
      const renamed = await call(owner, 'PATCH', `/tables/${orders.id}`, { name: 'Sales orders' });
      expect(renamed.statusCode).toBe(200);
      for (const channel of [`table:${orders.id}`, `base:${baseId}`]) {
        expect(await socket.next(isType('schema.changed', channel))).toEqual({
          type: 'schema.changed',
          channel,
          entity: 'table',
          entity_id: orders.id,
          action: 'updated',
        });
      }
    });

    it('never names a table the subscriber cannot see', async () => {
      const outsiderSocket = await connect(outsider, urlB);
      expect(await outsiderSocket.subscribe(`base:${baseId}`)).toMatchObject({ type: 'error' });

      const hidden = await createTable(baseId, 'Hidden');
      const socket = await connect(revoked, urlB);
      expect(await socket.subscribe(`base:${baseId}`)).toMatchObject({ type: 'subscribed' });
      // A custom role without the table: the reader of that role must not
      // hear about it.
      const role = roleWithAdjustmentsSchema.parse(
        (
          await call(owner, 'POST', `/bases/${baseId}/roles`, {
            name: 'Orders only',
            config: { tables: { [orders.id]: { perm: 'read_only' } } },
          })
        ).json(),
      );
      const assigned = await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: revoked.id,
        role_id: role.id,
      });
      expect(assigned.statusCode).toBe(200);
      await socket.next(isType('permission.changed', `base:${baseId}`));
      expect(
        (await call(owner, 'PATCH', `/tables/${hidden.id}`, { name: 'Still hidden' })).statusCode,
      ).toBe(200);
      expect(
        (await call(owner, 'PATCH', `/tables/${orders.id}`, { name: 'Orders' })).statusCode,
      ).toBe(200);
      expect(await socket.next(isType('schema.changed', `base:${baseId}`))).toMatchObject({
        entity_id: orders.id,
      });
      await socket.expectNone(
        (message) => message.type === 'schema.changed' && message.entity_id === hidden.id,
      );
    });
  });

  describe('permission changes', () => {
    it('re-checks subscriptions: kept ones get permission.changed, lost ones NOT_FOUND', async () => {
      // `revoked` holds the "Orders only" role from the previous test.
      const socket = await connect(revoked, urlB);
      expect(await socket.subscribe(`base:${baseId}`)).toMatchObject({ type: 'subscribed' });
      expect(await socket.subscribe(`table:${orders.id}`)).toMatchObject({ type: 'subscribed' });
      expect(await socket.subscribe(`table:${customers.id}`)).toMatchObject({
        type: 'error',
        code: 'NOT_FOUND',
      });

      // Revoking the role through instance A (T109 API).
      const removed = await call(owner, 'DELETE', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: revoked.id,
      });
      expect(removed.statusCode).toBe(204);
      expect(await socket.next(isType('permission.changed', `base:${baseId}`))).toEqual({
        type: 'permission.changed',
        channel: `base:${baseId}`,
      });
      const lost = [await socket.next(isType('error')), await socket.next(isType('error'))].map(
        (message) => message.type === 'error' && [message.code, message.channel, message.req_id],
      );
      expect(lost).toEqual(
        expect.arrayContaining([
          ['NOT_FOUND', `base:${baseId}`, null],
          ['NOT_FOUND', `table:${orders.id}`, null],
        ]),
      );

      // Nothing more arrives on the removed channels.
      expect(
        (await call(owner, 'POST', `/tables/${orders.id}/fields`, { name: 'n2', type: 'number' }))
          .statusCode,
      ).toBe(201);
      await socket.expectNone((message) => message.type === 'schema.changed');
      // And subscribing again is refused.
      expect(await socket.subscribe(`table:${orders.id}`, 'retry')).toMatchObject({
        type: 'error',
        code: 'NOT_FOUND',
      });
    });
  });

  describe('limits', () => {
    it('refuses the 51st subscription of a connection', async () => {
      const limitsBase = baseDetailSchema.parse(
        (await call(owner, 'POST', `/workspaces/${workspaceId}/bases`, { name: 'Many' })).json(),
      ).id;
      const tables: TableDto[] = [];
      for (let index = 0; index < 49; index += 1) {
        tables.push(await createTable(limitsBase, `T${String(index)}`));
      }
      const socket = await connect(owner, urlA);
      const channels = [
        `base:${limitsBase}`,
        `user:${owner.id}`,
        ...tables.slice(0, 48).map((table) => `table:${table.id}`),
      ];
      for (const channel of channels) {
        expect(await socket.subscribe(channel)).toMatchObject({ type: 'subscribed' });
      }
      const last = `table:${tables[48]?.id ?? ''}`;
      expect(await socket.subscribe(last, 'fifty-one')).toEqual({
        type: 'error',
        req_id: 'fifty-one',
        code: 'VALIDATION_FAILED',
        channel: last,
        errors: [
          {
            path: 'channel',
            code: 'TOO_MANY_SUBSCRIPTIONS',
            message: 'A connection can hold at most 50 subscriptions.',
            params: { limit: 50 },
          },
        ],
      });
      // Freeing one makes room again.
      socket.send({ type: 'unsubscribe', channel: `user:${owner.id}` });
      expect(await socket.subscribe(last, 'fits')).toMatchObject({ type: 'subscribed' });

      const metrics = await a.app.get(MetricsService).render();
      // T706 split the gauge by `auth`; these are session connections.
      expect(metrics.body).toMatch(/^ws_connections\{auth="session"\} [1-9]\d*$/m);
      expect(metrics.body).toMatch(/^ws_subscriptions [1-9]\d*$/m);
      expect(metrics.body).not.toContain(org);
      socket.close();
    });
  });

  describe('job progress', () => {
    it('reaches user:<creator> from the api and from the worker', async () => {
      const socket = await connect(owner, urlB);
      expect(await socket.subscribe(`user:${owner.id}`)).toMatchObject({ type: 'subscribed' });
      const accepted = await call(owner, 'POST', `/orgs/${org}/audit-logs/export`, {
        format: 'csv',
      });
      expect(accepted.statusCode).toBe(202);
      const { job_id: jobId } = jobAcceptedSchema.parse(accepted.json());
      const forJob = (status: string) => (message: RealtimeServerMessage) =>
        message.type === 'job.progress' && message.job_id === jobId && message.status === status;
      expect(await socket.next(forJob('queued'))).toEqual({
        type: 'job.progress',
        channel: `user:${owner.id}`,
        job_id: jobId,
        progress: 0,
        status: 'queued',
      });

      worker = await createWorker(a.config, {
        logger: captureLogger().logger,
        pollIntervalMs: 100,
      });
      await socket.next(forJob('running'), 15_000);
      expect(await socket.next(forJob('succeeded'), 15_000)).toMatchObject({ progress: 1 });

      // Nobody else hears about it.
      const other = await connect(reader, urlB);
      expect(await other.subscribe(`user:${reader.id}`)).toMatchObject({ type: 'subscribed' });
      await other.expectNone((message) => message.type === 'job.progress');
    });
  });
});
