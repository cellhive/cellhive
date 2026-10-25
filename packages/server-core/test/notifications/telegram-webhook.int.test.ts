/**
 * BACKLOG T609 (ADR-35 §7, CONTRACTS §22.7) against PostgreSQL and a fake
 * Bot API: tenant isolation of `meta.telegram_webhooks`, the three new
 * cross-tenant lookups, registering a webhook (never over another URL),
 * the receiver of the public route (path → secret header → update in one
 * transaction), the hourly check (re-register after a `PUBLIC_URL` change,
 * delivery errors, conflicts), the sparse poll (`/stop` without pending
 * links), replies through the bot's pacer (≤ 25 calls per second together
 * with `send_telegram`) and canaries for the path token, the
 * `secret_token` and the bot token.
 */
import { randomBytes } from 'node:crypto';

import { newId, TELEGRAM_LINK_TOKEN_TTL_MS, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deriveSecretKey, hashToken, sealSecret } from '../../src/auth/index.js';
import {
  createMemoryTelegramPacers,
  TelegramClient,
  telegramBotPacerKey,
} from '../../src/automation/index.js';
import {
  findTelegramWebhookByPathHash,
  listTelegramBotsForSparsePoll,
  listTelegramWebhooksToCheck,
  OrgMembersRepository,
  orgScope,
  type Db,
} from '../../src/db/index.js';
import {
  MemoryTelegramReplyLimiter,
  TelegramChatAddress,
  TelegramLinkPoller,
  TelegramReplySender,
  TelegramWebhookReceiver,
  TelegramWebhookRegistrar,
  TelegramWebhooksRepository,
  UserChannelLinkTokensRepository,
  UserChannelsRepository,
  withOrgTelegramSettings,
  type NotificationsTelegramReplyPayload,
} from '../../src/notifications/index.js';
import { startFakeTelegramBot, type FakeTelegramBot } from '../support/fake-telegram-bot.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

const ORG_A: Id<'org'> = 'org_TgWebhookOrgA001';
const ORG_B: Id<'org'> = 'org_TgWebhookOrgB001';
const MEMBER: Id<'usr'> = 'usr_TgWebhookMember1';
const MASTER_KEY = Buffer.alloc(32, 11);
const BOT_TOKEN = '777000111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDcanary';
const BOT_TOKEN_B = '777000222:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDcanary';
const PUBLIC_URL = 'https://cellhive.test';
const CHAT_A = 7_101_234_567;
const DEFAULTS = { timeZone: 'UTC', locale: 'en' };

describe('Telegram notification bot: webhook mode, replies, sparse poll (T609)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  let telegram: FakeTelegramBot;
  let secretA: Id<'sec'>;
  let secretB: Id<'sec'>;
  const webhooks = () => new TelegramWebhooksRepository(db);
  const address = new TelegramChatAddress(MASTER_KEY);

  const registrar = (publicUrl = PUBLIC_URL, now?: () => Date) =>
    new TelegramWebhookRegistrar(db, {
      masterKey: MASTER_KEY,
      publicUrl,
      client: { baseUrl: telegram.baseUrl },
      ...(now === undefined ? {} : { now }),
    });
  const receiver = () =>
    new TelegramWebhookReceiver(db, { masterKey: MASTER_KEY, defaults: DEFAULTS });

  async function insertSecret(orgId: Id<'org'>, token: string): Promise<Id<'sec'>> {
    const id = newId('sec');
    await db.kysely
      .insertInto('meta.secrets')
      .values({
        id,
        organization_id: orgId,
        kind: 'telegram_bot',
        name: `Bot ${id}`,
        ciphertext: sealSecret(deriveSecretKey(MASTER_KEY, 'org-secret'), token),
      })
      .execute();
    return id;
  }

  async function setBot(
    orgId: Id<'org'>,
    secretId: Id<'sec'>,
    botId: number,
    deliveryMode: 'polling' | 'webhook',
  ) {
    const org = await db.kysely
      .selectFrom('meta.organizations')
      .select('settings')
      .where('id', '=', orgId)
      .executeTakeFirstOrThrow();
    await db.kysely
      .updateTable('meta.organizations')
      .set({
        settings: withOrgTelegramSettings(org.settings, {
          secretId,
          botId,
          botUsername: 'cellhive_test_bot',
          status: 'ok',
          deliveryMode,
        }),
      })
      .where('id', '=', orgId)
      .execute();
  }

  /** Registers the webhook of org A's bot as the API would and stores the row. */
  async function registerA(publicUrl = PUBLIC_URL) {
    const registration = await registrar(publicUrl).register(
      secretA,
      BOT_TOKEN,
      await webhooks().find(orgScope(ORG_A)),
    );
    if (!registration.ok) throw new Error(`not registered: ${registration.reason}`);
    await webhooks().upsert(orgScope(ORG_A), registration.webhook);
    await setBot(ORG_A, secretA, 777_000_111, 'webhook');
    return registration;
  }

  /** The path token and secret Telegram would use, read from the fake. */
  function telegramSide() {
    const url = telegram.webhookUrl();
    return { pathToken: url.slice(url.lastIndexOf('/') + 1), secret: telegram.webhookSecret() };
  }

  async function replyJobs(): Promise<NotificationsTelegramReplyPayload[]> {
    const { rows } = await sql<{ payload: NotificationsTelegramReplyPayload }>`
      SELECT j.payload FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = 'notifications.telegram_reply'
       ORDER BY j.id
    `.execute(db.kysely);
    return rows.map((row) => row.payload);
  }

  async function link(userId: Id<'usr'>): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    const now = new Date();
    await new UserChannelLinkTokensRepository(db).insert(orgScope(ORG_A), {
      tokenHash: hashToken(token),
      userId,
      secretId: secretA,
      createdAt: now,
      expiresAt: new Date(now.getTime() + TELEGRAM_LINK_TOKEN_TTL_MS),
    });
    return token;
  }

  async function linkChannel(orgId: Id<'org'>, secretId: Id<'sec'>, userId: Id<'usr'>) {
    await new UserChannelsRepository(db).upsertLinked(orgScope(orgId), {
      id: newId('uch'),
      userId,
      kind: 'telegram',
      secretId,
      addressEnc: address.seal(String(CHAT_A)),
      addressHmac: address.lookup(secretId, String(CHAT_A)),
      linkedAt: new Date(),
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url, { poolMax: 6 });
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    await db.kysely
      .insertInto('meta.users')
      .values({ id: MEMBER, email: 'tgw-member@example.test', display_name: 'M', locale: 'vi' })
      .execute();
    const members = new OrgMembersRepository(db);
    await members.add(orgScope(ORG_A), a.userId, 'owner');
    await members.add(orgScope(ORG_A), MEMBER, 'member');
    await members.add(orgScope(ORG_B), b.userId, 'owner');
    telegram = await startFakeTelegramBot();
    secretA = await insertSecret(ORG_A, BOT_TOKEN);
    secretB = await insertSecret(ORG_B, BOT_TOKEN_B);
  });

  afterAll(async () => {
    await telegram.close();
    await db.destroy();
    await database.drop();
  });

  beforeEach(async () => {
    await setBot(ORG_A, secretA, 777_000_111, 'polling');
    await setBot(ORG_B, secretB, 777_000_222, 'polling');
    await db.kysely.deleteFrom('meta.telegram_webhooks').execute();
    await db.kysely.deleteFrom('meta.user_channels').execute();
    await db.kysely.deleteFrom('meta.user_channel_link_tokens').execute();
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
    telegram.setWebhook(false);
    telegram.calls.length = 0;
  });

  describe('TelegramWebhooksRepository (tenant isolation)', () => {
    it('reads, updates and deletes only the rows of its organization', async () => {
      await webhooks().upsert(orgScope(ORG_A), {
        secretId: secretA,
        pathTokenHash: hashToken('a'.repeat(32)),
        secretTokenEnc: 'sealed',
        registeredUrl: `${PUBLIC_URL}/api/v1/telegram/webhook/`,
        checkedAt: new Date(),
      });
      expect(await webhooks().find(orgScope(ORG_B))).toBeUndefined();
      expect(
        await webhooks().setStatus(orgScope(ORG_B), 'error', 'delivery_failed', new Date()),
      ).toBe(false);
      expect(await webhooks().delete(orgScope(ORG_B))).toBe(false);
      expect(await webhooks().find(orgScope(ORG_A))).toMatchObject({
        status: 'ok',
        secret_id: secretA,
      });
      // A secret of another organization cannot be referenced (composite FK).
      await expect(
        webhooks().upsert(orgScope(ORG_B), {
          secretId: secretA,
          pathTokenHash: hashToken('b'.repeat(32)),
          secretTokenEnc: 'sealed',
          registeredUrl: `${PUBLIC_URL}/api/v1/telegram/webhook/`,
          checkedAt: new Date(),
        }),
      ).rejects.toThrow();
      expect(await webhooks().delete(orgScope(ORG_A))).toBe(true);
    });
  });

  describe('cross-tenant lookups', () => {
    it('findTelegramWebhookByPathHash and listTelegramWebhooksToCheck return organization ids only', async () => {
      await registerA();
      const { pathToken } = telegramSide();
      expect(await findTelegramWebhookByPathHash(db.kysely, hashToken(pathToken))).toEqual({
        organization_id: ORG_A,
      });
      expect(await findTelegramWebhookByPathHash(db.kysely, hashToken('x'.repeat(32)))).toBe(
        undefined,
      );
      expect(await listTelegramWebhooksToCheck(db.kysely, { after: null, limit: 10 })).toEqual([
        ORG_A,
      ]);
      expect(await listTelegramWebhooksToCheck(db.kysely, { after: ORG_A, limit: 10 })).toEqual([]);
    });

    it('listTelegramBotsForSparsePoll: linked channels of the current bot, polling mode only', async () => {
      await linkChannel(ORG_A, secretA, MEMBER);
      await linkChannel(ORG_B, secretB, b.userId);
      expect(await listTelegramBotsForSparsePoll(db.kysely, { after: null, limit: 10 })).toEqual([
        { organizationId: ORG_A, secretId: secretA },
        { organizationId: ORG_B, secretId: secretB },
      ]);
      expect(
        await listTelegramBotsForSparsePoll(db.kysely, {
          after: { organizationId: ORG_A, secretId: secretA },
          limit: 10,
        }),
      ).toEqual([{ organizationId: ORG_B, secretId: secretB }]);
      // Webhook mode: no sparse poll. A channel in error does not count.
      await setBot(ORG_B, secretB, 777_000_222, 'webhook');
      await new UserChannelsRepository(db).markAllError(orgScope(ORG_A), 'telegram', 'blocked');
      expect(await listTelegramBotsForSparsePoll(db.kysely, { after: null, limit: 10 })).toEqual(
        [],
      );
    });
  });

  describe('registering', () => {
    it('refuses an http PUBLIC_URL or another port, without calling Telegram', async () => {
      for (const url of ['http://cellhive.test', 'https://cellhive.test:3000']) {
        expect(await registrar(url).register(secretA, BOT_TOKEN, undefined)).toEqual({
          ok: false,
          reason: 'public_url_not_https',
        });
      }
      expect(registrar('https://cellhive.test:8443/').prefix()).toBe(
        'https://cellhive.test:8443/api/v1/telegram/webhook/',
      );
      expect(telegram.calls).toEqual([]);
    });

    it('never overwrites a webhook pointing elsewhere', async () => {
      telegram.setWebhook(true);
      expect(await registrar().register(secretA, BOT_TOKEN, undefined)).toEqual({
        ok: false,
        reason: 'conflict',
      });
      expect(telegram.callsOf('setWebhook')).toEqual([]);
      expect(telegram.webhookUrl()).toBe('https://elsewhere.example/telegram');
    });

    it('sets the webhook with a new path token and secret token, then sees it as unchanged', async () => {
      const first = await registerA();
      expect(first.unchanged).toBe(false);
      const [call] = telegram.callsOf('setWebhook');
      expect(call?.body).toMatchObject({
        allowed_updates: ['message'],
        max_connections: 10,
      });
      const { pathToken, secret } = telegramSide();
      expect(telegram.webhookUrl()).toBe(`${PUBLIC_URL}/api/v1/telegram/webhook/${pathToken}`);
      expect(pathToken).toMatch(/^[A-Za-z0-9_-]{32}$/u);
      expect(secret).toMatch(/^[A-Za-z0-9_-]{64}$/u);
      const row = await webhooks().find(orgScope(ORG_A));
      expect(row).toMatchObject({
        path_token_hash: hashToken(pathToken),
        registered_url: `${PUBLIC_URL}/api/v1/telegram/webhook/`,
        status: 'ok',
      });
      const again = await registrar().register(secretA, BOT_TOKEN, row);
      expect(again).toMatchObject({ ok: true, unchanged: true });
      expect(telegram.callsOf('setWebhook')).toHaveLength(1);
    });
  });

  describe('receiver of POST /telegram/webhook/:pathToken', () => {
    it('404 for an unknown or malformed path, 401 for a wrong secret, then links in one transaction', async () => {
      await registerA();
      const { pathToken, secret } = telegramSide();
      const token = await link(MEMBER);
      const update = {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: CHAT_A, type: 'private' },
          from: { id: CHAT_A, first_name: 'Secret Name' },
          text: `/start ${token}`,
        },
      };
      const body = () => update;
      expect(await receiver().receive('short', secret ?? '', body)).toBe('not_found');
      expect(await receiver().receive('z'.repeat(32), secret ?? '', body)).toBe('not_found');
      expect(await receiver().receive(pathToken, undefined, body)).toBe('unauthorized');
      expect(await receiver().receive(pathToken, `${secret ?? ''}x`, body)).toBe('unauthorized');
      // The body is only read once the request is known to come from Telegram.
      let read = false;
      await receiver().receive(pathToken, 'wrong', () => {
        read = true;
        return update;
      });
      expect(read).toBe(false);
      expect(await receiver().receive(pathToken, secret ?? '', body)).toBe('linked');
      expect(
        await new UserChannelsRepository(db).isLinkedTo(
          orgScope(ORG_A),
          MEMBER,
          'telegram',
          secretA,
          address.lookup(secretA, String(CHAT_A)),
        ),
      ).toBe(true);
      expect(await replyJobs()).toEqual([
        expect.objectContaining({ organization_id: ORG_A, reply: 'linked', language: 'vi' }),
      ]);
      // An update of no interest, or no update at all: handled (200), nothing done.
      expect(await receiver().receive(pathToken, secret ?? '', () => ({ update_id: 2 }))).toBe(
        'ignored',
      );
      expect(await receiver().receive(pathToken, secret ?? '', () => 'nope')).toBe('ignored');
      // /stop at once.
      expect(
        await receiver().receive(pathToken, secret ?? '', () => ({
          update_id: 3,
          message: { message_id: 3, chat: { id: CHAT_A, type: 'private' }, text: '/stop' },
        })),
      ).toBe('stopped');
      // Back to polling: the path is unknown again.
      await setBot(ORG_A, secretA, 777_000_111, 'polling');
      expect(await receiver().receive(pathToken, secret ?? '', body)).toBe('not_found');
    });
  });

  describe('hourly check', () => {
    it('ok, then delivery errors since the last check → error, never the error text', async () => {
      const at = new Date(Date.now() + 60_000);
      await registerA();
      expect(await registrar(PUBLIC_URL, () => at).check(ORG_A)).toBe('ok');
      telegram.setWebhookError(Math.floor(at.getTime() / 1000) + 30);
      expect(
        await registrar(PUBLIC_URL, () => new Date(at.getTime() + 3_600_000)).check(ORG_A),
      ).toBe('error');
      const row = await webhooks().find(orgScope(ORG_A));
      expect(row).toMatchObject({ status: 'error', last_error_code: 'delivery_failed' });
      expect(JSON.stringify(row)).not.toContain('Bad Gateway');
    });

    it('re-registers after a PUBLIC_URL change; the old path stops working', async () => {
      await registerA();
      const old = telegramSide();
      expect(await registrar('https://new.cellhive.test').check(ORG_A)).toBe('reregistered');
      expect(telegram.webhookUrl()).toMatch(
        /^https:\/\/new\.cellhive\.test\/api\/v1\/telegram\/webhook\/[A-Za-z0-9_-]{32}$/u,
      );
      expect(await receiver().receive(old.pathToken, old.secret ?? '', () => ({}))).toBe(
        'not_found',
      );
      const now = telegramSide();
      expect(await receiver().receive(now.pathToken, now.secret ?? '', () => ({}))).toBe('ignored');
    });

    it('a webhook taken by another integration → error webhook_conflict, not overwritten; refused token → invalid_token', async () => {
      await registerA();
      telegram.setWebhook(true);
      telegram.calls.length = 0;
      expect(await registrar().check(ORG_A)).toBe('error');
      expect(telegram.callsOf('setWebhook')).toEqual([]);
      expect(await webhooks().find(orgScope(ORG_A))).toMatchObject({
        last_error_code: 'webhook_conflict',
      });
      telegram.revoke(BOT_TOKEN);
      try {
        expect(await registrar().check(ORG_A)).toBe('error');
        expect(await webhooks().find(orgScope(ORG_A))).toMatchObject({
          last_error_code: 'invalid_token',
        });
      } finally {
        telegram.revoke(BOT_TOKEN, false);
      }
      // Not in webhook mode any more: nothing to check.
      await setBot(ORG_A, secretA, 777_000_111, 'polling');
      expect(await registrar().check(ORG_A)).toBe('skipped');
    });
  });

  describe('sparse poll (QA S5b M4)', () => {
    it('handles /stop without pending links in one non-waiting getUpdates; not in webhook mode', async () => {
      await linkChannel(ORG_A, secretA, MEMBER);
      const clock = new Date(Date.now() + 14 * 60_000);
      const poller = new TelegramLinkPoller(db, {
        masterKey: MASTER_KEY,
        defaults: DEFAULTS,
        client: { baseUrl: telegram.baseUrl },
        now: () => clock,
        sleep: () => Promise.resolve(),
      });
      // Without `sparse`, no pending link: no call at all (the old M4 gap).
      expect(await poller.poll(ORG_A, secretA)).toMatchObject({ outcome: 'done', updates: 0 });
      expect(telegram.callsOf('getUpdates')).toEqual([]);
      telegram.send({ chatId: CHAT_A, text: '/stop' });
      expect(await poller.poll(ORG_A, secretA, { sparse: true })).toMatchObject({
        outcome: 'done',
        stopped: 1,
      });
      expect(telegram.callsOf('getUpdates')[0]?.body).toMatchObject({ timeout: 0 });
      expect(await new UserChannelsRepository(db).listForUser(orgScope(ORG_A), MEMBER)).toEqual([]);
      expect(telegram.pendingUpdates()).toBe(0);
      expect(await replyJobs()).toEqual([expect.objectContaining({ reply: 'stopped' })]);

      await setBot(ORG_A, secretA, 777_000_111, 'webhook');
      telegram.calls.length = 0;
      expect(await poller.poll(ORG_A, secretA, { sparse: true })).toMatchObject({
        outcome: 'webhook_mode',
      });
      expect(telegram.calls).toEqual([]);
    });
  });

  describe('replies through the bot pacer (QA S5b M5)', () => {
    it('40 replies and 10 send_telegram messages in one burst: at most 25 calls per second', async () => {
      const at: number[] = [];
      const client = {
        baseUrl: telegram.baseUrl,
        fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          at.push(performance.now());
          return fetch(input, init);
        }) as typeof fetch,
      };
      const pacers = createMemoryTelegramPacers();
      const sender = new TelegramReplySender(db, {
        masterKey: MASTER_KEY,
        pacers,
        limiter: new MemoryTelegramReplyLimiter(),
        client,
      });
      const replies = Array.from({ length: 40 }, (_, index) =>
        sender.send({
          organization_id: ORG_A,
          secret_id: secretA,
          chat: address.seal(String(CHAT_A + index)),
          reply: 'invalid',
          language: 'en',
        }),
      );
      // `send_telegram` takes a slot of the same bot bucket before its call (T550).
      const action = new TelegramClient(client);
      const actions = Array.from({ length: 10 }, async (_, index) => {
        const slot = await pacers.bot.acquire(telegramBotPacerKey(BOT_TOKEN));
        try {
          return await action.sendMessage(BOT_TOKEN, { chatId: String(9_000 + index), text: 'x' });
        } finally {
          await slot.release();
        }
      });
      const outcomes = await Promise.all(replies);
      await Promise.all(actions);
      expect(outcomes.every((outcome) => outcome === 'sent')).toBe(true);
      expect(at).toHaveLength(50);
      const sorted = [...at].sort((x, y) => x - y);
      let worst = 0;
      for (let i = 0; i < sorted.length; i += 1) {
        const start = sorted[i] ?? 0;
        worst = Math.max(worst, sorted.filter((t) => t >= start && t < start + 1000).length);
      }
      expect(worst).toBeLessThanOrEqual(25);
    });
  });

  describe('canaries', () => {
    it('no path token, secret_token or bot token in columns, jobs, audit or results', async () => {
      const registration = await registerA();
      const { pathToken, secret } = telegramSide();
      const token = await link(MEMBER);
      const outcome = await receiver().receive(pathToken, secret ?? '', () => ({
        update_id: 9,
        message: { message_id: 9, chat: { id: CHAT_A, type: 'private' }, text: `/start ${token}` },
      }));
      const check = await registrar().check(ORG_A);
      const client = new pg.Client({ connectionString: database.adminUrl });
      await client.connect();
      try {
        const dump = JSON.stringify(
          await Promise.all(
            [
              'SELECT * FROM meta.telegram_webhooks',
              'SELECT * FROM meta.organizations',
              'SELECT * FROM meta.audit_logs',
              'SELECT * FROM meta.user_channels',
              'SELECT payload, key FROM graphile_worker._private_jobs',
            ].map(async (query) => (await client.query<Record<string, unknown>>(query)).rows),
          ),
        );
        for (const canary of [
          pathToken,
          secret ?? 'missing',
          BOT_TOKEN,
          BOT_TOKEN.split(':')[1] ?? '',
          String(CHAT_A),
        ]) {
          expect(dump).not.toContain(canary);
          expect(JSON.stringify({ registration, outcome, check })).not.toContain(canary);
        }
      } finally {
        await client.end();
      }
    });
  });
});
