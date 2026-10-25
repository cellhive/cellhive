import { randomBytes } from 'node:crypto';

import {
  ACTIVE_NOTIFICATION_TYPES,
  NOTIFICATION_DEFAULTS,
  notificationPreferencesSchema,
  newId,
  orgNotificationChannelsSchema,
  secretSchema,
  userChannelListSchema,
  type Id,
  type SecretDto,
} from '@cellhive/contracts';
import {
  AutomationRunEngine,
  AutomationRunsRepository,
  AutomationsRepository,
  BaseRoleMembersRepository,
  BaseRolesRepository,
  createSendTelegramAction,
  createValkeyTelegramPacers,
  defaultActionRegistry,
  NO_AUTOMATION_NOTIFICATIONS,
  NotificationFanout,
  NotificationTelegramDelivery,
  NotificationWriter,
  orgScope,
  RecordMutationService,
  RecordQueryService,
  TelegramChatAddress,
  UserChannelsRepository,
  valkeyQuotaClient,
  type Db,
  type DeferrableJob,
  type JsonObject,
  type NotificationsFanoutPayload,
  type TelegramSendPacers,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCacheClient } from '../../src/common/infra/connections.js';
import { DB } from '../../src/common/tokens.js';

import { seedUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';
import { startFakeTelegramBot, type FakeTelegramBot } from './telegram-bot-support.js';

import type { Redis } from 'ioredis';

const TOKEN = '424243001:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDtgdeliv';
const DEFAULTS = { timeZone: 'UTC', locale: 'en' };

function jobOf(orgId: Id<'org'>, runId: Id<'run'>): DeferrableJob {
  return {
    task_identifier: 'automation.run',
    payload: { organization_id: orgId, run_id: runId },
    priority: 0,
    attempts: 1,
    max_attempts: 25,
    key: null,
    flags: null,
    queue_name: null,
  };
}

/** Most calls within any one second of `times` (ms). */
function maxWithinOneSecond(times: readonly number[]): number {
  const sorted = [...times].sort((x, y) => x - y);
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while ((sorted[end] ?? 0) - (sorted[start] ?? 0) >= 1_000) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/**
 * BACKLOG T550 through the app (CONTRACTS §22.1, §22.3, §22.4, §22.7):
 * `GET|PUT …/me/notification-preferences` with the `telegram` channel (only
 * while the organization has a notification bot), P42 for deliveries (a
 * member who cannot read the record gets nothing over Telegram, neither at
 * fan-out nor when sent), a refused chat seen by the UI through `GET
 * …/me/channels`, and the per-bot limit shared by `send_telegram` and
 * notification deliveries across two processes (Valkey): never more than
 * 25 calls per second to the fake Bot API.
 */
describe('notifications over Telegram (T550)', () => {
  let database: TestDatabase;
  let db: Db;
  let appDb: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let telegram: FakeTelegramBot;
  let bot: SecretDto;
  let query: RecordQueryService;
  let address: TelegramChatAddress;
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;
  let readerRole: Id<'rol'>;
  let nextChat = 8_200_000_001;
  const chats = new Map<Id<'usr'>, string>();
  const extraClients: Redis[] = [];

  const org = (path = '') => `/orgs/${fx.orgId}${path}`;
  const scope = () => orgScope(fx.orgId);
  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;

  async function setBot(secretId: Id<'sec'> | null) {
    const response = await fx.call('owner', 'PATCH', org('/notification-channels'), {
      telegram_secret_id: secretId,
    });
    expect(response.statusCode, response.body).toBe(200);
    return orgNotificationChannelsSchema.parse(response.json());
  }

  async function link(userId: Id<'usr'>): Promise<string> {
    const chatId = String((nextChat += 1));
    await new UserChannelsRepository(db).upsertLinked(scope(), {
      id: newId('uch'),
      userId,
      kind: 'telegram',
      secretId: bot.id,
      addressEnc: address.seal(chatId),
      addressHmac: address.lookup(bot.id, chatId),
      linkedAt: new Date(),
    });
    chats.set(userId, chatId);
    return chatId;
  }

  async function preferences(user: FixtureUser) {
    const response = await fx.call(user, 'GET', org('/me/notification-preferences'));
    expect(response.statusCode, response.body).toBe(200);
    return notificationPreferencesSchema.parse(response.json()).items;
  }

  function delivery(pacers?: TelegramSendPacers): NotificationTelegramDelivery {
    const none = {
      acquire: () => Promise.resolve({ release: () => Promise.resolve() }),
    };
    return new NotificationTelegramDelivery(appDb, query, {
      publicUrl: TEST_PUBLIC_URL,
      defaults: DEFAULTS,
      masterKey: t.config.security.appMasterKey,
      pacers: pacers ?? { bot: none, chat: none },
      client: { baseUrl: telegram.baseUrl },
    });
  }

  const deliverTo = (userId: Id<'usr'>, pacers?: TelegramSendPacers) =>
    delivery(pacers).deliver({
      organization_id: fx.orgId,
      user_id: userId,
      reason: 'immediate',
      channel: 'telegram',
    });

  const sentTo = (userId: Id<'usr'>) =>
    telegram.sent().filter((call) => call.chatId === chats.get(userId));

  function messageAbout(recordId: Id<'rec'>, title: string): NotificationsFanoutPayload {
    return {
      organization_id: fx.orgId,
      type: 'automation.message',
      base_id: fx.baseId,
      table_id: fx.orders.id,
      entity_type: 'record',
      entity_id: recordId,
      actor: null,
      group_key: null,
      recipients: { user_ids: [fx.users.u_sales1.id, fx.users.u_reader.id], base_admins: false },
      requires: { record_id: recordId, field_ids: [] },
      skip_actor: false,
      data: {
        automation_id: 'aut_TgApiAuto0000001',
        run_id: 'run_TgApiRun00000001',
        title,
        body: `About ${title}`,
      },
    };
  }

  async function createRecord(fields: Record<string, unknown>): Promise<Id<'rec'>> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ fields }] },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    telegram = await startFakeTelegramBot();
    telegram.setUsername(TOKEN, 'acme_delivery_bot');
    t = await startTestApp(
      { DATABASE_URL: database.url },
      { telegramClient: { baseUrl: telegram.baseUrl } },
    );
    appDb = t.app.get<Db>(DB);
    query = t.app.get(RecordQueryService);
    address = new TelegramChatAddress(t.config.security.appMasterKey);
    fx = await buildRecordFixture(t, db);
    const created = await fx.call('owner', 'POST', org('/secrets'), {
      kind: 'telegram_bot',
      name: 'Thông báo',
      value: TOKEN,
    });
    expect(created.statusCode, created.body).toBe(201);
    bot = secretSchema.parse(created.json());
    // CONTRACTS §5: u_sales1 reads the orders they own only.
    r1 = await createRecord({
      [F('title')]: '<b>R1</b>',
      [F('owner')]: [{ id: fx.users.u_sales1.id }],
    });
    r2 = await createRecord({
      [F('title')]: 'Đơn R2',
      [F('owner')]: [{ id: fx.users.u_sales2.id }],
    });
    const roles = await new BaseRolesRepository(db).listByBase(scope(), fx.baseId);
    readerRole = roles.find((role) => role.kind === 'system_reader')?.id as Id<'rol'>;
  });

  afterAll(async () => {
    for (const client of extraClients) client.disconnect();
    await t.close();
    await telegram.close();
    await db.destroy();
    await database.drop();
  });

  describe('GET|PUT …/me/notification-preferences', () => {
    it('without a bot: no telegram column; a telegram preference is still stored', async () => {
      const items = await preferences('u_sales1');
      expect(items.some((item) => item.channel === 'telegram')).toBe(false);
      expect(items).toHaveLength(ACTIVE_NOTIFICATION_TYPES.length * 2);
      const put = await fx.call('u_sales1', 'PUT', org('/me/notification-preferences'), {
        items: [{ type: 'automation.message', channel: 'telegram', enabled: false }],
      });
      expect(put.statusCode, put.body).toBe(200);
      expect(
        notificationPreferencesSchema
          .parse(put.json())
          .items.some((item) => item.channel === 'telegram'),
      ).toBe(false);
    });

    it('with a bot: telegram for every produced type, default = the email default, stored value kept', async () => {
      await setBot(bot.id);
      const items = await preferences('u_sales1');
      expect(items).toHaveLength(ACTIVE_NOTIFICATION_TYPES.length * 3);
      for (const type of ACTIVE_NOTIFICATION_TYPES) {
        const telegramItem = items.find(
          (item) => item.type === type && item.channel === 'telegram',
        );
        expect(telegramItem).toMatchObject({ locked: false });
        if (type !== 'automation.message') {
          expect(telegramItem?.enabled).toBe(NOTIFICATION_DEFAULTS[type].email);
        }
      }
      // Stored before the bot existed.
      expect(
        items.find((item) => item.type === 'automation.message' && item.channel === 'telegram'),
      ).toMatchObject({ enabled: false });
      const put = await fx.call('u_sales1', 'PUT', org('/me/notification-preferences'), {
        items: [
          { type: 'automation.message', channel: 'telegram', enabled: true },
          { type: 'import.finished', channel: 'telegram', enabled: true },
        ],
      });
      expect(put.statusCode, put.body).toBe(200);
      const after = notificationPreferencesSchema.parse(put.json()).items;
      expect(
        after.filter((item) => item.channel === 'telegram' && item.enabled).map((i) => i.type),
      ).toEqual(expect.arrayContaining(['automation.message', 'import.finished']));
      // Mandatory in-app still locked; Telegram of a mandatory type can be turned off.
      const mandatory = await fx.call('u_sales1', 'PUT', org('/me/notification-preferences'), {
        items: [{ type: 'automation.disabled', channel: 'telegram', enabled: false }],
      });
      expect(mandatory.statusCode, mandatory.body).toBe(200);
      expectProblem(
        await fx.call('u_sales1', 'PUT', org('/me/notification-preferences'), {
          items: [{ type: 'automation.disabled', channel: 'in_app', enabled: false }],
        }),
        422,
        'VALIDATION_FAILED',
      );
      expectProblem(
        await fx.call('u_sales1', 'PUT', org('/me/notification-preferences'), {
          items: [{ type: 'automation.message', channel: 'sms', enabled: false }],
        }),
        422,
        'VALIDATION_FAILED',
      );
      // Not a member: 404.
      expectProblem(
        await fx.call('stranger', 'GET', org('/me/notification-preferences')),
        404,
        'NOT_FOUND',
      );
      // Each user sees their own choices only.
      expect(
        (await preferences('u_reader')).find(
          (item) => item.type === 'automation.message' && item.channel === 'telegram',
        ),
      ).toMatchObject({ enabled: true });
    });
  });

  describe('delivery', () => {
    it('P42: a member who cannot read the record gets nothing over Telegram (fan-out and send time)', async () => {
      await setBot(bot.id);
      await link(fx.users.u_sales1.id);
      await link(fx.users.u_reader.id);
      const fanout = new NotificationFanout(appDb, query, {
        emailEnabled: false,
        defaults: DEFAULTS,
      });
      // About r2 (owned by u_sales2): only u_reader may read it.
      const result = await fanout.run(messageAbout(r2, 'Về R2'));
      expect(result.skipped).toEqual([
        { userId: fx.users.u_sales1.id, reason: 'cannot_read_record' },
      ]);
      expect(result.written).toMatchObject([
        { userId: fx.users.u_reader.id, telegramQueued: true },
      ]);
      // Written for u_sales1 anyway (as if access was lost after the fan-out): dropped when sent.
      const [forced] = await appDb.withTx((tx) =>
        new NotificationWriter(appDb, { emailEnabled: false }).write(tx, fx.orgId, [
          {
            userId: fx.users.u_sales1.id,
            type: 'automation.message',
            baseId: fx.baseId,
            tableId: fx.orders.id,
            entityType: 'record',
            entityId: r2,
            actor: null,
            groupKey: null,
            data: {
              automation_id: 'aut_TgApiAuto0000001',
              run_id: 'run_TgApiRun00000001',
              title: 'Về R2 (bỏ qua)',
              body: 'never',
            },
          },
        ]),
      );
      expect(forced?.telegramQueued).toBe(true);
      expect(await deliverTo(fx.users.u_sales1.id)).toEqual({
        status: 'skipped',
        skipped: { cannot_read_record: 1 },
        more: false,
      });
      expect(sentTo(fx.users.u_sales1.id)).toEqual([]);
      expect(await deliverTo(fx.users.u_reader.id)).toMatchObject({ status: 'sent', sent: 1 });
      const [message] = sentTo(fx.users.u_reader.id);
      expect(message?.text).toContain('Về R2');
      expect(message?.text).toContain('Bản ghi: Đơn R2');

      // About r1 (owned by u_sales1): both read it; its primary field shows literally.
      await fanout.run(messageAbout(r1, 'Về R1'));
      expect(await deliverTo(fx.users.u_sales1.id)).toMatchObject({ status: 'sent', sent: 1 });
      expect(sentTo(fx.users.u_sales1.id)[0]?.text).toContain('Bản ghi: &lt;b&gt;R1&lt;/b&gt;');
    });

    it('a refused chat (403) shows as error/blocked in GET …/me/channels', async () => {
      await setBot(bot.id);
      await link(fx.users.u_editor.id);
      const fanout = new NotificationFanout(appDb, query, {
        emailEnabled: false,
        defaults: DEFAULTS,
      });
      await fanout.run({
        ...messageAbout(r1, 'Bị chặn'),
        recipients: { user_ids: [fx.users.u_editor.id], base_admins: false },
      });
      telegram.queue('sendMessage', {
        status: 403,
        body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      });
      expect(await deliverTo(fx.users.u_editor.id)).toMatchObject({
        status: 'failed',
        code: 'telegram_blocked',
        channelError: true,
      });
      const response = await fx.call('u_editor', 'GET', org('/me/channels'));
      expect(response.statusCode, response.body).toBe(200);
      expect(userChannelListSchema.parse(response.json()).items).toEqual([
        {
          kind: 'telegram',
          status: 'error',
          error_reason: 'blocked',
          linked_at: expect.any(String) as unknown,
          bot_username: 'acme_delivery_bot',
        },
      ]);
      expect(response.body).not.toContain(chats.get(fx.users.u_editor.id) ?? 'none');
    });

    it('send_telegram and 40 notifications on one bot within a second: ≤ 25 calls per second (Valkey, two processes)', async () => {
      await setBot(bot.id);
      // 40 recipients who read the base, each with a linked chat.
      const members: Id<'usr'>[] = [];
      for (let i = 0; i < 40; i += 1) {
        const user = await seedUser(db, {
          memberships: [{ orgId: fx.orgId, role: 'member' }],
          password: null,
        });
        await new BaseRoleMembersRepository(db).assign(scope(), {
          baseId: fx.baseId,
          roleId: readerRole,
          principalType: 'user',
          principalId: user.id,
        });
        await link(user.id);
        members.push(user.id);
      }
      const fanout = new NotificationFanout(appDb, query, {
        emailEnabled: false,
        defaults: DEFAULTS,
      });
      await fanout.run({
        ...messageAbout(r1, 'Hàng loạt'),
        recipients: { user_ids: members, base_admins: false },
      });

      // Two "processes": each its own Valkey connection, one shared bucket per bot.
      const keyPrefix = `t550-${randomBytes(4).toString('hex')}:`;
      const pacersOf = (): TelegramSendPacers => {
        const client = createCacheClient(t.config, captureLogger().logger);
        extraClients.push(client);
        return createValkeyTelegramPacers(valkeyQuotaClient(client), { keyPrefix });
      };
      const automationPacers = pacersOf();
      const deliveryPacers = pacersOf();

      // 10 automation runs with `send_telegram` on the same bot.
      const engine = new AutomationRunEngine(appDb, {
        defaults: DEFAULTS,
        query,
        actions: defaultActionRegistry({ records: t.app.get(RecordMutationService), query }, [
          [
            'send_telegram',
            createSendTelegramAction({
              db: appDb,
              masterKey: t.config.security.appMasterKey,
              client: { baseUrl: telegram.baseUrl },
              pacer: automationPacers.bot,
            }),
          ],
        ]),
        publicUrl: TEST_PUBLIC_URL,
        notifier: NO_AUTOMATION_NOTIFICATIONS,
        random: () => 0,
        // All 10 runs at once (the default is 5 per organization).
        maxRunningPerOrg: 10,
      });
      const definition = {
        trigger: { type: 'schedule', cron: '0 8 * * *', timezone: null },
        condition: null,
        actions: [
          {
            id: 'act_tg',
            type: 'send_telegram',
            config: {
              secret_id: bot.id,
              chat_id: { literal: '-100777000111' },
              text: { template: 'Báo cáo', digest: null },
            },
          },
        ],
      } as unknown as JsonObject;
      const automationId = newId('aut');
      await new AutomationsRepository(db).insert(scope(), {
        id: automationId,
        baseId: fx.baseId,
        name: 'Báo Telegram',
        description: '',
        enabled: true,
        definition,
        triggerType: 'schedule',
        triggerTableId: null,
        createdBy: fx.users.u_admin.id,
      });
      const runIds: Id<'run'>[] = [];
      for (let i = 0; i < 10; i += 1) {
        const runId = newId('run');
        await new AutomationRunsRepository(db).insert(scope(), {
          id: runId,
          automationId,
          automationVersion: 1,
          triggerEventId: null,
          triggerUnit: newId('evt'),
          status: 'queued',
          depth: 0,
          input: {
            automation_version: 1,
            definition,
            trigger: {
              event_id: null,
              event_created_at: null,
              type: 'schedule',
              table_id: null,
              record_id: null,
              bulk: false,
              batch: null,
              fired_at: new Date().toISOString(),
            },
          },
        });
        runIds.push(runId);
      }

      const before = telegram.callsOf('sendMessage').length;
      const queue = [...members];
      const outcomes = await Promise.all([
        ...runIds.map((runId) => engine.execute(scope(), runId, jobOf(fx.orgId, runId))),
        // Deliveries run 8 at a time (each holds a transaction), like busy workers.
        ...Array.from({ length: 8 }, async () => {
          const done: string[] = [];
          for (let user = queue.shift(); user !== undefined; user = queue.shift()) {
            done.push((await deliverTo(user, deliveryPacers)).status);
          }
          return done;
        }),
      ]);
      const calls = telegram.callsOf('sendMessage').slice(before);
      expect(calls).toHaveLength(50);
      expect(calls.every((call) => call.token === TOKEN)).toBe(true);
      expect(maxWithinOneSecond(calls.map((call) => call.at))).toBeLessThanOrEqual(25);
      expect(outcomes.slice(10).flat()).toEqual(Array.from({ length: 40 }, () => 'sent'));
      // Both senders took slots of the same bucket.
      const cache = extraClients[0] as Redis;
      expect(await cache.exists(`${keyPrefix}pace:telegram:bot:424243001`)).toBe(1);
      // No token or chat id in the logs.
      expect(t.logs.raw()).not.toContain('AAHdqTcv');
      for (const chat of chats.values()) expect(t.logs.raw()).not.toContain(chat);
    });
  });
});
