import {
  orgNotificationChannelsSchema,
  secretSchema,
  telegramLinkSchema,
  TELEGRAM_LINK_TOKEN_TTL_MS,
  userChannelListSchema,
  type Id,
  type RealtimeServerMessage,
  type SecretDto,
} from '@cellhive/contracts';
import { TelegramLinkPoller, type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';
import { startFakeTelegramBot, type FakeTelegramBot } from './telegram-bot-support.js';

const TOKEN_A = '424242001:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDapiCan';
const TOKEN_B = '424242002:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDapiCan';
const TOKEN_A_ROTATED = '424242001:CCHdqTcvCH1vGWJxfSeofSAs0K5PALDapiCan';
const TOKEN_C = '424242003:DDHdqTcvCH1vGWJxfSeofSAs0K5PALDapiCan';
const CHAT_SALES1 = 8_100_200_300;
const CHAT_READER = 8_100_200_400;

/**
 * BACKLOG T549 through the HTTP API (CONTRACTS §22.7, §24): the
 * organization's notification bot (owner/admin, `getMe` against a fake Bot
 * API), a member's link → `/start` through the poller → `linked` with a
 * realtime `channel.changed` in under 2 s, unlink, limits, the bot change,
 * the secret usage/`409`, P42 (only `me` routes; members `403`, other
 * organizations `404`) and canaries in responses, logs, audit and jobs.
 */
describe('notification channels: Telegram bot and personal links (T549)', () => {
  let database: TestDatabase;
  let db: Db;
  let appDb: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let telegram: FakeTelegramBot;
  let url: string;
  let botA: SecretDto;
  let botB: SecretDto;
  const sockets: TestSocket[] = [];
  const bodies: string[] = [];

  const org = (path = '') => `/orgs/${fx.orgId}${path}`;
  const me = (path = '') => org(`/me${path}`);

  async function call(
    user: FixtureUser,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    payload?: unknown,
  ) {
    const response = await fx.call(user, method, path, payload);
    bodies.push(response.body);
    return response;
  }

  async function createSecret(name: string, value: string): Promise<SecretDto> {
    const response = await call('owner', 'POST', org('/secrets'), {
      kind: 'telegram_bot',
      name,
      value,
    });
    expect(response.statusCode, response.body).toBe(201);
    return secretSchema.parse(response.json());
  }

  async function setBot(secretId: Id<'sec'> | null) {
    const response = await call('owner', 'PATCH', org('/notification-channels'), {
      telegram_secret_id: secretId,
    });
    expect(response.statusCode, response.body).toBe(200);
    return orgNotificationChannelsSchema.parse(response.json());
  }

  async function myChannels(user: FixtureUser) {
    const response = await call(user, 'GET', me('/channels'));
    expect(response.statusCode, response.body).toBe(200);
    return userChannelListSchema.parse(response.json());
  }

  async function createLink(user: FixtureUser) {
    const response = await call(user, 'POST', me('/channels/telegram'));
    expect(response.statusCode, response.body).toBe(201);
    const body = telegramLinkSchema.parse(response.json());
    const token = new URL(body.link).searchParams.get('start') ?? '';
    return { ...body, token };
  }

  async function own(user: FixtureUser): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    expect(await socket.subscribe(`user:${fx.users[user].id}`)).toMatchObject({
      type: 'subscribed',
    });
    return socket;
  }

  const channelChanged =
    (status: string) =>
    (message: RealtimeServerMessage): boolean =>
      message.type === 'channel.changed' && message.status === status;

  function poller() {
    return new TelegramLinkPoller(appDb, {
      masterKey: t.config.security.appMasterKey,
      defaults: { timeZone: 'UTC', locale: 'en' },
      client: { baseUrl: telegram.baseUrl },
      maxDurationMs: 4_000,
      pollTimeoutSeconds: 1,
    });
  }

  /** Runs one poll of the current bot, sending `text` from `chatId` once it waits. */
  async function startFromTelegram(secretId: Id<'sec'>, chatId: number, text: string) {
    const before = telegram.callsOf('getUpdates').length;
    const running = poller().poll(fx.orgId, secretId);
    for (let i = 0; i < 200 && telegram.callsOf('getUpdates').length === before; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const sentAt = Date.now();
    telegram.send({ chatId, text });
    return { running, sentAt };
  }

  async function auditActions(action: string) {
    const { rows } = await sql<{
      action: string;
      entity_id: string;
      before: unknown;
      after: unknown;
    }>`
      SELECT action, entity_id, before, after FROM meta.audit_logs
       WHERE action = ${action} AND organization_id = ${fx.orgId}
       ORDER BY created_at
    `.execute(db.kysely);
    return rows;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    telegram = await startFakeTelegramBot();
    telegram.setUsername(TOKEN_A, 'acme_notify_bot');
    telegram.setUsername(TOKEN_A_ROTATED, 'acme_notify_bot');
    telegram.setUsername(TOKEN_B, 'acme_other_bot');
    t = await startTestApp(
      { DATABASE_URL: database.url },
      { telegramClient: { baseUrl: telegram.baseUrl } },
    );
    appDb = t.app.get<Db>(DB);
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    botA = await createSecret('Thông báo', TOKEN_A);
    botB = await createSecret('Bot khác', TOKEN_B);
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await t.close();
    await telegram.close();
    await db.destroy();
    await database.drop();
  });

  it('without a bot: owners see nulls, members cannot link (422 TELEGRAM_NOT_CONFIGURED)', async () => {
    const response = await call('owner', 'GET', org('/notification-channels'));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      telegram: {
        secret_id: null,
        bot_username: null,
        status: null,
        delivery_mode: null,
        webhook_status: null,
        webhook_available: true,
      },
    });
    expect(await myChannels('u_sales1')).toEqual({ items: [], available_kinds: [] });
    expectProblem(
      await call('u_sales1', 'POST', me('/channels/telegram')),
      422,
      'TELEGRAM_NOT_CONFIGURED',
    );
  });

  it('P42: only owners/admins manage the bot (members 403, other organizations 404)', async () => {
    for (const user of ['u_admin', 'u_sales1', 'u_reader'] as const) {
      expectProblem(
        await call(user, 'GET', org('/notification-channels')),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(user, 'PATCH', org('/notification-channels'), { telegram_secret_id: botA.id }),
        403,
        'PERMISSION_DENIED',
      );
    }
    expectProblem(await call('stranger', 'GET', org('/notification-channels')), 404, 'NOT_FOUND');
    expectProblem(
      await call('stranger', 'PATCH', org('/notification-channels'), { telegram_secret_id: null }),
      404,
      'NOT_FOUND',
    );
    expectProblem(await call('stranger', 'GET', me('/channels')), 404, 'NOT_FOUND');
    expectProblem(await call('stranger', 'POST', me('/channels/telegram')), 404, 'NOT_FOUND');
    expectProblem(await call('stranger', 'DELETE', me('/channels/telegram')), 404, 'NOT_FOUND');
    expectProblem(
      await call('owner', 'GET', '/orgs/org_0000000000000000/notification-channels'),
      404,
      'NOT_FOUND',
    );
    // There is no route to another member's channels.
    expect(
      (await call('owner', 'GET', org(`/users/${fx.users.u_sales1.id}/channels`))).statusCode,
    ).toBe(404);
    expect(telegram.callsOf('getMe')).toEqual([]);
  });

  it('PATCH refuses what is not a telegram_bot secret of the organization, a refused token, no answer', async () => {
    const strangerOrgs = (await call('stranger', 'GET', '/orgs')).json<{
      items: { id: Id<'org'> }[];
    }>();
    const foreignOrg = strangerOrgs.items[0]?.id as Id<'org'>;
    const foreign = await call('stranger', 'POST', `/orgs/${foreignOrg}/secrets`, {
      kind: 'telegram_bot',
      name: 'Foreign',
      value: TOKEN_A,
    });
    expect(foreign.statusCode, foreign.body).toBe(201);
    const foreignId = secretSchema.parse(foreign.json()).id;
    for (const secretId of [foreignId, 'sec_0000000000000000']) {
      const response = await call('owner', 'PATCH', org('/notification-channels'), {
        telegram_secret_id: secretId,
      });
      expectProblem(response, 422, 'VALIDATION_FAILED');
      expect(problemOf(response.body)['errors']).toEqual([
        expect.objectContaining({ path: 'telegram_secret_id', code: 'UNKNOWN_SECRET' }),
      ]);
    }
    expectProblem(
      await call('owner', 'PATCH', org('/notification-channels'), { telegram_secret_id: 'x' }),
      422,
      'VALIDATION_FAILED',
    );
    expectProblem(
      await call('owner', 'PATCH', org('/notification-channels'), {}),
      422,
      'VALIDATION_FAILED',
    );

    telegram.revoke(TOKEN_A);
    try {
      const refused = await call('owner', 'PATCH', org('/notification-channels'), {
        telegram_secret_id: botA.id,
      });
      expectProblem(refused, 422, 'VALIDATION_FAILED');
      expect(problemOf(refused.body)['errors']).toEqual([
        expect.objectContaining({ path: 'telegram_secret_id', code: 'INVALID_BOT_TOKEN' }),
      ]);
    } finally {
      telegram.revoke(TOKEN_A, false);
    }
    telegram.queue('getMe', { status: 502, body: { ok: false, error_code: 502 } });
    expectProblem(
      await call('owner', 'PATCH', org('/notification-channels'), { telegram_secret_id: botA.id }),
      503,
      'DEPENDENCY_UNAVAILABLE',
    );
    // Nothing was saved.
    expect((await call('owner', 'GET', org('/notification-channels'))).json()).toEqual({
      telegram: {
        secret_id: null,
        bot_username: null,
        status: null,
        delivery_mode: null,
        webhook_status: null,
        webhook_available: true,
      },
    });
  });

  it('PATCH chooses the bot after getMe; audited as org.updated without the token', async () => {
    expect(await setBot(botA.id)).toEqual({
      telegram: {
        secret_id: botA.id,
        bot_username: 'acme_notify_bot',
        status: 'ok',
        delivery_mode: 'polling',
        webhook_status: null,
        webhook_available: true,
      },
    });
    expect(telegram.callsOf('getMe').at(-1)?.token).toBe(TOKEN_A);
    const audits = await auditActions('org.updated');
    expect(audits.at(-1)).toMatchObject({
      entity_id: fx.orgId,
      before: {
        settings: { notifications: { telegram_bot_secret_id: null, telegram_bot_username: null } },
      },
      after: {
        settings: {
          notifications: {
            telegram_bot_secret_id: botA.id,
            telegram_bot_username: 'acme_notify_bot',
          },
        },
      },
    });
    // The same bot again: nothing to audit.
    await setBot(botA.id);
    expect(await auditActions('org.updated')).toHaveLength(audits.length);
    expect((await call('owner', 'GET', org('/notification-channels'))).json()).toEqual({
      telegram: {
        secret_id: botA.id,
        bot_username: 'acme_notify_bot',
        status: 'ok',
        delivery_mode: 'polling',
        webhook_status: null,
        webhook_available: true,
      },
    });
  });

  it('the notification bot is a usage of its secret: listed first, delete → 409', async () => {
    const usages = await call('owner', 'GET', `/secrets/${botA.id}/usages`);
    expect(usages.json()).toEqual({ items: [{ kind: 'notification_channel' }], total: 1 });
    const blocked = await call('owner', 'DELETE', `/secrets/${botA.id}`);
    expectProblem(blocked, 409, 'SECRET_IN_USE');
    expect(problemOf(blocked.body)['errors']).toEqual([
      expect.objectContaining({
        code: 'SECRET_IN_USE',
        params: { usages: [{ kind: 'notification_channel' }], total: 1 },
      }),
    ]);
    expect((await call('owner', 'GET', `/secrets/${botB.id}/usages`)).json()).toEqual({
      items: [],
      total: 0,
    });
  });

  it('a member links Telegram: link, /start through the poller, linked in < 2 s with channel.changed', async () => {
    const socket = await own('u_sales1');
    expect(await myChannels('u_sales1')).toEqual({ items: [], available_kinds: ['telegram'] });
    const created = await createLink('u_sales1');
    expect(created.link).toMatch(/^https:\/\/t\.me\/acme_notify_bot\?start=[A-Za-z0-9_-]{32}$/u);
    const expires = new Date(created.expires_at).getTime();
    expect(Math.abs(expires - Date.now() - TELEGRAM_LINK_TOKEN_TTL_MS)).toBeLessThan(10_000);
    // The poll of the bot is queued in the same transaction (one per bot).
    const { rows: jobs } = await sql<{ payload: Record<string, unknown>; key: string | null }>`
      SELECT p.payload, p.key FROM graphile_worker.jobs j
        JOIN graphile_worker._private_jobs p USING (id)
       WHERE j.task_identifier = 'notifications.telegram_poll'
    `.execute(db.kysely);
    expect(jobs).toEqual([
      {
        payload: { organization_id: fx.orgId, secret_id: botA.id },
        key: `telegram_poll:${botA.id}`,
      },
    ]);
    expect((await myChannels('u_sales1')).items).toEqual([
      {
        kind: 'telegram',
        status: 'pending',
        error_reason: null,
        linked_at: null,
        bot_username: 'acme_notify_bot',
      },
    ]);

    const { running, sentAt } = await startFromTelegram(
      botA.id,
      CHAT_SALES1,
      `/start ${created.token}`,
    );
    const changed = await socket.next(channelChanged('linked'));
    const linked = await myChannels('u_sales1');
    expect(Date.now() - sentAt).toBeLessThan(2_000);
    expect(changed).toEqual({
      type: 'channel.changed',
      channel: `user:${fx.users.u_sales1.id}`,
      organization_id: fx.orgId,
      kind: 'telegram',
      status: 'linked',
    });
    expect(linked.items).toEqual([
      {
        kind: 'telegram',
        status: 'linked',
        error_reason: null,
        linked_at: expect.any(String) as string,
        bot_username: 'acme_notify_bot',
      },
    ]);
    expect((await running).outcome).toBe('done');
    // Another member sees nothing of it.
    expect((await myChannels('u_sales2')).items).toEqual([]);
    expect((await auditActions('user_channel.linked')).at(-1)).toMatchObject({
      entity_id: fx.users.u_sales1.id,
      after: { kind: 'telegram', source: 'telegram_start' },
    });
  });

  it('the same token again or a guessed one links nothing', async () => {
    const created = await createLink('u_reader');
    await call('u_reader', 'DELETE', me('/channels/telegram')); // cancels the pending link
    const keep = await createLink('u_editor'); // keeps the poller going
    const { running } = await startFromTelegram(botA.id, CHAT_READER, `/start ${created.token}`);
    telegram.send({ chatId: CHAT_READER, text: `/start ${'A'.repeat(32)}` });
    const result = await running;
    expect(result).toMatchObject({ linked: 0, refused: 2 });
    expect((await myChannels('u_reader')).items).toEqual([]);
    await call('u_editor', 'DELETE', me('/channels/telegram'));
    expect(keep.token).not.toBe(created.token);
  });

  it('5 links per hour (429 with Retry-After), at most 5 pending', async () => {
    for (let i = 0; i < 5; i += 1) await createLink('u_sales2');
    const limited = await call('u_sales2', 'POST', me('/channels/telegram'));
    expectProblem(limited, 429, 'RATE_LIMITED');
    const retryAfter = Number(limited.headers['retry-after']);
    // Whole seconds (QA S5b L2: the window end is fractional; AppError rounds up).
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(3_500);
    expect(retryAfter).toBeLessThanOrEqual(3_600);
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM meta.user_channel_link_tokens
       WHERE organization_id = ${fx.orgId} AND user_id = ${fx.users.u_sales2.id}
         AND used_at IS NULL AND expires_at > now()
    `.execute(db.kysely);
    expect(Number(rows[0]?.n)).toBe(5);
    // Unlinking cancels them (and does not reset the hourly count).
    expect((await call('u_sales2', 'DELETE', me('/channels/telegram'))).statusCode).toBe(204);
    expect((await myChannels('u_sales2')).items).toEqual([]);
    expectProblem(await call('u_sales2', 'POST', me('/channels/telegram')), 429, 'RATE_LIMITED');
  });

  it('P42: a member only ever touches their own channel', async () => {
    const created = await createLink('u_reader');
    const { running } = await startFromTelegram(botA.id, CHAT_READER, `/start ${created.token}`);
    await running;
    expect((await myChannels('u_reader')).items[0]?.status).toBe('linked');
    // u_sales1 unlinks: their channel only.
    const socket = await own('u_sales1');
    expect((await call('u_sales1', 'DELETE', me('/channels/telegram'))).statusCode).toBe(204);
    expect(await socket.next(channelChanged('unlinked'))).toMatchObject({
      organization_id: fx.orgId,
      kind: 'telegram',
    });
    expect((await myChannels('u_sales1')).items).toEqual([]);
    expect((await myChannels('u_reader')).items[0]?.status).toBe('linked');
    // Idempotent: no second audit entry.
    const unlinked = (await auditActions('user_channel.unlinked')).length;
    expect((await call('u_sales1', 'DELETE', me('/channels/telegram'))).statusCode).toBe(204);
    expect(await auditActions('user_channel.unlinked')).toHaveLength(unlinked);
    expect((await auditActions('user_channel.unlinked')).at(-1)).toMatchObject({
      entity_id: fx.users.u_sales1.id,
      before: { kind: 'telegram', source: 'api' },
    });
  });

  it('a new token of the same bot keeps channels; another bot puts them in error', async () => {
    const same = await call('owner', 'PATCH', `/secrets/${botA.id}`, { value: TOKEN_A_ROTATED });
    expect(same.statusCode, same.body).toBe(200);
    expect((await myChannels('u_reader')).items[0]?.status).toBe('linked');

    telegram.revoke(TOKEN_B);
    try {
      const refused = await call('owner', 'PATCH', `/secrets/${botA.id}`, { value: TOKEN_B });
      expectProblem(refused, 422, 'VALIDATION_FAILED');
      expect(problemOf(refused.body)['errors']).toEqual([
        expect.objectContaining({ path: 'value', code: 'INVALID_BOT_TOKEN' }),
      ]);
    } finally {
      telegram.revoke(TOKEN_B, false);
    }
    expect((await myChannels('u_reader')).items[0]?.status).toBe('linked');

    const socket = await own('u_reader');
    const other = await call('owner', 'PATCH', `/secrets/${botA.id}`, { value: TOKEN_B });
    expect(other.statusCode, other.body).toBe(200);
    expect(await socket.next(channelChanged('error'))).toMatchObject({ kind: 'telegram' });
    expect((await myChannels('u_reader')).items).toEqual([
      {
        kind: 'telegram',
        status: 'error',
        error_reason: 'bot_changed',
        linked_at: expect.any(String) as string,
        bot_username: 'acme_other_bot',
      },
    ]);
    expect((await call('owner', 'GET', org('/notification-channels'))).json()).toEqual({
      telegram: {
        secret_id: botA.id,
        bot_username: 'acme_other_bot',
        status: 'ok',
        delivery_mode: 'polling',
        webhook_status: null,
        webhook_available: true,
      },
    });
    // Back to the first bot for the next steps.
    expect(
      (await call('owner', 'PATCH', `/secrets/${botA.id}`, { value: TOKEN_A })).statusCode,
    ).toBe(200);
  });

  it('a pending link shows over an error; relinking clears the error', async () => {
    const created = await createLink('u_reader');
    expect((await myChannels('u_reader')).items[0]).toMatchObject({ status: 'pending' });
    const { running } = await startFromTelegram(botA.id, CHAT_READER, `/start ${created.token}`);
    await running;
    expect((await myChannels('u_reader')).items[0]).toMatchObject({
      status: 'linked',
      error_reason: null,
    });
  });

  it('changing the bot puts every channel in error and cancels pending links; null removes it', async () => {
    const socket = await own('u_reader');
    const pending = await createLink('u_editor');
    const before = (await auditActions('org.updated')).length;
    expect(await setBot(botB.id)).toEqual({
      telegram: {
        secret_id: botB.id,
        bot_username: 'acme_other_bot',
        status: 'ok',
        delivery_mode: 'polling',
        webhook_status: null,
        webhook_available: true,
      },
    });
    expect(await socket.next(channelChanged('error'))).toMatchObject({ kind: 'telegram' });
    expect((await myChannels('u_reader')).items[0]).toMatchObject({
      status: 'error',
      error_reason: 'bot_changed',
      bot_username: 'acme_other_bot',
    });
    expect((await myChannels('u_editor')).items).toEqual([]);
    const { rows } = await sql<{ used_at: Date | null }>`
      SELECT used_at FROM meta.user_channel_link_tokens
       WHERE organization_id = ${fx.orgId} AND token_hash = encode(sha256(${pending.token}::bytea), 'hex')
    `.execute(db.kysely);
    expect(rows[0]?.used_at).not.toBeNull();
    expect(await auditActions('org.updated')).toHaveLength(before + 1);
    // The old bot is no longer used; the new one is.
    expect((await call('owner', 'GET', `/secrets/${botA.id}/usages`)).json()).toEqual({
      items: [],
      total: 0,
    });
    expect((await call('owner', 'GET', `/secrets/${botB.id}/usages`)).json()).toEqual({
      items: [{ kind: 'notification_channel' }],
      total: 1,
    });

    expect(await setBot(null)).toEqual({
      telegram: {
        secret_id: null,
        bot_username: null,
        status: null,
        delivery_mode: null,
        webhook_status: null,
        webhook_available: true,
      },
    });
    expect(await myChannels('u_reader')).toEqual({
      items: [
        {
          kind: 'telegram',
          status: 'error',
          error_reason: 'bot_changed',
          linked_at: expect.any(String) as string,
          bot_username: null,
        },
      ],
      available_kinds: [],
    });
    expectProblem(
      await call('u_reader', 'POST', me('/channels/telegram')),
      422,
      'TELEGRAM_NOT_CONFIGURED',
    );
    expect((await call('owner', 'DELETE', `/secrets/${botB.id}`)).statusCode).toBe(204);
  });

  it('QA S5b M3: a bot that is the notification bot of another organization is refused (BOT_IN_USE)', async () => {
    const foreignOrg = (await call('stranger', 'GET', '/orgs')).json<{
      items: { id: Id<'org'> }[];
    }>().items[0]?.id as Id<'org'>;
    const foreignPath = (path: string) => `/orgs/${foreignOrg}${path}`;
    const foreignSecret = async (name: string, value: string) => {
      const created = await call('stranger', 'POST', foreignPath('/secrets'), {
        kind: 'telegram_bot',
        name,
        value,
      });
      expect(created.statusCode, created.body).toBe(201);
      return secretSchema.parse(created.json()).id;
    };
    telegram.setUsername(TOKEN_C, 'foreign_notify_bot');
    const foreignA = await foreignSecret('Foreign A', TOKEN_A);
    const foreignC = await foreignSecret('Foreign C', TOKEN_C);

    // This organization takes bot A (424242001) first.
    await setBot(botA.id);
    const notificationBot = (secretId: Id<'sec'> | null) =>
      call('stranger', 'PATCH', foreignPath('/notification-channels'), {
        telegram_secret_id: secretId,
      });

    // The other organization's own secret of the same bot: refused, nothing saved.
    const refused = await notificationBot(foreignA);
    expectProblem(refused, 422, 'VALIDATION_FAILED');
    expect(problemOf(refused.body)['errors']).toEqual([
      expect.objectContaining({ path: 'telegram_secret_id', code: 'BOT_IN_USE' }),
    ]);
    expect(refused.body).not.toContain(fx.orgId);
    expect((await call('stranger', 'GET', foreignPath('/notification-channels'))).json()).toEqual({
      telegram: {
        secret_id: null,
        bot_username: null,
        status: null,
        delivery_mode: null,
        webhook_status: null,
        webhook_available: true,
      },
    });

    // Another bot is fine; turning its token into bot A's is refused the same way.
    expect((await notificationBot(foreignC)).statusCode).toBe(200);
    const swapped = await call('stranger', 'PATCH', `/secrets/${foreignC}`, { value: TOKEN_A });
    expectProblem(swapped, 422, 'VALIDATION_FAILED');
    expect(problemOf(swapped.body)['errors']).toEqual([
      expect.objectContaining({ path: 'value', code: 'BOT_IN_USE' }),
    ]);
    expect((await call('stranger', 'GET', foreignPath('/notification-channels'))).json()).toEqual({
      telegram: {
        secret_id: foreignC,
        bot_username: 'foreign_notify_bot',
        status: 'ok',
        delivery_mode: 'polling',
        webhook_status: null,
        webhook_available: true,
      },
    });

    // Once this organization lets bot A go, the other one may take it.
    await setBot(null);
    expect((await notificationBot(foreignA)).statusCode).toBe(200);
    expect((await notificationBot(null)).statusCode).toBe(200);
  });

  it('canaries: no bot token, link token, chat id or Telegram name in responses, logs, audit or jobs', async () => {
    const { rows: audit } = await sql`SELECT * FROM meta.audit_logs`.execute(db.kysely);
    const { rows: events } = await sql`SELECT * FROM meta.events`.execute(db.kysely);
    const { rows: jobs } = await sql`SELECT payload FROM graphile_worker._private_jobs`.execute(
      db.kysely,
    );
    const { rows: tokens } = await sql`SELECT * FROM meta.user_channel_link_tokens`.execute(
      db.kysely,
    );
    const { rows: channels } = await sql`SELECT * FROM meta.user_channels`.execute(db.kysely);
    const stored = JSON.stringify({ audit, events, jobs, tokens, channels });
    const logs = t.logs.raw();
    const linkTokens = bodies
      .flatMap((body) => [...body.matchAll(/start=([A-Za-z0-9_-]{32})/gu)].map((m) => m[1] ?? ''))
      .filter((token) => token !== '');
    expect(linkTokens.length).toBeGreaterThan(5);
    for (const canary of [
      TOKEN_A,
      TOKEN_B,
      TOKEN_A_ROTATED,
      TOKEN_C,
      TOKEN_A.split(':')[1] ?? '',
      String(CHAT_SALES1),
      String(CHAT_READER),
      'Secret Name',
      ...linkTokens,
    ]) {
      expect(logs).not.toContain(canary);
      expect(stored).not.toContain(canary);
      if (!linkTokens.includes(canary)) {
        for (const body of bodies) expect(body).not.toContain(canary);
      }
    }
  });
});
