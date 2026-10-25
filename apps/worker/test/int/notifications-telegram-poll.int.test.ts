import { createServer, type Server, type ServerResponse } from 'node:http';

import { TELEGRAM_LINK_TOKEN_TTL_MS, type Id } from '@cellhive/contracts';
import {
  deriveSecretKey,
  enqueueTelegramPoll,
  hashToken,
  orgScope,
  sealSecret,
  TelegramChatAddress,
  telegramLinkReply,
  TelegramWebhooksRepository,
  UserChannelLinkTokensRepository,
  UserChannelsRepository,
  withOrgTelegramSettings,
  type Db,
  type TelegramPollResult,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createWorker, type WorkerHandle } from '../../src/index.js';
import { buildTaskList } from '../../src/tasks/index.js';
import {
  createNotificationsTelegramPollTask,
  TELEGRAM_POLL_BUSY_RETRY_MS,
} from '../../src/tasks/notifications-telegram-poll.js';
import { createNotificationsTelegramSparsePollTask } from '../../src/tasks/notifications-telegram-sparse-poll.js';
import { createNotificationsTelegramWebhookCheckTask } from '../../src/tasks/notifications-telegram-webhook-check.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  queuedJobs,
  testConfig,
  waitFor,
  type CapturedLogger,
  type TestDatabase,
} from './support.js';

import type { JobHelpers } from 'graphile-worker';

const ORG: Id<'org'> = 'org_TgPollWorkerOrg1';
const OWNER: Id<'usr'> = 'usr_TgPollWorkerOwn1';
const MEMBER: Id<'usr'> = 'usr_TgPollWorkerMem1';
const SECRET: Id<'sec'> = 'sec_TgPollWorkerSec1';
const BOT_TOKEN = '777000111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDworker';
const CHAT = 7_123_000_456;
const LINK_TOKEN = 'Wk3r_Link-Token_0123456789abcdef';
const helpers = { job: { id: '99' } } as unknown as JobHelpers;

/** A minimal fake Bot API (no real network): long-polled updates, `sendMessage`. */
async function startBot() {
  const updates: Record<string, unknown>[] = [];
  const sent: { chat_id: unknown; text: unknown }[] = [];
  const waiting = new Set<() => void>();
  const open = new Set<ServerResponse>();
  let next = 1;
  let polls = 0;
  const server: Server = createServer((request, response) => {
    open.add(response);
    response.on('close', () => open.delete(response));
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        unknown
      >;
      const method = /\/([A-Za-z]+)$/u.exec(request.url ?? '')?.[1];
      const reply = (value: unknown) => {
        if (response.writableEnded) return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: value }));
      };
      if (method === 'sendMessage') {
        sent.push({ chat_id: body['chat_id'], text: body['text'] });
        reply({ message_id: 1 });
        return;
      }
      if (method === 'getUpdates') {
        polls += 1;
        const offset = typeof body['offset'] === 'number' ? body['offset'] : 0;
        while (updates.length > 0 && Number(updates[0]?.['update_id']) < offset) updates.shift();
        if (updates.length === 0 && Number(body['timeout']) > 0) {
          await new Promise<void>((resolve) => {
            const done = () => {
              waiting.delete(done);
              resolve();
            };
            waiting.add(done);
            setTimeout(done, Number(body['timeout']) * 1000);
          });
        }
        reply(updates.slice());
        return;
      }
      reply({});
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`,
    sent,
    polls: () => polls,
    say(text: string) {
      updates.push({
        update_id: (next += 1),
        message: {
          chat: { id: CHAT, type: 'private' },
          from: { id: CHAT, first_name: 'Hidden Name' },
          text,
        },
      });
      for (const done of [...waiting]) done();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const done of [...waiting]) done();
        for (const response of open) response.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * BACKLOG T549 through the worker: `notifications.telegram_poll` — one
 * queued job per bot (job key), the per-minute sweep of bots with pending
 * links, continuation and busy retries, and a real `/start` linked by the
 * running worker, with nothing secret in its logs.
 */
describe('worker: notifications.telegram_poll (T549)', () => {
  let database: TestDatabase;
  let db: Db;
  let bot: Awaited<ReturnType<typeof startBot>>;
  const config = () => testConfig(database.url);

  async function addToken(token: string, createdAt = new Date()) {
    await new UserChannelLinkTokensRepository(db).insert(orgScope(ORG), {
      tokenHash: hashToken(token),
      userId: MEMBER,
      secretId: SECRET,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + TELEGRAM_LINK_TOKEN_TTL_MS),
    });
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    bot = await startBot();
    await db.kysely
      .insertInto('meta.organizations')
      .values({ id: ORG, name: 'Acme', slug: 'acme-tg-poll' })
      .execute();
    await db.kysely
      .insertInto('meta.users')
      .values([OWNER, MEMBER].map((id) => ({ id, email: `${id}@tg.test`, display_name: id })))
      .execute();
    await db.kysely
      .insertInto('meta.org_members')
      .values([
        { organization_id: ORG, user_id: OWNER, role: 'owner' },
        { organization_id: ORG, user_id: MEMBER, role: 'member' },
      ])
      .execute();
    await db.kysely
      .insertInto('meta.secrets')
      .values({
        id: SECRET,
        organization_id: ORG,
        kind: 'telegram_bot',
        name: 'Notifications',
        ciphertext: sealSecret(
          deriveSecretKey(config().security.appMasterKey, 'org-secret'),
          BOT_TOKEN,
        ),
      })
      .execute();
    await db.kysely
      .updateTable('meta.organizations')
      .set({
        settings: withOrgTelegramSettings(
          {},
          { secretId: SECRET, botId: 777000111, botUsername: 'acme_bot', status: 'ok' },
        ),
      })
      .where('id', '=', ORG)
      .execute();
  });

  afterAll(async () => {
    await bot.close();
    await db.destroy();
    await database.drop();
  });

  beforeEach(async () => {
    await db.kysely.deleteFrom('meta.user_channel_link_tokens').execute();
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
  });

  describe('task (no worker running)', () => {
    function taskWith(result: Partial<TelegramPollResult> | null) {
      const calls: [Id<'org'>, Id<'sec'>][] = [];
      const captured = captureLogger();
      const task = createNotificationsTelegramPollTask({
        db,
        logger: captured.logger,
        poller: {
          poll: (organizationId, secretId) => {
            calls.push([organizationId, secretId]);
            return Promise.resolve({
              outcome: 'done',
              updates: 0,
              linked: 0,
              refused: 0,
              stopped: 0,
              ignored: 0,
              ...result,
            });
          },
        },
      });
      return { task, calls, captured };
    }

    it('one queued poll per bot, whatever the number of enqueues (job key)', async () => {
      await db.withTx((tx) => enqueueTelegramPoll(tx, ORG, SECRET));
      await db.withTx((tx) => enqueueTelegramPoll(tx, ORG, SECRET));
      const jobs = await queuedJobs(db, 'notifications.telegram_poll');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        payload: { organization_id: ORG, secret_id: SECRET },
        max_attempts: 1,
      });
    });

    it('the per-minute sweep queues one poll per bot with pending links only', async () => {
      const { task, calls, captured } = taskWith(null);
      await task({ _cron: { ts: new Date().toISOString() } }, helpers);
      expect(await queuedJobs(db, 'notifications.telegram_poll')).toEqual([]);
      await addToken('Sweep_Token_000000000000000000001');
      await addToken('Sweep_Token_000000000000000000002');
      // An expired link does not count.
      await addToken('Sweep_Token_000000000000000000003', new Date(Date.now() - 3_600_000));
      await task({ _cron: { ts: new Date().toISOString() } }, helpers);
      await task({ _cron: { ts: new Date().toISOString() } }, helpers);
      const jobs = await queuedJobs(db, 'notifications.telegram_poll');
      expect(jobs.map((job) => job.payload)).toEqual([{ organization_id: ORG, secret_id: SECRET }]);
      expect(calls).toEqual([]);
      expect(captured.lines.map((line) => line['msg'])).toContain(
        'telegram polls queued for pending links',
      );
    });

    it('queues the next poll when time ran out, comes back in 5 s when busy, logs counts', async () => {
      const continuing = taskWith({ outcome: 'continue', updates: 3, linked: 1 });
      await continuing.task({ organization_id: ORG, secret_id: SECRET }, helpers);
      expect(continuing.calls).toEqual([[ORG, SECRET]]);
      let [job] = await queuedJobs(db, 'notifications.telegram_poll');
      expect(job?.run_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
      expect(continuing.captured.lines[0]).toMatchObject({
        msg: 'telegram notification bot polled',
        org_id: ORG,
        secret_id: SECRET,
        outcome: 'continue',
        updates: 3,
        linked: 1,
      });

      await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
      const busy = taskWith({ outcome: 'busy' });
      const before = Date.now();
      await busy.task({ organization_id: ORG, secret_id: SECRET }, helpers);
      [job] = await queuedJobs(db, 'notifications.telegram_poll');
      expect(job?.run_at.getTime()).toBeGreaterThanOrEqual(
        before + TELEGRAM_POLL_BUSY_RETRY_MS - 1_000,
      );
      // Every 5 s per bot while another poll runs: debug, not info (QA S5b I5).
      expect(busy.captured.lines).toEqual([
        expect.objectContaining({ level: 20, outcome: 'busy', org_id: ORG }),
      ]);

      await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
      const conflict = taskWith({ outcome: 'webhook_conflict' });
      await conflict.task({ organization_id: ORG, secret_id: SECRET }, helpers);
      expect(await queuedJobs(db, 'notifications.telegram_poll')).toEqual([]);
      expect(conflict.captured.lines[0]).toMatchObject({
        level: 40,
        msg: 'telegram notification bot cannot receive updates',
        outcome: 'webhook_conflict',
      });

      const malformed = taskWith(null);
      await malformed.task({ organization_id: ORG, secret_id: 'nope' as Id<'sec'> }, helpers);
      expect(malformed.calls).toEqual([]);
      expect(malformed.captured.lines[0]).toMatchObject({
        level: 50,
        msg: 'notifications.telegram_poll: malformed payload, skipped',
      });
    });
  });

  describe('sparse poll and webhook check sweeps (T609)', () => {
    it('the 15-minute sweep queues one sparse poll per bot with a linked channel', async () => {
      const captured = captureLogger();
      const task = createNotificationsTelegramSparsePollTask({
        db,
        logger: captured.logger,
        poller: { poll: () => Promise.reject(new Error('not called by the sweep')) },
      });
      await task({ _cron: { ts: new Date().toISOString() } }, helpers);
      expect(await queuedJobs(db, 'notifications.telegram_sparse_poll')).toEqual([]);
      const address = new TelegramChatAddress(config().security.appMasterKey);
      await new UserChannelsRepository(db).upsertLinked(orgScope(ORG), {
        id: 'uch_TgPollWorkerCh01',
        userId: MEMBER,
        kind: 'telegram',
        secretId: SECRET,
        addressEnc: address.seal(String(CHAT)),
        addressHmac: address.lookup(SECRET, String(CHAT)),
        linkedAt: new Date(),
      });
      try {
        await task({ _cron: { ts: new Date().toISOString() } }, helpers);
        await task({ _cron: { ts: new Date().toISOString() } }, helpers);
        const jobs = await queuedJobs(db, 'notifications.telegram_sparse_poll');
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          payload: { organization_id: ORG, secret_id: SECRET },
          max_attempts: 1,
        });
        expect(captured.lines.map((line) => line['msg'])).toContain('telegram sparse polls queued');
      } finally {
        await db.kysely.deleteFrom('meta.user_channels').execute();
      }
    });

    it('the hourly check visits every registered webhook and logs counts only', async () => {
      await new TelegramWebhooksRepository(db).upsert(orgScope(ORG), {
        secretId: SECRET,
        pathTokenHash: hashToken('p'.repeat(32)),
        secretTokenEnc: 'sealed',
        registeredUrl: 'https://cellhive.test/api/v1/telegram/webhook/',
        checkedAt: new Date(),
      });
      try {
        const captured = captureLogger();
        const checked: Id<'org'>[] = [];
        await createNotificationsTelegramWebhookCheckTask({
          db,
          logger: captured.logger,
          registrar: {
            check: (organizationId) => {
              checked.push(organizationId);
              return Promise.resolve('reregistered');
            },
          },
        })({ _cron: { ts: new Date().toISOString() } }, helpers);
        expect(checked).toEqual([ORG]);
        expect(captured.lines.at(-1)).toMatchObject({
          msg: 'telegram webhooks checked',
          reregistered: 1,
        });
      } finally {
        await db.kysely.deleteFrom('meta.telegram_webhooks').execute();
      }
    });
  });

  describe('running worker', () => {
    let worker: WorkerHandle;
    let captured: CapturedLogger;

    beforeAll(async () => {
      captured = captureLogger();
      worker = await createWorker(config(), {
        logger: captured.logger,
        pollIntervalMs: 100,
        taskList: buildTaskList({
          config: config(),
          db,
          logger: captured.logger,
          telegramClient: { baseUrl: bot.baseUrl },
          telegramPoll: { maxDurationMs: 5_000, pollTimeoutSeconds: 1 },
        }),
      });
    });

    afterAll(async () => {
      await worker.close();
    });

    it('a queued poll links /start <token> and confirms it; nothing secret in the logs', async () => {
      await addToken(LINK_TOKEN);
      await db.withTx((tx) => enqueueTelegramPoll(tx, ORG, SECRET));
      await waitFor(() => Promise.resolve(bot.polls() > 0), { what: 'the first long poll' });
      bot.say(`/start ${LINK_TOKEN}`);
      const channel = await waitFor(
        async () =>
          (await new UserChannelsRepository(db).listForUser(orgScope(ORG), MEMBER))[0] ?? undefined,
        { what: 'the linked channel' },
      );
      expect(channel).toMatchObject({ kind: 'telegram', status: 'linked', secret_id: SECRET });
      await waitFor(
        () =>
          Promise.resolve(
            captured.lines.some((line) => line['msg'] === 'telegram notification bot polled'),
          ),
        { what: 'the poll log' },
      );
      // The reply is a queued `notifications.telegram_reply` job (T609) the worker sends.
      await waitFor(() => Promise.resolve(bot.sent.length > 0 ? true : undefined), {
        what: 'the reply',
      });
      expect(bot.sent).toEqual([
        { chat_id: String(CHAT), text: telegramLinkReply('linked', 'en') },
      ]);
      const logs = captured.raw();
      for (const canary of [LINK_TOKEN, String(CHAT), 'Hidden Name', BOT_TOKEN, '/start']) {
        expect(logs).not.toContain(canary);
      }
      const line = captured.lines.find(
        (item) => item['msg'] === 'telegram notification bot polled',
      );
      expect(line).toMatchObject({ outcome: 'done', linked: 1, org_id: ORG, secret_id: SECRET });
    });
  });
});
