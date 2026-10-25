/**
 * BACKLOG T549 (ADR-34 §3, CONTRACTS §22.7): personal Telegram channels
 * against PostgreSQL and a fake Bot API — migration 0040 on a database with
 * S5 notification rows, tenant isolation of the two new repositories and of
 * the pending-link lookup, and the poller: `/start <token>` links within a
 * long poll, used/expired/foreign tokens are refused with the same reply,
 * `/stop`, group chats, offset confirmation, one poller per bot, `409`
 * (webhook) / `401` / `429` / 5xx, the organization's bot status, and
 * canaries: no token, chat id or Telegram name in any column, audit entry,
 * realtime envelope, job payload or poll result. T609: replies are queued
 * jobs (`notifications.telegram_reply`) sent here by `deliverReplies`.
 */
import { randomBytes } from 'node:crypto';

import { newId, TELEGRAM_LINK_TOKEN_TTL_MS, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deriveSecretKey, hashToken, sealSecret } from '../../src/auth/index.js';
import { createMemoryTelegramPacers } from '../../src/automation/index.js';
import {
  createMigrator,
  listOrganizationsWithPendingTelegramLinks,
  migrateToLatest,
  OrgMembersRepository,
  orgScope,
  type Db,
} from '../../src/db/index.js';
import {
  enqueueTelegramPoll,
  MemoryTelegramReplyLimiter,
  orgTelegramSettingsOf,
  resetChannelsForNewBot,
  TelegramChatAddress,
  TelegramLinkPoller,
  telegramLinkReply,
  TelegramReplySender,
  UserChannelLinkTokensRepository,
  UserChannelsRepository,
  withOrgTelegramSettings,
  type NotificationsTelegramReplyPayload,
  type TelegramLinkPollerOptions,
  type TelegramReplyOutcome,
} from '../../src/notifications/index.js';
import { attachRealtimePublisher, type RealtimeEnvelope } from '../../src/realtime/index.js';
import { startFakeTelegramBot, type FakeTelegramBot } from '../support/fake-telegram-bot.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

const ORG_A: Id<'org'> = 'org_TgChannelOrgA001';
const ORG_B: Id<'org'> = 'org_TgChannelOrgB001';
const MEMBER: Id<'usr'> = 'usr_TgChannelMember1';
const DISABLED: Id<'usr'> = 'usr_TgChannelDisabl1';
const MASTER_KEY = Buffer.alloc(32, 9);
const BOT_TOKEN = '555000111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDcanary';
const OTHER_BOT_TOKEN = '555000222:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDcanary';
const CHAT_A = 7_001_234_567;
const CHAT_B = 7_009_876_543;
const DEFAULTS = { timeZone: 'UTC', locale: 'en' };

const newToken = () => randomBytes(24).toString('base64url');

describe('migration 0040_user_channels on a database with S5 rows', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('keeps preferences and deliveries, then accepts the telegram channel only', async () => {
    const { error } = await createMigrator(db.kysely).migrateTo('0038_notification_buffer');
    expect(error).toBeUndefined();
    await seedTenant(db, ORG_A);
    const user: Id<'usr'> = `usr_${ORG_A.slice(4)}`;
    await sql`INSERT INTO meta.org_members (organization_id, user_id, role)
              VALUES (${ORG_A}, ${user}, 'member')`.execute(db.kysely);
    await sql`
      INSERT INTO meta.notification_preferences (organization_id, user_id, type, channel, enabled)
      VALUES (${ORG_A}, ${user}, 'automation.message', 'email', false),
             (${ORG_A}, ${user}, 'automation.message', 'in_app', true)
    `.execute(db.kysely);
    await sql`
      INSERT INTO meta.notifications (id, organization_id, user_id, type, entity_type, entity_id)
      VALUES ('ntf_TgMigration00001', ${ORG_A}, ${user}, 'automation.message', 'automation',
              'aut_TgMigration00001')
    `.execute(db.kysely);
    await sql`
      INSERT INTO meta.notification_deliveries (organization_id, notification_id, channel, status)
      VALUES (${ORG_A}, 'ntf_TgMigration00001', 'email', 'sent')
    `.execute(db.kysely);

    expect(await migrateToLatest(db.kysely)).toContain('0040_user_channels');

    const preferences = await db.kysely
      .selectFrom('meta.notification_preferences')
      .select(['channel', 'enabled'])
      .orderBy('channel')
      .execute();
    expect(preferences).toEqual([
      { channel: 'email', enabled: false },
      { channel: 'in_app', enabled: true },
    ]);
    const deliveries = await db.kysely
      .selectFrom('meta.notification_deliveries')
      .select(['channel', 'status'])
      .execute();
    expect(deliveries).toEqual([{ channel: 'email', status: 'sent' }]);

    await sql`
      INSERT INTO meta.notification_preferences (organization_id, user_id, type, channel, enabled)
      VALUES (${ORG_A}, ${user}, 'automation.message', 'telegram', true)
    `.execute(db.kysely);
    await sql`
      INSERT INTO meta.notification_deliveries (organization_id, notification_id, channel)
      VALUES (${ORG_A}, 'ntf_TgMigration00001', 'telegram')
    `.execute(db.kysely);
    await expect(
      sql`
        INSERT INTO meta.notification_preferences (organization_id, user_id, type, channel, enabled)
        VALUES (${ORG_A}, ${user}, 'automation.message', 'sms', true)
      `.execute(db.kysely),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`
        INSERT INTO meta.notification_deliveries (organization_id, notification_id, channel)
        VALUES (${ORG_A}, 'ntf_TgMigration00001', 'in_app')
      `.execute(db.kysely),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('Telegram notification channels (T549)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  let telegram: FakeTelegramBot;
  let secretA: Id<'sec'>;
  let secretB: Id<'sec'>;
  let otherSecretA: Id<'sec'>;
  const published: RealtimeEnvelope[] = [];
  const channels = () => new UserChannelsRepository(db);
  const tokens = () => new UserChannelLinkTokensRepository(db);
  const address = new TelegramChatAddress(MASTER_KEY);

  function poller(options: Partial<TelegramLinkPollerOptions> = {}): TelegramLinkPoller {
    return new TelegramLinkPoller(db, {
      masterKey: MASTER_KEY,
      defaults: DEFAULTS,
      client: { baseUrl: telegram.baseUrl },
      maxDurationMs: 4_000,
      pollTimeoutSeconds: 1,
      sleep: () => Promise.resolve(),
      ...options,
    });
  }

  async function insertSecret(orgId: Id<'org'>, token: string, name: string): Promise<Id<'sec'>> {
    const id = newId('sec');
    await db.kysely
      .insertInto('meta.secrets')
      .values({
        id,
        organization_id: orgId,
        kind: 'telegram_bot',
        name,
        ciphertext: sealSecret(deriveSecretKey(MASTER_KEY, 'org-secret'), token),
      })
      .execute();
    return id;
  }

  async function setBot(orgId: Id<'org'>, secretId: Id<'sec'> | null, botId = 555_000_111) {
    const org = await db.kysely
      .selectFrom('meta.organizations')
      .select('settings')
      .where('id', '=', orgId)
      .executeTakeFirstOrThrow();
    await db.kysely
      .updateTable('meta.organizations')
      .set({
        settings: withOrgTelegramSettings(
          org.settings,
          secretId === null
            ? { secretId: null, botId: null, botUsername: null, status: null }
            : { secretId, botId, botUsername: 'cellhive_test_bot', status: 'ok' },
        ),
      })
      .where('id', '=', orgId)
      .execute();
  }

  async function botStatus(orgId: Id<'org'>) {
    const org = await db.kysely
      .selectFrom('meta.organizations')
      .select('settings')
      .where('id', '=', orgId)
      .executeTakeFirstOrThrow();
    return orgTelegramSettingsOf(org.settings).status;
  }

  /** A pending link of `userId` (the plaintext token, as the API hands it out). */
  async function link(
    orgId: Id<'org'>,
    userId: Id<'usr'>,
    secretId: Id<'sec'>,
    options: { createdAt?: Date; ttlMs?: number } = {},
  ): Promise<string> {
    const token = newToken();
    const createdAt = options.createdAt ?? new Date();
    await tokens().insert(orgScope(orgId), {
      tokenHash: hashToken(token),
      userId,
      secretId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + (options.ttlMs ?? TELEGRAM_LINK_TOKEN_TTL_MS)),
    });
    return token;
  }

  /**
   * Sends the queued `notifications.telegram_reply` jobs in order (T609),
   * as the worker would, and removes them; returns their outcomes.
   */
  async function deliverReplies(
    limiter = new MemoryTelegramReplyLimiter(100),
  ): Promise<TelegramReplyOutcome[]> {
    const { rows } = await sql<{ id: string; payload: NotificationsTelegramReplyPayload }>`
      SELECT j.id, j.payload FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = 'notifications.telegram_reply'
       ORDER BY j.id
    `.execute(db.kysely);
    const sender = new TelegramReplySender(db, {
      masterKey: MASTER_KEY,
      pacers: createMemoryTelegramPacers(),
      limiter,
      client: { baseUrl: telegram.baseUrl },
    });
    const outcomes: TelegramReplyOutcome[] = [];
    for (const row of rows) outcomes.push(await sender.send(row.payload));
    await sql`DELETE FROM graphile_worker._private_jobs WHERE id = ANY(${rows.map((row) => row.id)}::bigint[])`.execute(
      db.kysely,
    );
    return outcomes;
  }

  /** Runs `poll` and sends `messages` once its first long poll is waiting. */
  async function pollWith(
    p: TelegramLinkPoller,
    orgId: Id<'org'>,
    secretId: Id<'sec'>,
    messages: Parameters<FakeTelegramBot['send']>[0][],
  ) {
    const before = telegram.callsOf('getUpdates').length;
    const running = p.poll(orgId, secretId);
    for (let i = 0; i < 100 && telegram.callsOf('getUpdates').length === before; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const message of messages) telegram.send(message);
    return running;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url, { poolMax: 6 });
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    await db.kysely
      .insertInto('meta.users')
      .values([
        { id: MEMBER, email: 'tg-member@example.test', display_name: 'Member', locale: 'vi' },
        {
          id: DISABLED,
          email: 'tg-disabled@example.test',
          display_name: 'Off',
          status: 'disabled',
        },
      ])
      .execute();
    const members = new OrgMembersRepository(db);
    await members.add(orgScope(ORG_A), a.userId, 'owner');
    await members.add(orgScope(ORG_A), MEMBER, 'member');
    await members.add(orgScope(ORG_A), DISABLED, 'member');
    await members.add(orgScope(ORG_B), b.userId, 'owner');
    // MEMBER also belongs to B: rows of one organization never show in the other.
    await members.add(orgScope(ORG_B), MEMBER, 'member');
    telegram = await startFakeTelegramBot();
    secretA = await insertSecret(ORG_A, BOT_TOKEN, 'Bot A');
    otherSecretA = await insertSecret(ORG_A, OTHER_BOT_TOKEN, 'Bot A2');
    secretB = await insertSecret(ORG_B, BOT_TOKEN, 'Bot B');
    attachRealtimePublisher(db, {
      publish: (envelope) => {
        published.push(envelope);
        return Promise.resolve();
      },
    });
  });

  afterAll(async () => {
    await telegram.close();
    await db.destroy();
    await database.drop();
  });

  beforeEach(async () => {
    await setBot(ORG_A, secretA);
    await setBot(ORG_B, secretB);
    telegram.setWebhook(false);
    await db.kysely.deleteFrom('meta.user_channels').execute();
    await db.kysely.deleteFrom('meta.user_channel_link_tokens').execute();
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
    published.length = 0;
    telegram.calls.length = 0;
  });

  describe('repositories (tenant isolation)', () => {
    it('UserChannelsRepository never reads, changes or deletes another organization', async () => {
      const scopeA = orgScope(ORG_A);
      const scopeB = orgScope(ORG_B);
      await channels().upsertLinked(scopeA, {
        id: newId('uch'),
        userId: MEMBER,
        kind: 'telegram',
        secretId: secretA,
        addressEnc: address.seal(String(CHAT_A)),
        addressHmac: address.lookup(secretA, String(CHAT_A)),
        linkedAt: new Date(),
      });
      expect(await channels().listForUser(scopeB, MEMBER)).toEqual([]);
      expect(await channels().findLinked(scopeB, MEMBER, 'telegram')).toBeUndefined();
      expect(
        await channels().isLinkedTo(
          scopeB,
          MEMBER,
          'telegram',
          secretA,
          address.lookup(secretA, String(CHAT_A)),
        ),
      ).toBe(false);
      expect(await channels().markAllError(scopeB, 'telegram', 'bot_changed')).toEqual([]);
      expect(await channels().markError(scopeB, MEMBER, 'telegram', 'blocked')).toBe(false);
      expect(
        await channels().deleteByAddress(scopeB, secretA, address.lookup(secretA, String(CHAT_A))),
      ).toEqual([]);
      expect(await channels().deleteForUser(scopeB, MEMBER, 'telegram')).toBeUndefined();
      const [row] = await channels().listForUser(scopeA, MEMBER);
      expect(row).toMatchObject({ status: 'linked', secret_id: secretA, error_reason: null });
      // The same member links in B: two rows, one per organization.
      await channels().upsertLinked(scopeB, {
        id: newId('uch'),
        userId: MEMBER,
        kind: 'telegram',
        secretId: secretB,
        addressEnc: address.seal(String(CHAT_B)),
        addressHmac: address.lookup(secretB, String(CHAT_B)),
        linkedAt: new Date(),
      });
      expect(await channels().markAllError(scopeA, 'telegram', 'bot_changed')).toEqual([MEMBER]);
      expect((await channels().listForUser(scopeB, MEMBER))[0]?.status).toBe('linked');
      expect((await channels().findLinked(scopeB, MEMBER, 'telegram'))?.secret_id).toBe(secretB);
    });

    it('UserChannelLinkTokensRepository never finds or counts tokens of another organization', async () => {
      const scopeA = orgScope(ORG_A);
      const scopeB = orgScope(ORG_B);
      const now = new Date();
      const token = await link(ORG_A, MEMBER, secretA);
      expect(await tokens().lockByHash(scopeB, hashToken(token))).toBeUndefined();
      expect(await tokens().listPendingForUser(scopeB, MEMBER, now)).toEqual([]);
      expect(await tokens().countCreatedSince(scopeB, MEMBER, new Date(0))).toBe(0);
      expect(await tokens().oldestCreatedSince(scopeB, MEMBER, new Date(0))).toBeUndefined();
      expect(await tokens().hasPendingForBot(scopeB, secretA, now)).toBe(false);
      expect(await tokens().markUsed(scopeB, hashToken(token), now)).toBe(false);
      expect(await tokens().cancelPending(scopeB, null, now)).toBe(0);
      expect(await tokens().cancelPendingBeyond(scopeB, MEMBER, 0, now)).toBe(0);
      expect(
        await tokens().deleteSettledBefore(scopeB, MEMBER, new Date(Date.now() + 60_000), now),
      ).toBe(0);
      expect(await tokens().hasPendingForBot(scopeA, secretA, now)).toBe(true);
      expect(await tokens().countCreatedSince(scopeA, MEMBER, new Date(0))).toBe(1);
      // Only the hash is stored.
      const stored = await db.kysely
        .selectFrom('meta.user_channel_link_tokens')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(stored.token_hash).toBe(hashToken(token));
      expect(JSON.stringify(stored)).not.toContain(token);
    });

    it('a channel and its tokens go when the member leaves the organization', async () => {
      const scopeA = orgScope(ORG_A);
      await db.kysely
        .insertInto('meta.users')
        .values({ id: 'usr_TgChannelLeaver1', email: 'tg-leaver@example.test', display_name: 'L' })
        .execute();
      await new OrgMembersRepository(db).add(scopeA, 'usr_TgChannelLeaver1', 'member');
      await link(ORG_A, 'usr_TgChannelLeaver1', secretA);
      await channels().upsertLinked(scopeA, {
        id: newId('uch'),
        userId: 'usr_TgChannelLeaver1',
        kind: 'telegram',
        secretId: secretA,
        addressEnc: address.seal('42'),
        addressHmac: address.lookup(secretA, '42'),
        linkedAt: new Date(),
      });
      await db.kysely
        .deleteFrom('meta.org_members')
        .where('organization_id', '=', ORG_A)
        .where('user_id', '=', 'usr_TgChannelLeaver1')
        .execute();
      expect(await channels().listForUser(scopeA, 'usr_TgChannelLeaver1')).toEqual([]);
      expect(await tokens().countCreatedSince(scopeA, 'usr_TgChannelLeaver1', new Date(0))).toBe(0);
    });
  });

  describe('listOrganizationsWithPendingTelegramLinks (cross-tenant lookup)', () => {
    it('lists (organization, secret) of pending links only, in order, paged', async () => {
      const now = new Date();
      await link(ORG_A, MEMBER, secretA);
      await link(ORG_A, a.userId, secretA);
      await link(ORG_B, MEMBER, secretB);
      // Expired and used ones do not count.
      await link(ORG_A, MEMBER, otherSecretA, {
        createdAt: new Date(now.getTime() - 20 * 60_000),
      });
      const used = await link(ORG_B, b.userId, secretB);
      await tokens().markUsed(orgScope(ORG_B), hashToken(used), now);

      const all = await listOrganizationsWithPendingTelegramLinks(db.kysely, {
        now,
        after: null,
        limit: 10,
      });
      expect(all).toEqual([
        { organizationId: ORG_A, secretId: secretA },
        { organizationId: ORG_B, secretId: secretB },
      ]);
      // Ids only: no token hash, no user.
      expect(Object.keys(all[0] ?? {}).sort()).toEqual(['organizationId', 'secretId']);
      const first = await listOrganizationsWithPendingTelegramLinks(db.kysely, {
        now,
        after: null,
        limit: 1,
      });
      expect(first).toEqual([all[0]]);
      const next = await listOrganizationsWithPendingTelegramLinks(db.kysely, {
        now,
        after: first[0] ?? null,
        limit: 1,
      });
      expect(next).toEqual([all[1]]);
      // Later: everything expired.
      expect(
        await listOrganizationsWithPendingTelegramLinks(db.kysely, {
          now: new Date(now.getTime() + TELEGRAM_LINK_TOKEN_TTL_MS + 60_000),
          after: null,
          limit: 10,
        }),
      ).toEqual([]);
    });
  });

  describe('poller', () => {
    it('links the chat of /start <token> within the long poll, once, in the member language', async () => {
      const token = await link(ORG_A, MEMBER, secretA);
      const started = Date.now();
      const result = await pollWith(poller(), ORG_A, secretA, [
        { chatId: CHAT_A, text: `/start ${token}`, languageCode: 'en' },
      ]);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result).toMatchObject({ outcome: 'done', linked: 1, refused: 0, updates: 1 });

      const [channel] = await channels().listForUser(orgScope(ORG_A), MEMBER);
      expect(channel).toMatchObject({ kind: 'telegram', status: 'linked', secret_id: secretA });
      const linked = await channels().findLinked(orgScope(ORG_A), MEMBER, 'telegram');
      expect(address.unseal(linked?.address_enc ?? '')).toBe(String(CHAT_A));
      expect(linked?.address_hmac).toBe(address.lookup(secretA, String(CHAT_A)));
      // The member's language (vi), not the Telegram one; the reply was a queued job.
      expect(telegram.sent()).toEqual([]);
      expect(await deliverReplies()).toEqual(['sent']);
      expect(telegram.sent()).toEqual([
        { chatId: String(CHAT_A), text: telegramLinkReply('linked', 'vi') },
      ]);
      expect(published).toEqual([
        expect.objectContaining({
          type: 'channel.changed',
          organization_id: ORG_A,
          user_id: MEMBER,
          kind: 'telegram',
          status: 'linked',
        }),
      ]);
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .selectAll()
        .where('action', '=', 'user_channel.linked')
        .execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        organization_id: ORG_A,
        entity_type: 'user',
        entity_id: MEMBER,
        actor_type: 'user',
        actor_id: MEMBER,
        after: { kind: 'telegram', source: 'telegram_start' },
      });
      // The token is spent; the update was confirmed.
      expect(await tokens().hasPendingForBot(orgScope(ORG_A), secretA, new Date())).toBe(false);
      expect(telegram.pendingUpdates()).toBe(0);
    });

    it('refuses a used, expired, unknown, foreign or malformed token with the same reply', async () => {
      const now = new Date();
      const keep = await link(ORG_A, a.userId, secretA); // keeps the poller going
      const expired = await link(ORG_A, MEMBER, secretA, {
        createdAt: new Date(now.getTime() - 11 * 60_000),
      });
      const used = await link(ORG_A, MEMBER, secretA);
      await tokens().markUsed(orgScope(ORG_A), hashToken(used), now);
      const foreign = await link(ORG_B, MEMBER, secretB);
      const otherBot = await link(ORG_A, MEMBER, otherSecretA);
      const disabled = await link(ORG_A, DISABLED, secretA);
      const result = await pollWith(poller({ maxDurationMs: 2_500 }), ORG_A, secretA, [
        { chatId: CHAT_A, text: `/start ${expired}` },
        { chatId: CHAT_A, text: `/start ${used}` },
        { chatId: CHAT_A, text: `/start ${foreign}` },
        { chatId: CHAT_A, text: `/start ${otherBot}` },
        { chatId: CHAT_A, text: `/start ${disabled}` },
        { chatId: CHAT_A, text: `/start ${newToken()}` },
        { chatId: CHAT_A, text: '/start not-a-token' },
        { chatId: CHAT_A, text: '/start', languageCode: 'vi' },
      ]);
      expect(result).toMatchObject({ linked: 0, refused: 8 });
      expect(await db.kysely.selectFrom('meta.user_channels').selectAll().execute()).toEqual([]);
      await deliverReplies();
      const replies = telegram.sent().map((sent) => sent.text);
      expect(replies.slice(0, 7)).toEqual(Array(7).fill(telegramLinkReply('invalid', 'en')));
      expect(replies[7]).toBe(telegramLinkReply('invalid', 'vi'));
      // The token of B is still pending in B; the kept one in A.
      expect(await tokens().hasPendingForBot(orgScope(ORG_B), secretB, new Date())).toBe(true);
      expect(await tokens().lockByHash(orgScope(ORG_A), hashToken(keep))).toMatchObject({
        used_at: null,
      });
      expect(published).toEqual([]);
    });

    it('treats a token past its expiry by the injected clock as expired', async () => {
      const token = await link(ORG_A, MEMBER, secretA);
      await link(ORG_A, a.userId, secretA, { ttlMs: 60 * 60_000 });
      // The poller's clock runs 10 minutes and 1 second ahead of the database.
      const late = () => new Date(Date.now() + TELEGRAM_LINK_TOKEN_TTL_MS + 1_000);
      const result = await pollWith(poller({ now: late, maxDurationMs: 2_500 }), ORG_A, secretA, [
        { chatId: CHAT_A, text: `/start ${token}` },
      ]);
      expect(result).toMatchObject({ linked: 0, refused: 1 });
    });

    it('answers a /start replayed after a crash like a success, without a second audit', async () => {
      const token = await link(ORG_A, MEMBER, secretA);
      await pollWith(poller(), ORG_A, secretA, [{ chatId: CHAT_A, text: `/start ${token}` }]);
      await deliverReplies();
      await link(ORG_A, a.userId, secretA);
      telegram.calls.length = 0;
      const audits = () =>
        db.kysely
          .selectFrom('meta.audit_logs')
          .select('id')
          .where('action', '=', 'user_channel.linked')
          .where('entity_id', '=', MEMBER)
          .execute();
      const before = (await audits()).length;
      const result = await pollWith(poller({ maxDurationMs: 2_000 }), ORG_A, secretA, [
        { chatId: CHAT_A, text: `/start ${token}` },
        // The same used token from another chat is refused.
        { chatId: CHAT_B, text: `/start ${token}` },
      ]);
      expect(result).toMatchObject({ linked: 0, refused: 1 });
      await deliverReplies();
      expect(telegram.sent()).toEqual([
        { chatId: String(CHAT_A), text: telegramLinkReply('linked', 'vi') },
        { chatId: String(CHAT_B), text: telegramLinkReply('invalid', 'en') },
      ]);
      expect(await audits()).toHaveLength(before);
      const linked = await channels().findLinked(orgScope(ORG_A), MEMBER, 'telegram');
      expect(address.unseal(linked?.address_enc ?? '')).toBe(String(CHAT_A));
    });

    it('a new link replaces the chat; /stop removes it; group chats and other messages are ignored', async () => {
      const first = await link(ORG_A, MEMBER, secretA);
      await pollWith(poller(), ORG_A, secretA, [{ chatId: CHAT_A, text: `/start ${first}` }]);
      const second = await link(ORG_A, MEMBER, secretA);
      await pollWith(poller(), ORG_A, secretA, [{ chatId: CHAT_B, text: `/start ${second}` }]);
      await deliverReplies();
      const linked = await channels().findLinked(orgScope(ORG_A), MEMBER, 'telegram');
      expect(address.unseal(linked?.address_enc ?? '')).toBe(String(CHAT_B));
      expect(await channels().listForUser(orgScope(ORG_A), MEMBER)).toHaveLength(1);

      await link(ORG_A, a.userId, secretA); // keeps the poller going
      published.length = 0;
      telegram.calls.length = 0;
      const groupToken = await link(ORG_A, MEMBER, secretA);
      telegram.sendRaw({ my_chat_member: { chat: { id: -100, type: 'group' } } });
      const result = await pollWith(poller({ maxDurationMs: 2_000 }), ORG_A, secretA, [
        { chatId: -1_001_234, text: `/start ${groupToken}`, chatType: 'group' },
        { chatId: CHAT_A, text: '/stop' }, // not linked any more: ignored
        { chatId: CHAT_B, text: 'hello' },
        { chatId: CHAT_B, text: '/stop' },
      ]);
      expect(result).toMatchObject({ stopped: 1, linked: 0, refused: 0, ignored: 4 });
      expect(await channels().listForUser(orgScope(ORG_A), MEMBER)).toEqual([]);
      await deliverReplies();
      expect(telegram.sent()).toEqual([
        { chatId: String(CHAT_B), text: telegramLinkReply('stopped', 'vi') },
      ]);
      expect(published).toEqual([
        expect.objectContaining({ type: 'channel.changed', user_id: MEMBER, status: 'unlinked' }),
      ]);
      // The group's /start did not spend the token.
      expect(await tokens().lockByHash(orgScope(ORG_A), hashToken(groupToken))).toMatchObject({
        used_at: null,
      });
      const unlinked = await db.kysely
        .selectFrom('meta.audit_logs')
        .selectAll()
        .where('action', '=', 'user_channel.unlinked')
        .executeTakeFirstOrThrow();
      expect(unlinked).toMatchObject({
        entity_id: MEMBER,
        before: { kind: 'telegram', source: 'telegram_stop' },
      });
      expect(telegram.pendingUpdates()).toBe(0);
    });

    it('does not poll without pending links, nor for a secret that is not the notification bot', async () => {
      expect(await poller().poll(ORG_A, secretA)).toMatchObject({ outcome: 'done', updates: 0 });
      await link(ORG_A, MEMBER, otherSecretA);
      expect(await poller().poll(ORG_A, otherSecretA)).toMatchObject({
        outcome: 'not_notification_bot',
      });
      // A secret of another organization is not this organization's bot.
      expect(await poller().poll(ORG_A, secretB)).toMatchObject({
        outcome: 'not_notification_bot',
      });
      await setBot(ORG_A, null);
      expect(await poller().poll(ORG_A, secretA)).toMatchObject({
        outcome: 'not_notification_bot',
      });
      expect(telegram.callsOf('getUpdates')).toEqual([]);
    });

    it('runs one poller per bot at a time', async () => {
      await link(ORG_A, MEMBER, secretA);
      const one = poller({ maxDurationMs: 1_500 });
      const two = poller({ maxDurationMs: 1_500 });
      const [first, second] = await Promise.all([
        one.poll(ORG_A, secretA),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return two.poll(ORG_A, secretA);
        })(),
      ]);
      expect([first.outcome, second.outcome].sort()).toEqual(['busy', 'continue']);
      expect(telegram.maxConcurrentPolls()).toBe(1);
    });

    it('409 with a webhook marks the bot webhook_conflict once and stops', async () => {
      await link(ORG_A, MEMBER, secretA);
      telegram.setWebhook(true);
      const result = await poller().poll(ORG_A, secretA);
      expect(result.outcome).toBe('webhook_conflict');
      expect(await botStatus(ORG_A)).toBe('webhook_conflict');
      expect(telegram.callsOf('getUpdates')).toHaveLength(1);
      expect(telegram.sent()).toEqual([]);
      // Fixed elsewhere: the next poll sees updates again and the status is `ok`.
      telegram.setWebhook(false);
      expect((await poller({ maxDurationMs: 1_500 }).poll(ORG_A, secretA)).outcome).toBe(
        'continue',
      );
      expect(await botStatus(ORG_A)).toBe('ok');
    });

    it('a 409 from another consumer is not a webhook conflict', async () => {
      await link(ORG_A, MEMBER, secretA);
      telegram.queue('getUpdates', {
        status: 409,
        body: {
          ok: false,
          error_code: 409,
          description: 'Conflict: terminated by other getUpdates request',
        },
      });
      expect((await poller().poll(ORG_A, secretA)).outcome).toBe('conflict');
      expect(await botStatus(ORG_A)).toBe('ok');
    });

    it('401 marks the bot invalid_token; 429 waits retry_after; 5xx backs off and goes on', async () => {
      const token = await link(ORG_A, MEMBER, secretA);
      const waits: number[] = [];
      telegram.queue(
        'getUpdates',
        {
          status: 429,
          body: { ok: false, error_code: 429, parameters: { retry_after: 2 } },
        },
        { status: 502, body: { ok: false, error_code: 502 } },
      );
      const result = await pollWith(
        poller({
          sleep: (ms) => {
            waits.push(ms);
            return Promise.resolve();
          },
        }),
        ORG_A,
        secretA,
        [{ chatId: CHAT_A, text: `/start ${token}` }],
      );
      expect(result).toMatchObject({ outcome: 'done', linked: 1 });
      expect(waits).toEqual([2_000, 1_000]);

      await link(ORG_A, MEMBER, secretA);
      telegram.revoke(BOT_TOKEN);
      try {
        expect((await poller().poll(ORG_A, secretA)).outcome).toBe('invalid_token');
        expect(await botStatus(ORG_A)).toBe('invalid_token');
        // Org B uses the same token: its own status is untouched until its own poll.
        expect(await botStatus(ORG_B)).toBe('ok');
      } finally {
        telegram.revoke(BOT_TOKEN, false);
      }
    });

    it('a token that cannot be unsealed is invalid_token, without any call', async () => {
      await db.kysely
        .updateTable('meta.secrets')
        .set({
          ciphertext: sealSecret(deriveSecretKey(Buffer.alloc(32, 1), 'org-secret'), BOT_TOKEN),
        })
        .where('id', '=', otherSecretA)
        .execute();
      await setBot(ORG_A, otherSecretA, 555_000_222);
      await link(ORG_A, MEMBER, otherSecretA);
      expect((await poller().poll(ORG_A, otherSecretA)).outcome).toBe('invalid_token');
      expect(telegram.calls).toEqual([]);
      expect(await botStatus(ORG_A)).toBe('invalid_token');
    });

    it('stops when the time budget (injected clock) runs out while links are pending', async () => {
      await link(ORG_A, MEMBER, secretA);
      let offset = 0;
      const p = poller({
        now: () => new Date(Date.now() + offset),
        maxDurationMs: 30_000,
        pollTimeoutSeconds: 1,
      });
      const running = p.poll(ORG_A, secretA);
      for (let i = 0; i < 100 && telegram.callsOf('getUpdates').length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Time passes beyond the budget while the first long poll waits.
      offset = 31_000;
      expect((await running).outcome).toBe('continue');
      expect(telegram.callsOf('getUpdates')).toHaveLength(1);
      expect(telegram.callsOf('getUpdates')[0]?.body).toMatchObject({ timeout: 1 });
    });
  });

  describe('replies through the bot pacer and the "not valid" cap (QA S5b M5, T609)', () => {
    it('queues every reply; at most 3 "not valid" per chat per hour are sent; links still happen', async () => {
      const keep = await link(ORG_A, a.userId, secretA); // keeps the poller going
      const token = await link(ORG_A, MEMBER, secretA);
      const garbage = Array.from({ length: 10 }, () => ({
        chatId: CHAT_A,
        text: `/start ${newToken()}`,
      }));
      const result = await pollWith(poller({ maxDurationMs: 2_000 }), ORG_A, secretA, [
        ...garbage,
        { chatId: CHAT_B, text: `/start ${token}` },
      ]);
      expect(result).toMatchObject({ refused: 10, linked: 1 });
      // The poller itself sends nothing.
      expect(telegram.callsOf('sendMessage')).toEqual([]);
      const limiter = new MemoryTelegramReplyLimiter();
      const outcomes = await deliverReplies(limiter);
      expect(outcomes.filter((outcome) => outcome === 'sent')).toHaveLength(4);
      expect(outcomes.filter((outcome) => outcome === 'capped')).toHaveLength(7);
      expect(telegram.sent().filter((sent) => sent.chatId === String(CHAT_A))).toHaveLength(3);
      expect(telegram.sent().filter((sent) => sent.chatId === String(CHAT_B))).toEqual([
        { chatId: String(CHAT_B), text: telegramLinkReply('linked', 'vi') },
      ]);
      expect(
        await channels().isLinkedTo(
          orgScope(ORG_A),
          MEMBER,
          'telegram',
          secretA,
          address.lookup(secretA, String(CHAT_B)),
        ),
      ).toBe(true);
      expect(await tokens().lockByHash(orgScope(ORG_A), hashToken(keep))).toMatchObject({
        used_at: null,
      });
    });

    it('a 429 drops the reply (not retried); another bot or a gone secret is not sent', async () => {
      await link(ORG_A, a.userId, secretA);
      await pollWith(poller({ maxDurationMs: 1_500 }), ORG_A, secretA, [
        { chatId: CHAT_A, text: `/start ${newToken()}` },
        { chatId: CHAT_A, text: `/start ${newToken()}` },
      ]);
      telegram.queue('sendMessage', {
        status: 429,
        body: { ok: false, error_code: 429, parameters: { retry_after: 30 } },
      });
      expect(await deliverReplies()).toEqual(['rate_limited', 'sent']);
      await pollWith(poller({ maxDurationMs: 1_500 }), ORG_A, secretA, [
        { chatId: CHAT_A, text: `/start ${newToken()}` },
      ]);
      // The bot changed before the reply went out: not sent.
      await setBot(ORG_A, otherSecretA, 555_000_222);
      telegram.calls.length = 0;
      expect(await deliverReplies()).toEqual(['not_notification_bot']);
      expect(telegram.calls).toEqual([]);
    });
  });

  describe('end of the time budget (QA S5b L1)', () => {
    it('never calls getUpdates without waiting, even under 2 s before the end', async () => {
      await link(ORG_A, MEMBER, secretA);
      // The clock starts 1.9 s before the end of the budget and moves 200 ms a read.
      const start = Date.now();
      let reads = 0;
      const p = poller({
        now: () => new Date(start + (reads++ === 0 ? 0 : 28_100 + reads * 200)),
        maxDurationMs: 30_000,
        pollTimeoutSeconds: 25,
      });
      expect((await p.poll(ORG_A, secretA)).outcome).toBe('continue');
      expect(telegram.callsOf('getUpdates').filter((call) => call.body['timeout'] === 0)).toEqual(
        [],
      );
    });
  });

  describe('bot change', () => {
    it('puts every channel of the organization in error and cancels pending links', async () => {
      const token = await link(ORG_A, MEMBER, secretA);
      await pollWith(poller(), ORG_A, secretA, [{ chatId: CHAT_A, text: `/start ${token}` }]);
      await link(ORG_A, a.userId, secretA);
      await channels().upsertLinked(orgScope(ORG_B), {
        id: newId('uch'),
        userId: MEMBER,
        kind: 'telegram',
        secretId: secretB,
        addressEnc: address.seal(String(CHAT_B)),
        addressHmac: address.lookup(secretB, String(CHAT_B)),
        linkedAt: new Date(),
      });
      published.length = 0;
      const users = await db.withTx((tx) => resetChannelsForNewBot(db, tx, ORG_A, new Date()));
      expect(users).toEqual([MEMBER]);
      expect((await channels().listForUser(orgScope(ORG_A), MEMBER))[0]).toMatchObject({
        status: 'error',
        error_reason: 'bot_changed',
      });
      expect((await channels().listForUser(orgScope(ORG_B), MEMBER))[0]?.status).toBe('linked');
      expect(await tokens().hasPendingForBot(orgScope(ORG_A), secretA, new Date())).toBe(false);
      expect(published).toEqual([
        expect.objectContaining({ type: 'channel.changed', user_id: MEMBER, status: 'error' }),
      ]);
      // Twice changes nothing more.
      expect(await db.withTx((tx) => resetChannelsForNewBot(db, tx, ORG_A, new Date()))).toEqual(
        [],
      );
    });
  });

  describe('canaries', () => {
    it('no token, chat id or Telegram name in columns, audit, envelopes, jobs or results', async () => {
      const token = await link(ORG_A, MEMBER, secretA);
      await db.withTx((tx) => enqueueTelegramPoll(tx, ORG_A, secretA));
      const result = await pollWith(poller(), ORG_A, secretA, [
        { chatId: CHAT_A, text: `/start ${token}` },
      ]);
      await link(ORG_A, a.userId, secretA);
      await pollWith(poller({ maxDurationMs: 1_500 }), ORG_A, secretA, [
        { chatId: CHAT_A, text: '/stop' },
      ]);
      const client = new pg.Client({ connectionString: database.adminUrl });
      await client.connect();
      try {
        const dump = JSON.stringify(
          await Promise.all(
            [
              'SELECT * FROM meta.user_channels',
              'SELECT * FROM meta.user_channel_link_tokens',
              'SELECT * FROM meta.audit_logs',
              'SELECT * FROM meta.organizations',
              'SELECT * FROM meta.secrets',
              'SELECT payload, key FROM graphile_worker._private_jobs',
            ].map(async (query) => (await client.query<Record<string, unknown>>(query)).rows),
          ),
        );
        for (const canary of [
          token,
          String(CHAT_A),
          'Secret Name',
          BOT_TOKEN,
          BOT_TOKEN.split(':')[1] ?? '',
        ]) {
          expect(dump).not.toContain(canary);
          expect(JSON.stringify(published)).not.toContain(canary);
          expect(JSON.stringify(result)).not.toContain(canary);
        }
      } finally {
        await client.end();
      }
    });
  });
});
