/**
 * BACKLOG T550 (ADR-34 §3, CONTRACTS §22.1, §22.4): notifications over
 * Telegram against PostgreSQL and a fake Bot API (no real network) —
 * `NotificationWriter` queues the `telegram` channel by the recipient's
 * choices, `NotificationTelegramDelivery` checks again at send time, groups
 * into one message, escapes every value, and handles `429`, 5xx, `403`,
 * `400 chat not found`, `401`; the per-chat and per-bot limits; tenant
 * isolation of the channel outbox; canaries (no token, chat id or content in
 * outcomes or columns).
 */
import { Buffer } from 'node:buffer';

import { newId, type Id } from '@cellhive/contracts';
import { systemRoleConfig } from '@cellhive/permissions';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { deriveSecretKey, sealSecret } from '../../src/auth/index.js';
import { createMemoryTelegramPacers, type TelegramSendPacers } from '../../src/automation/index.js';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  OrgMembersRepository,
  orgScope,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import {
  NotificationBaseMutesRepository,
  NotificationEmailOutboxRepository,
  NotificationFanout,
  NotificationOutboxRepository,
  NotificationPreferencesRepository,
  NotificationSettingsRepository,
  NotificationTelegramDelivery,
  NotificationWriter,
  orgTelegramSettingsOf,
  TelegramChatAddress,
  UserChannelsRepository,
  withOrgTelegramSettings,
  type NotificationTelegramDeliveryOptions,
  type PreparedNotification,
} from '../../src/notifications/index.js';
import { attachRealtimePublisher, type RealtimeEnvelope } from '../../src/realtime/index.js';
import { RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { insertRows } from '../records/fixtures.js';
import { startFakeTelegramBot, type FakeTelegramBot } from '../support/fake-telegram-bot.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { FieldRow, JsonObject, TableRow } from '../../src/db/schema.js';
import type { Clock, SendPacer } from '../../src/mail/index.js';

const ORG_A: Id<'org'> = 'org_TgDeliverOrgA001';
const ORG_B: Id<'org'> = 'org_TgDeliverOrgB001';
const AUT: Id<'aut'> = 'aut_TgDeliverAuto001';
const RUN: Id<'run'> = 'run_TgDeliverRun0001';
const PUBLIC_URL = 'https://ob.example.test/';
const MASTER_KEY = Buffer.alloc(32, 7);
const BOT_TOKEN = '555000333:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDtgcanary';
const OTHER_BOT_TOKEN = '555000444:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDtgcanary';
const SECRET_VALUE = 'TOPSECRET-FIELD';
const DEFAULTS = { timeZone: 'UTC', locale: 'en' };

/** Pacers that never wait (tests of the delivery itself). */
const unlimited: TelegramSendPacers = (() => {
  const pacer: SendPacer = {
    acquire: () => Promise.resolve({ release: () => Promise.resolve() }),
  };
  return { bot: pacer, chat: pacer };
})();

describe('Telegram notification delivery (T550)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let telegram: FakeTelegramBot;
  let a: SeededTenant;
  let b: SeededTenant;
  let scopeA: OrgScope;
  let table: TableRow;
  let title: FieldRow;
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;
  let readerRole: Id<'rol'>;
  let secretA: Id<'sec'>;
  let otherSecretA: Id<'sec'>;
  let secretB: Id<'sec'>;
  let clock = new Date('2026-10-17T01:00:00.000Z');
  let nextChat = 7_100_000_001;
  const published: RealtimeEnvelope[] = [];
  const address = new TelegramChatAddress(MASTER_KEY);
  const writer = (emailEnabled = true) => new NotificationWriter(db, { emailEnabled });
  const telegramOutbox = () => new NotificationOutboxRepository(db, 'telegram');

  function delivery(options: Partial<NotificationTelegramDeliveryOptions> = {}) {
    return new NotificationTelegramDelivery(db, new RecordQueryService(db), {
      publicUrl: PUBLIC_URL,
      defaults: DEFAULTS,
      masterKey: MASTER_KEY,
      pacers: unlimited,
      client: { baseUrl: telegram.baseUrl },
      now: () => clock,
      ...options,
    });
  }

  interface Member {
    readonly id: Id<'usr'>;
    readonly chatId: string;
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

  async function setBot(orgId: Id<'org'>, secretId: Id<'sec'> | null, botId = 555_000_333) {
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

  async function linkChannel(
    orgId: Id<'org'>,
    userId: Id<'usr'>,
    secretId: Id<'sec'>,
    chatId: string,
  ): Promise<void> {
    await new UserChannelsRepository(db).upsertLinked(orgScope(orgId), {
      id: newId('uch'),
      userId,
      kind: 'telegram',
      secretId,
      addressEnc: address.seal(chatId),
      addressHmac: address.lookup(secretId, chatId),
      linkedAt: clock,
    });
  }

  /** A member of A with the base `reader` role and (by default) a linked Telegram channel. */
  async function newMember(
    key: string,
    options: { locale?: string; linked?: boolean } = {},
  ): Promise<Member> {
    const id = newId('usr');
    await db.kysely
      .insertInto('meta.users')
      .values({
        id,
        email: `${key}.${id.slice(4, 10).toLowerCase()}@example.test`,
        display_name: `User ${key}`,
        locale: options.locale ?? null,
      })
      .execute();
    await new OrgMembersRepository(db).add(scopeA, id, 'member');
    await new BaseRoleMembersRepository(db).assign(scopeA, {
      baseId: a.baseId,
      roleId: readerRole,
      principalType: 'user',
      principalId: id,
    });
    const chatId = String((nextChat += 1));
    if (options.linked !== false) await linkChannel(ORG_A, id, secretA, chatId);
    return { id, chatId };
  }

  const message = (
    userId: Id<'usr'>,
    text: string,
    overrides: Partial<PreparedNotification> = {},
  ): PreparedNotification => ({
    userId,
    type: 'automation.message',
    baseId: a.baseId,
    tableId: table.id,
    entityType: 'record',
    entityId: r1,
    actor: null,
    groupKey: null,
    data: { automation_id: AUT, run_id: RUN, title: text, body: `Body of ${text}` },
    ...overrides,
  });

  const assigned = (userId: Id<'usr'>, recordId: Id<'rec'> = r1): PreparedNotification => ({
    userId,
    type: 'record.assigned',
    baseId: a.baseId,
    tableId: table.id,
    entityType: 'record',
    entityId: recordId,
    actor: null,
    groupKey: null,
    data: { batch_id: null, count: 1, record_ids: [recordId], field_ids: [title.id] },
  });

  const disabled = (userId: Id<'usr'>): PreparedNotification => ({
    userId,
    type: 'automation.disabled',
    baseId: a.baseId,
    tableId: null,
    entityType: 'automation',
    entityId: AUT,
    actor: null,
    groupKey: null,
    data: { automation_id: AUT, reason: 'circuit_breaker' },
  });

  async function notify(
    items: readonly PreparedNotification[],
    options: { emailEnabled?: boolean; org?: Id<'org'> } = {},
  ) {
    const written = await db.withTx((tx) =>
      writer(options.emailEnabled ?? true).write(tx, options.org ?? ORG_A, items),
    );
    return written;
  }

  async function idsOf(items: readonly PreparedNotification[]) {
    return (await notify(items)).map((row) => row.id as Id<'ntf'>);
  }

  async function statuses(ids: readonly Id<'ntf'>[], channel: 'email' | 'telegram' = 'telegram') {
    const rows = await db.kysely
      .selectFrom('meta.notification_deliveries')
      .select(['notification_id', 'status', 'error_code', 'attempts'])
      .where('notification_id', 'in', [...ids])
      .where('channel', '=', channel)
      .execute();
    return ids.map((id) => {
      const row = rows.find((item) => item.notification_id === id);
      return row === undefined ? null : [row.status, row.error_code];
    });
  }

  async function telegramJobs(userId: Id<'usr'>, orgId: Id<'org'> = ORG_A) {
    const { rows } = await sql<{ payload: Record<string, unknown>; run_at: Date }>`
      SELECT payload, jobs.run_at
        FROM graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id)
       WHERE jobs.task_identifier = 'notifications.deliver'
         AND jobs.key = ${`notifications.deliver:telegram:${orgId}:${userId}`}
    `.execute(db.kysely);
    return rows;
  }

  const deliverTo = (member: Member, options: Partial<NotificationTelegramDeliveryOptions> = {}) =>
    delivery(options).deliver({
      organization_id: ORG_A,
      user_id: member.id,
      reason: 'immediate',
      channel: 'telegram',
    });

  const sentTo = (member: Member) =>
    telegram.sent().filter((call) => call.chatId === member.chatId);

  const failWith = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    telegram.queue('sendMessage', { status, body, headers });
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url, { poolMax: 8 });
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 2 });
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    await new OrgMembersRepository(db).add(scopeA, a.userId, 'owner');
    await new OrgMembersRepository(db).add(orgScope(ORG_B), b.userId, 'owner');

    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const created = await schema.createTable(
      scopeA,
      { baseId: a.baseId, name: 'Orders', primaryFieldName: 'title' },
      systemAuditContext(),
    );
    table = created.table;
    title = created.primaryField;
    const secretField = await schema.addField(
      scopeA,
      table.id,
      { name: 'secret', type: 'text', options: {} },
      systemAuditContext(),
    );
    [r1, r2] = (await insertRows(pool, table, [
      {
        [title.db_column_name as string]: '<b>x</b>',
        [secretField.db_column_name as string]: `${SECRET_VALUE}-1`,
      },
      {
        [title.db_column_name as string]: 'Order R2',
        [secretField.db_column_name as string]: `${SECRET_VALUE}-2`,
      },
    ])) as [Id<'rec'>, Id<'rec'>];
    const role = await new BaseRolesRepository(db).create(scopeA, {
      baseId: a.baseId,
      name: 'Reader',
      kind: 'system_reader',
      config: systemRoleConfig('reader', {
        tables: [
          {
            id: table.id,
            fields: [title, secretField].map((field) => ({ id: field.id, type: field.type })),
          },
        ],
        dashboards: [],
      }) as unknown as JsonObject,
    });
    readerRole = role.id;

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
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  beforeEach(async () => {
    await setBot(ORG_A, secretA);
    await setBot(ORG_B, secretB);
    telegram.calls.length = 0;
    published.length = 0;
    clock = new Date('2026-10-17T01:00:00.000Z');
  });

  describe('NotificationWriter: which deliveries are queued', () => {
    it('linked channel + default preference → a telegram delivery and one job 5 s later (preserve_run_at)', async () => {
      const member = await newMember('queued');
      const before = Date.now();
      const first = await notify([message(member.id, 'One')]);
      expect(first).toEqual([
        {
          userId: member.id,
          id: expect.stringMatching(/^ntf_/) as unknown,
          inApp: true,
          emailQueued: true,
          telegramQueued: true,
        },
      ]);
      const [job] = await telegramJobs(member.id);
      expect(job?.payload).toEqual({
        organization_id: ORG_A,
        user_id: member.id,
        reason: 'immediate',
        channel: 'telegram',
      });
      const runAt = job?.run_at.getTime() ?? 0;
      expect(runAt).toBeGreaterThanOrEqual(before + 5_000 - 1_000);
      expect(runAt).toBeLessThanOrEqual(before + 5_000 + 10_000);
      // Later ones join the same job: its time does not move.
      await notify([message(member.id, 'Two')]);
      await notify([message(member.id, 'Three')]);
      const jobs = await telegramJobs(member.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.run_at.getTime()).toBe(runAt);
      // The email job is a separate one (5 minutes).
      const { rows } = await sql<{ n: string }>`
        SELECT count(*) AS n FROM graphile_worker.jobs
         WHERE key = ${`notifications.deliver:${ORG_A}:${member.id}`}
      `.execute(db.kysely);
      expect(Number(rows[0]?.n)).toBe(1);
    });

    it('nothing queued without a linked channel, without bot, through another bot, or in error', async () => {
      const unlinked = await newMember('unlinked', { linked: false });
      expect((await notify([message(unlinked.id, 'x')]))[0]?.telegramQueued).toBe(false);
      expect(await telegramJobs(unlinked.id)).toEqual([]);

      const noBot = await newMember('nobot');
      await setBot(ORG_A, null);
      expect((await notify([message(noBot.id, 'x')]))[0]?.telegramQueued).toBe(false);
      await setBot(ORG_A, secretA);

      // Linked through a bot that is not the notification bot any more.
      const stale = await newMember('stale', { linked: false });
      await linkChannel(ORG_A, stale.id, otherSecretA, '7100999001');
      expect((await notify([message(stale.id, 'x')]))[0]?.telegramQueued).toBe(false);

      const broken = await newMember('broken');
      await new UserChannelsRepository(db).markError(scopeA, broken.id, 'telegram', 'blocked');
      expect((await notify([message(broken.id, 'x')]))[0]?.telegramQueued).toBe(false);
      expect(await telegramJobs(broken.id)).toEqual([]);
    });

    it('does not depend on the email frequency nor on SMTP', async () => {
      const off = await newMember('freqoff');
      await new NotificationSettingsRepository(db).upsert(scopeA, off.id, {
        emailFrequency: 'off',
        dailyHour: 8,
      });
      expect(await notify([message(off.id, 'x')])).toMatchObject([
        { emailQueued: false, telegramQueued: true },
      ]);
      const noSmtp = await newMember('nosmtp');
      expect(await notify([message(noSmtp.id, 'x')], { emailEnabled: false })).toMatchObject([
        { emailQueued: false, telegramQueued: true },
      ]);
      // In-app and email off, Telegram on: the row exists for Telegram only.
      await new NotificationPreferencesRepository(db).upsert(scopeA, noSmtp.id, [
        { type: 'automation.message', channel: 'in_app', enabled: false },
      ]);
      published.length = 0;
      expect(await notify([message(noSmtp.id, 'y')], { emailEnabled: false })).toMatchObject([
        { inApp: false, emailQueued: false, telegramQueued: true },
      ]);
      expect(published).toEqual([]);
    });

    it('milestone: the channel turned off is not used, the other one still is', async () => {
      const member = await newMember('milestone');
      const preferences = new NotificationPreferencesRepository(db);
      await preferences.upsert(scopeA, member.id, [
        { type: 'record.assigned', channel: 'telegram', enabled: false },
      ]);
      expect(await notify([assigned(member.id)])).toMatchObject([
        { emailQueued: true, telegramQueued: false },
      ]);
      await preferences.upsert(scopeA, member.id, [
        { type: 'record.assigned', channel: 'telegram', enabled: true },
        { type: 'record.assigned', channel: 'email', enabled: false },
      ]);
      expect(await notify([assigned(member.id)])).toMatchObject([
        { emailQueued: false, telegramQueued: true },
      ]);
    });

    it('defaults follow the email default of the type (followed_changed off)', async () => {
      const member = await newMember('defaults');
      const followed: PreparedNotification = {
        ...message(member.id, 'f'),
        type: 'record.followed_changed',
        data: { field_ids: [title.id], change_count: 2, actor_ids: [] },
      };
      expect(await notify([followed])).toMatchObject([
        { inApp: true, emailQueued: false, telegramQueued: false },
      ]);
    });

    it('a muted base silences Telegram, except for a mandatory type', async () => {
      const member = await newMember('muted');
      await new NotificationBaseMutesRepository(db).mute(scopeA, member.id, a.baseId);
      expect(await notify([message(member.id, 'quiet'), disabled(member.id)])).toMatchObject([
        { telegramQueued: false },
        { telegramQueued: true },
      ]);
    });

    it('grouped notifications of the buffer flush (T544/T545 runGrouped) queue Telegram too', async () => {
      const member = await newMember('grouped');
      const silent = await newMember('groupedoff');
      await new NotificationPreferencesRepository(db).upsert(scopeA, silent.id, [
        { type: 'record.assigned', channel: 'telegram', enabled: false },
      ]);
      const fanout = new NotificationFanout(db, new RecordQueryService(db), {
        emailEnabled: false,
        defaults: DEFAULTS,
      });
      const accepted: Id<'usr'>[] = [];
      const result = await db.withTx((tx) =>
        fanout.runGrouped(tx, ORG_A, {
          type: 'record.assigned',
          baseId: a.baseId,
          tableId: table.id,
          entityType: 'table',
          entityId: table.id,
          actor: null,
          groupKey: `batch_tg:${table.id}`,
          recipients: [member.id, silent.id],
          requires: { recordIds: [r1, r2] },
          dataFor: (_userId, readable) => ({
            batch_id: 'batch_tg',
            count: readable.recordIds.length,
            record_ids: [...readable.recordIds],
            field_ids: [title.id],
          }),
          onAccepted: (userId) => {
            accepted.push(userId);
            return Promise.resolve();
          },
        }),
      );
      expect(accepted.sort()).toEqual([member.id, silent.id].sort());
      const byUser = new Map(result.written.map((row) => [row.userId, row]));
      expect(byUser.get(member.id)).toMatchObject({ telegramQueued: true, emailQueued: false });
      expect(byUser.get(silent.id)).toMatchObject({ telegramQueued: false });
      expect(await telegramJobs(member.id)).toHaveLength(1);
      expect(await telegramJobs(silent.id)).toEqual([]);
      // Delivered as one grouped item listing the records the member reads.
      expect(await deliverTo(member)).toMatchObject({ status: 'sent', sent: 1 });
      const text = sentTo(member)[0]?.text ?? '';
      expect(text).toContain('You were assigned 2 records in “Orders”');
      expect(text).toContain('&lt;b&gt;x&lt;/b&gt;');
      expect(text).toContain('Order R2');
    });
  });

  describe('NotificationTelegramDelivery', () => {
    it('3 notifications within the batch → one message to the linked chat, all sent', async () => {
      const member = await newMember('batch', { locale: 'vi' });
      const ids = [
        ...(await idsOf([message(member.id, 'Tin A')])),
        ...(await idsOf([message(member.id, 'Tin B')])),
        ...(await idsOf([message(member.id, 'Tin C')])),
      ];
      const outcome = await deliverTo(member);
      expect(outcome).toEqual({ status: 'sent', sent: 3, shown: 3, skipped: {}, more: false });
      const sent = sentTo(member);
      expect(sent).toHaveLength(1);
      const text = sent[0]?.text ?? '';
      expect(text.startsWith('<b>3 thông báo mới trong ')).toBe(true);
      for (const part of ['Tin A', 'Tin B', 'Tin C', 'Body of Tin A', 'Mở trong Cellhive']) {
        expect(text).toContain(part);
      }
      // The primary field `<b>x</b>` is shown literally; no other field value.
      expect(text).toContain('Bản ghi: &lt;b&gt;x&lt;/b&gt;');
      expect(text).not.toContain(SECRET_VALUE);
      expect(text).toContain(`https://ob.example.test/b/${a.baseId}/t/${table.id}?record=${r1}`);
      const call = telegram.callsOf('sendMessage').at(-1);
      expect(call?.token).toBe(BOT_TOKEN);
      expect(call?.body).toMatchObject({ chat_id: member.chatId, parse_mode: 'HTML' });
      expect(await statuses(ids)).toEqual([
        ['sent', null],
        ['sent', null],
        ['sent', null],
      ]);
      // Idempotent: a second run finds nothing.
      expect(await deliverTo(member)).toEqual({ status: 'nothing' });
      expect(sentTo(member)).toHaveLength(1);
    });

    it('checks again at send time: preference turned off, base muted, access lost', async () => {
      const member = await newMember('recheck');
      const ids = await idsOf([
        message(member.id, 'Keep'),
        assigned(member.id),
        message(member.id, 'Trashed', { entityId: r2 }),
      ]);
      await new NotificationPreferencesRepository(db).upsert(scopeA, member.id, [
        { type: 'record.assigned', channel: 'telegram', enabled: false },
      ]);
      await pool.query(
        `UPDATE data.${pg.escapeIdentifier(table.db_table_name)} SET __deleted_at = now() WHERE __id = $1`,
        [r2],
      );
      try {
        expect(await deliverTo(member)).toEqual({
          status: 'sent',
          sent: 1,
          shown: 1,
          skipped: { preference_off: 1, cannot_read_record: 1 },
          more: false,
        });
      } finally {
        await pool.query(
          `UPDATE data.${pg.escapeIdentifier(table.db_table_name)} SET __deleted_at = NULL WHERE __id = $1`,
          [r2],
        );
      }
      const text = sentTo(member)[0]?.text ?? '';
      expect(text).toContain('Keep');
      expect(text).not.toContain('Trashed');
      expect(text).not.toContain('Order R2');
      expect(await statuses(ids)).toEqual([
        ['sent', null],
        ['skipped', 'preference_off'],
        ['skipped', 'cannot_read_record'],
      ]);

      // Muted after queueing: not sent (mandatory types still are).
      const muted = await newMember('mutedlate');
      const mutedIds = await idsOf([message(muted.id, 'Muted'), disabled(muted.id)]);
      await new NotificationBaseMutesRepository(db).mute(scopeA, muted.id, a.baseId);
      expect(await deliverTo(muted)).toMatchObject({
        status: 'sent',
        sent: 1,
        skipped: { muted: 1 },
      });
      expect(await statuses(mutedIds)).toEqual([
        ['skipped', 'muted'],
        ['sent', null],
      ]);

      // The role is removed: nothing is sent, no empty message.
      const gone = await newMember('gone');
      const goneIds = await idsOf([message(gone.id, 'Gone'), disabled(gone.id)]);
      await new BaseRoleMembersRepository(db).remove(scopeA, a.baseId, 'user', gone.id);
      expect(await deliverTo(gone)).toEqual({
        status: 'skipped',
        skipped: { cannot_read_base: 2 },
        more: false,
      });
      expect(sentTo(gone)).toEqual([]);
      expect(await statuses(goneIds)).toEqual([
        ['skipped', 'cannot_read_base'],
        ['skipped', 'cannot_read_base'],
      ]);

      // A disabled user: not a member any more for deliveries.
      const off = await newMember('disabled');
      const offIds = await idsOf([message(off.id, 'Off')]);
      await db.kysely
        .updateTable('meta.users')
        .set({ status: 'disabled' })
        .where('id', '=', off.id)
        .execute();
      expect(await deliverTo(off)).toEqual({
        status: 'skipped',
        skipped: { not_member: 1 },
        more: false,
      });
      expect(await statuses(offIds)).toEqual([['skipped', 'not_member']]);
    });

    it('bot removed → telegram_not_configured; channel removed or of another bot → channel_error', async () => {
      const member = await newMember('nobotlater');
      const ids = await idsOf([message(member.id, 'x')]);
      await setBot(ORG_A, null);
      expect(await deliverTo(member)).toEqual({
        status: 'skipped',
        skipped: { telegram_not_configured: 1 },
        more: false,
      });
      expect(await statuses(ids)).toEqual([['skipped', 'telegram_not_configured']]);
      await setBot(ORG_A, secretA);

      const unlinked = await newMember('unlinkedlater');
      const unlinkedIds = await idsOf([message(unlinked.id, 'x')]);
      await new UserChannelsRepository(db).deleteForUser(scopeA, unlinked.id, 'telegram');
      expect(await deliverTo(unlinked)).toEqual({
        status: 'skipped',
        skipped: { channel_error: 1 },
        more: false,
      });
      expect(await statuses(unlinkedIds)).toEqual([['skipped', 'channel_error']]);

      const moved = await newMember('botchanged');
      const movedIds = await idsOf([message(moved.id, 'x')]);
      await setBot(ORG_A, otherSecretA, 555_000_444);
      expect(await deliverTo(moved)).toEqual({
        status: 'skipped',
        skipped: { channel_error: 1 },
        more: false,
      });
      expect(await statuses(movedIds)).toEqual([['skipped', 'channel_error']]);
      expect(telegram.callsOf('sendMessage')).toEqual([]);
    });

    it('429 retry_after 2 → stays pending, a run 2 s later replaces the waiting one, then sent', async () => {
      const member = await newMember('ratelimited');
      const ids = await idsOf([message(member.id, 'Later')]);
      failWith(429, { ok: false, error_code: 429, parameters: { retry_after: 2 } });
      const outcome = await deliverTo(member);
      expect(outcome).toEqual({
        status: 'deferred',
        pending: 1,
        retryAt: new Date(clock.getTime() + 2_000),
        reason: 'rate_limited',
      });
      expect(await statuses(ids)).toEqual([['pending', null]]);
      const attempts = await db.kysely
        .selectFrom('meta.notification_deliveries')
        .select('attempts')
        .where('notification_id', '=', ids[0] as Id<'ntf'>)
        .where('channel', '=', 'telegram')
        .executeTakeFirstOrThrow();
      expect(attempts.attempts).toBe(0);
      const jobs = await telegramJobs(member.id);
      expect(jobs.map((job) => job.run_at.getTime())).toContain(clock.getTime() + 2_000);

      clock = new Date(clock.getTime() + 2_000);
      expect(await deliverTo(member)).toMatchObject({ status: 'sent', sent: 1 });
      expect(await statuses(ids)).toEqual([['sent', null]]);
    });

    it('5xx/timeout → attempts counted and retried; the 5th attempt fails (telegram_unavailable)', async () => {
      const member = await newMember('unavailable');
      const ids = await idsOf([message(member.id, 'Flaky')]);
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        failWith(502, { ok: false });
        expect(await deliverTo(member)).toEqual({
          status: 'retry',
          attempts: attempt,
          cause: 'server_error',
        });
        expect(await statuses(ids)).toEqual([['pending', 'telegram_unavailable']]);
      }
      failWith(503, { ok: false });
      expect(await deliverTo(member)).toEqual({
        status: 'failed',
        failed: 1,
        code: 'telegram_unavailable',
        skipped: {},
        channelError: false,
        more: false,
      });
      expect(await statuses(ids)).toEqual([['failed', 'telegram_unavailable']]);
    });

    it.each([
      [
        '403 (bot blocked)',
        403,
        { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      ],
      [
        '400 chat not found',
        400,
        { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
      ],
    ])(
      '%s → failed telegram_blocked, channel error (blocked), the rest of the queue skipped',
      async (_name, status, body) => {
        const member = await newMember(`blocked${String(status)}`);
        // More than one run reads: the deliveries past the first 200 are skipped, not retried.
        const items = Array.from({ length: 203 }, (_, i) => message(member.id, `N${String(i)}`));
        const ids = await idsOf(items);
        published.length = 0;
        failWith(status, body);
        expect(await deliverTo(member)).toEqual({
          status: 'failed',
          failed: 200,
          code: 'telegram_blocked',
          skipped: { channel_error: 3 },
          channelError: true,
          more: false,
        });
        const all = await statuses(ids);
        expect(all.filter((row) => row?.[1] === 'telegram_blocked')).toHaveLength(200);
        expect(all.filter((row) => row?.[1] === 'channel_error')).toHaveLength(3);
        const [channel] = await new UserChannelsRepository(db).listForUser(scopeA, member.id);
        expect(channel).toMatchObject({ status: 'error', error_reason: 'blocked' });
        expect(published).toEqual([
          {
            v: expect.any(Number) as unknown,
            type: 'channel.changed',
            organization_id: ORG_A,
            user_id: member.id,
            kind: 'telegram',
            status: 'error',
          },
        ]);
        // Nothing more is queued for that chat until the member links again.
        expect((await notify([message(member.id, 'after')]))[0]?.telegramQueued).toBe(false);
        expect(telegram.callsOf('sendMessage')).toHaveLength(1);
      },
    );

    it('another 4xx → failed telegram_rejected, the channel stays linked', async () => {
      const member = await newMember('rejected');
      const ids = await idsOf([message(member.id, 'x')]);
      failWith(400, {
        ok: false,
        error_code: 400,
        description: "Bad Request: can't parse entities",
      });
      expect(await deliverTo(member)).toMatchObject({
        status: 'failed',
        code: 'telegram_rejected',
        channelError: false,
      });
      expect(await statuses(ids)).toEqual([['failed', 'telegram_rejected']]);
      const [channel] = await new UserChannelsRepository(db).listForUser(scopeA, member.id);
      expect(channel).toMatchObject({ status: 'linked', error_reason: null });
    });

    it('401 → failed telegram_invalid_token and the bot status invalid_token', async () => {
      const member = await newMember('revoked');
      const ids = await idsOf([message(member.id, 'x')]);
      failWith(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      expect(await deliverTo(member)).toMatchObject({
        status: 'failed',
        code: 'telegram_invalid_token',
      });
      expect(await statuses(ids)).toEqual([['failed', 'telegram_invalid_token']]);
      const org = await db.kysely
        .selectFrom('meta.organizations')
        .select('settings')
        .where('id', '=', ORG_A)
        .executeTakeFirstOrThrow();
      expect(orgTelegramSettingsOf(org.settings).status).toBe('invalid_token');
    });

    it('more than 10 items → one message, "and N more" with the organization link, all sent', async () => {
      const member = await newMember('many');
      // One transaction each: oldest first is their order.
      const ids: Id<'ntf'>[] = [];
      for (let i = 1; i <= 13; i += 1) {
        ids.push(...(await idsOf([message(member.id, `Item ${String(i)}`)])));
      }
      expect(await deliverTo(member)).toEqual({
        status: 'sent',
        sent: 13,
        shown: 10,
        skipped: {},
        more: false,
      });
      const text = sentTo(member)[0]?.text ?? '';
      expect(text).toContain('<b>Item 10</b>');
      expect(text).not.toContain('<b>Item 11</b>');
      expect(text).toContain(
        `<a href="https://ob.example.test/o/${a.orgId.slice(4).toLowerCase()}">And 3 more notifications`,
      );
      expect(new Set((await statuses(ids)).map((row) => row?.[0]))).toEqual(new Set(['sent']));
    });

    it('1 message per second per chat: the second run waits for the chat slot', async () => {
      const member = await newMember('chatpace');
      let now = 0;
      const sleeps: number[] = [];
      const clockLike: Clock = {
        now: () => now,
        sleep: (ms) => {
          sleeps.push(ms);
          now += ms;
          return Promise.resolve();
        },
      };
      const pacers = createMemoryTelegramPacers(clockLike);
      await idsOf([message(member.id, 'First')]);
      expect(await deliverTo(member, { pacers })).toMatchObject({ status: 'sent' });
      expect(sleeps).toEqual([]);
      await idsOf([message(member.id, 'Second')]);
      expect(await deliverTo(member, { pacers })).toMatchObject({ status: 'sent' });
      expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(900);
      expect(sentTo(member)).toHaveLength(2);
    });

    it('25 messages per second per bot: 40 recipients at once never exceed it', async () => {
      const members: Member[] = [];
      for (let i = 0; i < 40; i += 1) members.push(await newMember(`burst${String(i)}`));
      for (const member of members) await idsOf([message(member.id, 'Burst')]);
      const times: number[] = [];
      const pacers = createMemoryTelegramPacers();
      const timedFetch = ((input: string | URL | Request, init?: RequestInit) => {
        times.push(performance.now());
        return fetch(input, init);
      }) as typeof fetch;
      // 12 runs at a time (each holds a transaction and reads beside it), like busy workers.
      const burstDb = createTestDb(database.url, { poolMax: 30 });
      const burst = new NotificationTelegramDelivery(burstDb, new RecordQueryService(burstDb), {
        publicUrl: PUBLIC_URL,
        defaults: DEFAULTS,
        masterKey: MASTER_KEY,
        pacers,
        client: { baseUrl: telegram.baseUrl, fetch: timedFetch },
        now: () => clock,
      });
      const queue = [...members];
      const outcomes: Awaited<ReturnType<NotificationTelegramDelivery['deliver']>>[] = [];
      try {
        await Promise.all(
          Array.from({ length: 12 }, async () => {
            for (let member = queue.shift(); member !== undefined; member = queue.shift()) {
              outcomes.push(
                await burst.deliver({
                  organization_id: ORG_A,
                  user_id: member.id,
                  reason: 'immediate',
                  channel: 'telegram',
                }),
              );
            }
          }),
        );
      } finally {
        await burstDb.destroy();
      }
      expect(outcomes.every((outcome) => outcome.status === 'sent')).toBe(true);
      expect(times).toHaveLength(40);
      times.sort((x, y) => x - y);
      for (let i = 0; i + 25 < times.length; i += 1) {
        // The 26th call after any call is at least one second later.
        expect((times[i + 25] ?? 0) - (times[i] ?? 0)).toBeGreaterThanOrEqual(990);
      }
    });

    it('never puts the token, the chat id or the text in outcomes or columns', async () => {
      const member = await newMember('canary');
      const ids = await idsOf([message(member.id, 'Canary title')]);
      failWith(403, { ok: false, error_code: 403, description: `Forbidden ${BOT_TOKEN}` });
      const outcome = await deliverTo(member);
      const json = JSON.stringify(outcome);
      for (const secret of [BOT_TOKEN, member.chatId, 'Canary title', 'tgcanary']) {
        expect(json).not.toContain(secret);
      }
      const { rows } = await sql<Record<string, unknown>>`
        SELECT d.*, c.address_enc, c.address_hmac, c.error_reason
          FROM meta.notification_deliveries d
          JOIN meta.notifications n ON n.organization_id = d.organization_id AND n.id = d.notification_id
          JOIN meta.user_channels c ON c.organization_id = n.organization_id AND c.user_id = n.user_id
         WHERE d.notification_id IN (${sql.join(ids)})
      `.execute(db.kysely);
      const stored = JSON.stringify(rows);
      expect(stored).not.toContain(member.chatId);
      expect(stored).not.toContain(BOT_TOKEN);
      expect(stored).not.toContain('Forbidden');
    });
  });

  describe('tenant isolation', () => {
    it('the Telegram outbox of one organization never reads or changes another, nor the email outbox', async () => {
      const member = await newMember('tenant');
      const [row] = await notify([message(member.id, 'A only')]);
      const id = row?.id as Id<'ntf'>;
      const scopeB = orgScope(ORG_B);
      const outbox = telegramOutbox();
      await db.withTx(async (tx) => {
        expect(await outbox.lockPending(orgScope(ORG_B, tx), member.id, 10)).toEqual([]);
        expect(await outbox.lockPending(orgScope(ORG_A, tx), member.id, 10)).toHaveLength(1);
      });
      expect(await outbox.markSent(scopeB, [id], clock)).toBe(0);
      expect(await outbox.markSkipped(scopeB, [id], 'muted')).toBe(0);
      expect(await outbox.markFailed(scopeB, [id], 'telegram_rejected')).toBe(0);
      expect(await outbox.recordAttempt(scopeB, [id], 'telegram_unavailable')).toBe(0);
      expect(await outbox.skipAllPending(scopeB, member.id, 'channel_error')).toBe(0);
      expect((await outbox.oldestPending(scopeB, [member.id])).size).toBe(0);
      expect((await outbox.oldestPending(scopeA, [member.id])).has(member.id)).toBe(true);
      // The email outbox of the same notification is another row.
      expect(await new NotificationEmailOutboxRepository(db).markSent(scopeA, [id], clock)).toBe(1);
      expect(await statuses([id], 'telegram')).toEqual([['pending', null]]);
      expect(await statuses([id], 'email')).toEqual([['sent', null]]);
      // `linkedUsers` of another organization finds nobody.
      const channels = new UserChannelsRepository(db);
      expect(await channels.linkedUsers(scopeB, [member.id], 'telegram', secretA)).toEqual(
        new Set(),
      );
      expect(await channels.linkedUsers(scopeA, [member.id], 'telegram', secretA)).toEqual(
        new Set([member.id]),
      );
      // A delivery job of B for A's member sends nothing.
      expect(
        await delivery().deliver({
          organization_id: ORG_B,
          user_id: member.id,
          reason: 'immediate',
          channel: 'telegram',
        }),
      ).toEqual({ status: 'nothing' });
      expect(await statuses([id], 'telegram')).toEqual([['pending', null]]);
    });

    it("a member of two organizations gets each organization's notifications through its own bot", async () => {
      const member = await newMember('twoorgs');
      await new OrgMembersRepository(db).add(orgScope(ORG_B), member.id, 'member');
      await linkChannel(ORG_B, member.id, secretB, '7100555001');
      const [inB] = await notify(
        [
          {
            ...disabled(member.id),
            baseId: b.baseId,
          },
        ],
        { org: ORG_B },
      );
      expect(inB?.telegramQueued).toBe(true);
      expect(await telegramJobs(member.id, ORG_B)).toHaveLength(1);
      expect(
        await delivery().deliver({
          organization_id: ORG_B,
          user_id: member.id,
          reason: 'immediate',
          channel: 'telegram',
        }),
      ).toMatchObject({ status: 'skipped', skipped: { cannot_read_base: 1 } });
      // A's queue of that member is untouched.
      expect(await deliverTo(member)).toEqual({ status: 'nothing' });
    });
  });
});
