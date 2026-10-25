import { createServer, type Server } from 'node:http';

import { newId, type Id } from '@cellhive/contracts';
import {
  BasesRepository,
  deriveSecretKey,
  enqueueNotification,
  orgScope,
  sealSecret,
  TelegramChatAddress,
  UserChannelsRepository,
  withOrgTelegramSettings,
  type Db,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker, type WorkerHandle } from '../../src/index.js';
import { buildTaskList } from '../../src/tasks/index.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  testConfig,
  waitFor,
  type CapturedLogger,
  type TestDatabase,
} from './support.js';

const ORG: Id<'org'> = 'org_TgDeliverWorker1';
const USER: Id<'usr'> = 'usr_TgDeliverWorkUs1';
const AUT: Id<'aut'> = 'aut_TgDeliverWorkAu1';
const RUN: Id<'run'> = 'run_TgDeliverWorkRu1';
const SECRET: Id<'sec'> = 'sec_TgDeliverWorkSe1';
const BOT_TOKEN = '777000222:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDdeliv';
const CHAT = '7123000789';
const BODY = 'never-logged-telegram-body';

/** A fake Bot API (no real network): `sendMessage` with answers that can be forced. */
async function startBot() {
  const sent: { chat_id: unknown; text: unknown; at: number }[] = [];
  const forced: { status: number; body: unknown }[] = [];
  /** When each forced (refused) answer was sent, by the server itself. */
  const refusedAt: number[] = [];
  let calls = 0;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        unknown
      >;
      calls += 1;
      const reply = forced.shift();
      if (reply !== undefined) {
        refusedAt.push(Date.now());
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(reply.body));
        return;
      }
      sent.push({ chat_id: body['chat_id'], text: body['text'], at: Date.now() });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`,
    sent,
    refusedAt,
    calls: () => calls,
    force: (status: number, body: unknown) => forced.push({ status, body }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * BACKLOG T550 through the running worker: `enqueueNotification` →
 * `notifications.fanout` queues a Telegram delivery → `notifications.deliver`
 * (channel `telegram`) sends one grouped message to the linked chat; a `429
 * retry_after 2` is sent again 2 seconds later by the rescheduled job;
 * nothing secret (token, chat id, content) in the logs.
 */
describe('worker: notifications over Telegram (T550)', () => {
  let database: TestDatabase;
  let db: Db;
  let worker: WorkerHandle;
  let captured: CapturedLogger;
  let bot: Awaited<ReturnType<typeof startBot>>;
  let baseId: Id<'bse'>;

  async function statuses() {
    return db.kysely
      .selectFrom('meta.notification_deliveries')
      .select(['status', 'error_code'])
      .where('channel', '=', 'telegram')
      .orderBy('created_at')
      .execute();
  }

  async function notify(title: string) {
    await db.withTx((tx) =>
      enqueueNotification(tx, {
        organizationId: ORG,
        type: 'automation.message',
        baseId,
        entityType: 'automation',
        entityId: AUT,
        userIds: [USER],
        data: { automation_id: AUT, run_id: RUN, title, body: BODY },
      }),
    );
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    bot = await startBot();
    const config = testConfig(database.url);
    await db.kysely
      .insertInto('meta.organizations')
      .values({
        id: ORG,
        name: 'Acme',
        slug: 'acme-tg-deliver',
        settings: withOrgTelegramSettings(
          {},
          { secretId: SECRET, botId: 777000222, botUsername: 'acme_bot', status: 'ok' },
        ),
      })
      .execute();
    await db.kysely
      .insertInto('meta.users')
      .values({ id: USER, email: 'tg-notified@example.test', display_name: 'Notified' })
      .execute();
    await db.kysely
      .insertInto('meta.org_members')
      .values({ organization_id: ORG, user_id: USER, role: 'owner' })
      .execute();
    await db.kysely
      .insertInto('meta.workspaces')
      .values({ id: 'wsp_TgDeliverWorkWs1', organization_id: ORG, name: 'Main', slug: 'main' })
      .execute();
    const base = await new BasesRepository(db).create(orgScope(ORG), {
      workspaceId: 'wsp_TgDeliverWorkWs1',
      ownerId: USER,
      name: 'Sales',
    });
    baseId = base.id;
    await db.kysely
      .insertInto('meta.secrets')
      .values({
        id: SECRET,
        organization_id: ORG,
        kind: 'telegram_bot',
        name: 'Notifications',
        ciphertext: sealSecret(
          deriveSecretKey(config.security.appMasterKey, 'org-secret'),
          BOT_TOKEN,
        ),
      })
      .execute();
    const address = new TelegramChatAddress(config.security.appMasterKey);
    await new UserChannelsRepository(db).upsertLinked(orgScope(ORG), {
      id: newId('uch'),
      userId: USER,
      kind: 'telegram',
      secretId: SECRET,
      addressEnc: address.seal(CHAT),
      addressHmac: address.lookup(SECRET, CHAT),
      linkedAt: new Date(),
    });
    captured = captureLogger();
    worker = await createWorker(config, {
      logger: captured.logger,
      pollIntervalMs: 200,
      taskList: buildTaskList({
        config,
        db,
        logger: captured.logger,
        telegramClient: { baseUrl: bot.baseUrl },
        notificationTelegramBatchMs: 1_500,
      }),
    });
  });

  afterAll(async () => {
    await worker.close();
    await bot.close();
    await db.destroy();
    await database.drop();
  });

  it('three notifications within the batch window → one Telegram message, deliveries sent', async () => {
    for (const title of ['Canary One', 'Canary Two', 'Canary Three']) await notify(title);
    await waitFor(() => Promise.resolve(bot.sent.length > 0), { what: 'the Telegram message' });
    // The batch window is over: no second message follows.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(bot.sent).toHaveLength(1);
    const [message] = bot.sent;
    expect(message?.chat_id).toBe(CHAT);
    const text = String(message?.text);
    expect(text.startsWith('<b>3 new notifications in Acme</b>')).toBe(true);
    for (const part of ['Canary One', 'Canary Two', 'Canary Three', BODY]) {
      expect(text).toContain(part);
    }
    expect(await statuses()).toEqual([
      { status: 'sent', error_code: null },
      { status: 'sent', error_code: null },
      { status: 'sent', error_code: null },
    ]);
    const lines = captured.lines.filter(
      (line) => line['msg'] === 'notification Telegram message sent',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ org_id: ORG, user_id: USER, sent: 3, shown: 3 });
    expect(captured.lines.find((line) => line['msg'] === 'notifications fanned out')).toMatchObject(
      { telegram_queued: 1 },
    );
    // Nothing secret in the logs.
    const raw = captured.raw();
    for (const secret of [BOT_TOKEN, 'AAHdqTcv', CHAT, BODY, 'Canary']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('429 retry_after 2 → the deliveries wait and are sent 2 seconds later', async () => {
    const before = bot.sent.length;
    const callsBefore = bot.calls();
    bot.force(429, { ok: false, error_code: 429, parameters: { retry_after: 2 } });
    await notify('Rate limited');
    await waitFor(() => Promise.resolve(bot.calls() > callsBefore), { what: 'the first call' });
    // Taken by the fake bot when it refused (QA S5c): a timestamp read after the polling of
    // `waitFor` could be late on a loaded machine and shrink the measured wait (flaky).
    const refusedAt = bot.refusedAt.at(-1) ?? 0;
    await waitFor(() => Promise.resolve(bot.sent.length > before), {
      what: 'the message after retry_after',
    });
    const sentAt = bot.sent.at(-1)?.at ?? 0;
    expect(sentAt - refusedAt).toBeGreaterThanOrEqual(1_700);
    expect(bot.calls()).toBe(callsBefore + 2);
    expect(String(bot.sent.at(-1)?.text)).toContain('Rate limited');
    expect(
      captured.lines.find((line) => line['msg'] === 'notification Telegram message deferred'),
    ).toMatchObject({ reason: 'rate_limited', pending: 1 });
    // The worker records `sent` after the bot's response, so the row can still be `pending`
    // when the fake bot has the message (seen on a loaded CI runner).
    await waitFor(async () => (await statuses()).at(-1)?.status === 'sent', {
      what: 'the delivery marked sent',
    });
    expect((await statuses()).at(-1)).toEqual({ status: 'sent', error_code: null });
  });
});
