import {
  orgNotificationChannelsSchema,
  secretSchema,
  telegramLinkSchema,
  type RealtimeServerMessage,
  type SecretDto,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser } from './auth-support.js';
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

const TOKEN = '434343001:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDwebhook';
const CHAT = 8_200_300_400;
const WEBHOOK_PREFIX = `${TEST_PUBLIC_URL}/api/v1/telegram/webhook/`;

/**
 * BACKLOG T609 through the HTTP API (CONTRACTS §22.7, ADR-35 §7; fake Bot
 * API with `setWebhook`/`deleteWebhook`/`getWebhookInfo`): the webhook mode
 * of the notification bot — `http` `PUBLIC_URL` → `422`, a webhook of
 * another integration → `422 TELEGRAM_WEBHOOK_CONFLICT` (not overwritten),
 * `/start` through the public route links in under 1 s with
 * `channel.changed`, wrong secret `401`, unknown path `404`, body over
 * 1 MiB `413`, `/stop` at once, back to `polling` calls `deleteWebhook` and
 * the poller takes over; P51; canaries for the `secret_token`, the path
 * token and the bot token in responses, logs, audit and job payloads.
 */
describe('notification bot webhook mode over HTTP (T609)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let telegram: FakeTelegramBot;
  let url: string;
  let bot: SecretDto;
  const sockets: TestSocket[] = [];
  const bodies: string[] = [];

  const org = (path = '') => `/orgs/${fx.orgId}${path}`;

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

  async function patch(body: Record<string, unknown>, user: FixtureUser = 'owner') {
    return call(user, 'PATCH', org('/notification-channels'), body);
  }

  /** What Telegram posts to the registered URL. */
  async function deliver(
    update: Record<string, unknown>,
    options: { secret?: string | null; path?: string; raw?: string } = {},
  ) {
    const registered = telegram.webhookUrl();
    const path = options.path ?? registered.slice(registered.lastIndexOf('/') + 1);
    const secret = options.secret === undefined ? telegram.webhookSecret() : options.secret;
    const response = await t.app.inject({
      method: 'POST',
      url: `/api/v1/telegram/webhook/${path}`,
      headers: {
        'content-type': 'application/json',
        ...(secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret }),
      },
      payload: options.raw ?? JSON.stringify(update),
    });
    bodies.push(response.body);
    return response;
  }

  let nextUpdate = 1;
  const message = (text: string, chatId = CHAT) => ({
    update_id: (nextUpdate += 1),
    message: {
      message_id: nextUpdate,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'Hidden Name', language_code: 'en' },
      text,
    },
  });

  async function jobs(task: string) {
    const { rows } = await sql<{ payload: unknown }>`
      SELECT j.payload FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = ${task}
    `.execute(db.kysely);
    return rows.map((row) => row.payload);
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    telegram = await startFakeTelegramBot();
    telegram.setUsername(TOKEN, 'acme_hook_bot');
    t = await startTestApp(
      { DATABASE_URL: database.url },
      { telegramClient: { baseUrl: telegram.baseUrl } },
    );
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    const created = await call('owner', 'POST', org('/secrets'), {
      kind: 'telegram_bot',
      name: 'Notifications',
      value: TOKEN,
    });
    expect(created.statusCode, created.body).toBe(201);
    bot = secretSchema.parse(created.json());
    const chosen = await patch({ telegram_secret_id: bot.id });
    expect(chosen.statusCode, chosen.body).toBe(200);
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await t.close();
    await telegram.close();
    await db.destroy();
    await database.drop();
  });

  it('GET shows polling by default; PATCH needs at least one key', async () => {
    const response = await call('owner', 'GET', org('/notification-channels'));
    expect(orgNotificationChannelsSchema.parse(response.json()).telegram).toMatchObject({
      secret_id: bot.id,
      delivery_mode: 'polling',
      webhook_status: null,
      webhook_available: true,
    });
    expectProblem(await patch({}), 422, 'VALIDATION_FAILED');
  });

  it('an http PUBLIC_URL refuses the webhook mode (422 PUBLIC_URL_NOT_HTTPS), Telegram untouched', async () => {
    const plain = await startTestApp(
      { DATABASE_URL: database.url, PUBLIC_URL: 'http://cellhive.test' },
      { telegramClient: { baseUrl: telegram.baseUrl } },
    );
    try {
      const browser = new Browser(plain.app);
      expect((await browser.login(fx.users.owner.email)).statusCode).toBe(204);
      // T616: the screen knows beforehand that this instance cannot use the webhook mode.
      const before = await browser.request({
        method: 'GET',
        url: `/api/v1${org('/notification-channels')}`,
      });
      expect(orgNotificationChannelsSchema.parse(before.json()).telegram.webhook_available).toBe(
        false,
      );
      const response = await browser.request({
        method: 'PATCH',
        url: `/api/v1${org('/notification-channels')}`,
        payload: { telegram_delivery_mode: 'webhook' },
      });
      expectProblem(response, 422, 'VALIDATION_FAILED');
      expect(problemOf(response.body)['errors']).toEqual([
        expect.objectContaining({ path: 'telegram_delivery_mode', code: 'PUBLIC_URL_NOT_HTTPS' }),
      ]);
    } finally {
      await plain.close();
    }
    expect(telegram.callsOf('setWebhook')).toEqual([]);
    expect(telegram.callsOf('getWebhookInfo')).toEqual([]);
  });

  it('a webhook of another integration → 422 TELEGRAM_WEBHOOK_CONFLICT, never overwritten', async () => {
    telegram.setWebhook(true);
    try {
      const response = await patch({ telegram_delivery_mode: 'webhook' });
      expectProblem(response, 422, 'VALIDATION_FAILED');
      expect(problemOf(response.body)['errors']).toEqual([
        expect.objectContaining({ code: 'TELEGRAM_WEBHOOK_CONFLICT' }),
      ]);
      expect(telegram.callsOf('setWebhook')).toEqual([]);
      expect(telegram.webhookUrl()).toBe('https://elsewhere.example/telegram');
    } finally {
      telegram.setWebhook(false);
    }
  });

  it('P51: only owners/admins switch the mode (members 403, other organizations 404)', async () => {
    for (const user of ['u_sales1', 'u_reader'] as const) {
      expectProblem(
        await patch({ telegram_delivery_mode: 'webhook' }, user),
        403,
        'PERMISSION_DENIED',
      );
    }
    expectProblem(await patch({ telegram_delivery_mode: 'webhook' }, 'stranger'), 404, 'NOT_FOUND');
    expect(telegram.callsOf('setWebhook')).toEqual([]);
  });

  it('webhook mode: setWebhook, audit; /start through the route links in < 1 s; /stop at once', async () => {
    const response = await patch({ telegram_delivery_mode: 'webhook' });
    expect(response.statusCode, response.body).toBe(200);
    expect(orgNotificationChannelsSchema.parse(response.json()).telegram).toMatchObject({
      delivery_mode: 'webhook',
      webhook_status: 'ok',
    });
    const [set] = telegram.callsOf('setWebhook');
    expect(set?.body).toMatchObject({ allowed_updates: ['message'], max_connections: 10 });
    expect(telegram.webhookUrl().startsWith(WEBHOOK_PREFIX)).toBe(true);
    const { rows: audit } = await sql<{ after: unknown }>`
      SELECT after FROM meta.audit_logs
       WHERE action = 'org.updated' AND organization_id = ${fx.orgId}
       ORDER BY created_at DESC LIMIT 1
    `.execute(db.kysely);
    expect(audit[0]?.after).toEqual({
      settings: {
        notifications: {
          telegram_bot_secret_id: bot.id,
          telegram_bot_username: 'acme_hook_bot',
          telegram_delivery_mode: 'webhook',
        },
      },
    });
    // The same request again: nothing changes at Telegram.
    expect((await patch({ telegram_delivery_mode: 'webhook' })).statusCode).toBe(200);
    expect(telegram.callsOf('setWebhook')).toHaveLength(1);

    // A link in webhook mode queues no poll.
    const created = await call('u_sales1', 'POST', org('/me/channels/telegram'));
    expect(created.statusCode, created.body).toBe(201);
    const link = new URL(telegramLinkSchema.parse(created.json()).link).searchParams.get('start');
    expect(await jobs('notifications.telegram_poll')).toEqual([]);

    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie('u_sales1'),
    });
    sockets.push(socket);
    await socket.subscribe(`user:${fx.users.u_sales1.id}`);
    const started = Date.now();
    const delivered = await deliver(message(`/start ${link ?? ''}`));
    expect(delivered.statusCode, delivered.body).toBe(200);
    await socket.next(
      (item: RealtimeServerMessage) => item.type === 'channel.changed' && item.status === 'linked',
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    const mine = await call('u_sales1', 'GET', org('/me/channels'));
    expect(mine.json()).toMatchObject({ items: [{ kind: 'telegram', status: 'linked' }] });
    // The reply is a job, not sent in the request.
    expect(telegram.callsOf('sendMessage')).toEqual([]);
    expect(await jobs('notifications.telegram_reply')).toHaveLength(1);

    // Telegram retries what is not 2xx: unrelated updates and bad links still answer 200.
    expect((await deliver({ update_id: (nextUpdate += 1), edited_message: {} })).statusCode).toBe(
      200,
    );
    expect((await deliver(message('/start not-a-token'))).statusCode).toBe(200);

    expect((await deliver(message('/stop'))).statusCode).toBe(200);
    await socket.next(
      (item: RealtimeServerMessage) =>
        item.type === 'channel.changed' && item.status === 'unlinked',
    );
    expect((await call('u_sales1', 'GET', org('/me/channels'))).json()).toMatchObject({
      items: [],
    });
  });

  it('P51: wrong secret header 401, unknown path 404, body over 1 MiB 413', async () => {
    expectProblem(await deliver(message('/stop'), { secret: 'wrong' }), 401, 'UNAUTHENTICATED');
    expectProblem(await deliver(message('/stop'), { secret: null }), 401, 'UNAUTHENTICATED');
    expectProblem(await deliver(message('/stop'), { path: 'x'.repeat(32) }), 404, 'NOT_FOUND');
    expectProblem(await deliver(message('/stop'), { path: 'nope' }), 404, 'NOT_FOUND');
    const huge = JSON.stringify({ ...message('/stop'), padding: 'p'.repeat(1024 * 1024) });
    expectProblem(await deliver({}, { raw: huge }), 413, 'PAYLOAD_TOO_LARGE');
    // An unknown path answers 404 even with a huge body (path first).
    expectProblem(await deliver({}, { raw: huge, path: 'y'.repeat(32) }), 404, 'NOT_FOUND');
  });

  it('back to polling: deleteWebhook, the old path is gone, the poller takes over', async () => {
    const old = telegram.webhookUrl();
    const oldPath = old.slice(old.lastIndexOf('/') + 1);
    const response = await patch({ telegram_delivery_mode: 'polling' });
    expect(response.statusCode, response.body).toBe(200);
    expect(orgNotificationChannelsSchema.parse(response.json()).telegram).toMatchObject({
      delivery_mode: 'polling',
      webhook_status: null,
    });
    expect(telegram.callsOf('deleteWebhook')).toHaveLength(1);
    expect(telegram.webhookUrl()).toBe('');
    expectProblem(await deliver(message('/stop'), { path: oldPath }), 404, 'NOT_FOUND');
    const created = await call('u_reader', 'POST', org('/me/channels/telegram'));
    expect(created.statusCode).toBe(201);
    expect(await jobs('notifications.telegram_poll')).toHaveLength(1);
  });

  it('canaries: no secret_token, path token or bot token in responses, logs, audit or jobs', async () => {
    // Webhook mode once more to have a live secret and path.
    expect((await patch({ telegram_delivery_mode: 'webhook' })).statusCode).toBe(200);
    expect((await deliver(message('/start not-a-token'))).statusCode).toBe(200);
    const registered = telegram.webhookUrl();
    const secrets: string[] = [];
    for (const call of telegram.callsOf('setWebhook')) {
      secrets.push(String(call.body['secret_token']));
      const hook = String(call.body['url']);
      secrets.push(hook.slice(hook.lastIndexOf('/') + 1));
    }
    expect(secrets).toContain(registered.slice(registered.lastIndexOf('/') + 1));
    const { rows: audit } = await sql`SELECT * FROM meta.audit_logs`.execute(db.kysely);
    const { rows: stored } = await sql`
      SELECT payload::jsonb FROM graphile_worker._private_jobs
      UNION ALL SELECT to_jsonb(w) FROM meta.telegram_webhooks w
      UNION ALL SELECT settings FROM meta.organizations
    `.execute(db.kysely);
    const dump = JSON.stringify({ audit, stored });
    const logs = t.logs.raw();
    for (const canary of [
      ...secrets,
      TOKEN,
      TOKEN.split(':')[1] ?? '',
      String(CHAT),
      'Hidden Name',
    ]) {
      expect(dump).not.toContain(canary);
      expect(logs).not.toContain(canary);
      for (const body of bodies) expect(body).not.toContain(canary);
    }
  });
});
