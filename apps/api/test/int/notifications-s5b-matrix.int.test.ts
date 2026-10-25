import {
  automationSchema,
  notificationListSchema,
  orgNotificationChannelsSchema,
  recordFollowSchema,
  roleListSchema,
  roleSchema,
  secretSchema,
  userChannelListSchema,
  type AutomationDto,
  type Id,
  type NotificationDto,
  type RealtimeServerMessage,
} from '@cellhive/contracts';
import { scheduleNotificationFlush, type Db, type JsonObject } from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB } from '../../src/common/tokens.js';

import { startSmtpCapture, type SmtpCapture } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';
import { startFakeTelegramBot, type FakeTelegramBot } from './telegram-bot-support.js';

const TOKEN = '557557001:AAHdqTcvCH1vGWJxfSeofSAs0K5PALmatrix';
const BOT_USERNAME = 'acme_matrix_bot';
const CHATS = { u_sales1: 557_000_001, u_reader: 557_000_002 } as const;
type LinkedUser = keyof typeof CHATS;
const DAY_MS = 86_400_000;

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The decoded `text/plain` part of a raw `multipart/alternative` message. */
function plainText(raw: string): string {
  const boundary = /boundary="?([^";\r\n]+)"?/u.exec(raw)?.[1] ?? '';
  for (const part of raw.split(`--${boundary}`)) {
    const split = part.search(/\r?\n\r?\n/u);
    if (split < 0 || !/content-type:\s*text\/plain/iu.test(part.slice(0, split))) continue;
    const head = part.slice(0, split);
    const body = part.slice(split).trim();
    if (/content-transfer-encoding:\s*base64/iu.test(head)) {
      return Buffer.from(body.replace(/\s+/gu, ''), 'base64').toString('utf8');
    }
    if (/content-transfer-encoding:\s*quoted-printable/iu.test(head)) {
      const bytes: number[] = [];
      const value = body.replace(/=\r?\n/gu, '');
      for (let i = 0; i < value.length; i += 1) {
        const hex = value.slice(i + 1, i + 3);
        if (value[i] === '=' && /^[0-9A-F]{2}$/iu.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
        } else {
          bytes.push(value.charCodeAt(i));
        }
      }
      return Buffer.from(bytes).toString('utf8');
    }
    return body;
  }
  return '';
}

/** `YYYY-MM-DD` of `days` days before today (UTC). */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The S5b rows of the CONTRACTS §5 permission matrix (P39–P43, BACKLOG
 * T557, "Phụ lục ma trận quyền S5b") over HTTP with the real worker
 * (graphile-worker: `events.dispatch`, `notifications.fanout|flush|deliver`,
 * `notifications.date_reminder_scan`, `notifications.telegram_poll`), a fake
 * SMTP server and a fake Telegram Bot API: for every row, what a member may
 * not read reaches them on **no** channel — in-app list, realtime, email,
 * Telegram — and what they may read reaches them on each channel they keep
 * on. Fixture of CONTRACTS §5 plus, on Orders, `due` (date only, Ho Chi
 * Minh City) and `reviewers` (`user`, `notify_on_assign`), both added over
 * HTTP; u_sales1 and u_reader link Telegram through the real `/start <token>`
 * flow of the org's notification bot.
 *
 * Time is never injected: the 60 s debounce of `followed` flushes is ended
 * by moving the pending flush to now (as T545), and a reminder is made due
 * by setting a past date and moving the field's cursor back by SQL before
 * queuing the scan job (the worker's own clock decides).
 *
 * Where the rows also run at the service level: P39 `record-follows`,
 * `record-followed-changed`; P40 `record-assigned`, `record-assigned-dispatch`;
 * P41 `date-reminders`; P42 `notification-channels`, `notifications-telegram`;
 * P43 `automation-duplicate`.
 */
describe('S5b permission matrix over HTTP: P39–P43 (T557)', () => {
  let database: TestDatabase;
  let db: Db;
  let smtp: SmtpCapture;
  let telegram: FakeTelegramBot;
  let t: TestApp;
  let url: string;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let due: Id<'fld'>;
  let reviewers: Id<'fld'>;
  let salesRole: Id<'rol'>;
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;
  const sockets: TestSocket[] = [];
  const { logger, logs } = captureLogger();

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const U = (user: FixtureUser) => fx.users[user].id;
  const org = (path = '') => `/orgs/${fx.orgId}${path}`;
  const followUrl = (recordId: Id<'rec'>) => `/tables/${fx.orders.id}/records/${recordId}/follow`;

  /** What reached a user so far, on every channel (to diff around one step). */
  interface Received {
    readonly inApp: NotificationDto[];
    readonly emails: string[];
    readonly telegram: string[];
  }

  async function inAppOf(user: FixtureUser): Promise<NotificationDto[]> {
    const response = await fx.call(user, 'GET', org('/me/notifications?limit=200'));
    expect(response.statusCode, response.body).toBe(200);
    return notificationListSchema.parse(response.json()).items;
  }

  async function receivedBy(user: FixtureUser): Promise<Received> {
    const chat = user in CHATS ? String(CHATS[user as LinkedUser]) : null;
    return {
      inApp: await inAppOf(user),
      emails: smtp.messages
        .filter((message) => message.to.includes(fx.users[user].email))
        .map((message) => plainText(message.raw)),
      telegram: telegram
        .sent()
        .filter((message) => message.chatId === chat)
        .map((message) => message.text),
    };
  }

  /** What arrived after `before`. */
  async function since(user: FixtureUser, before: Received): Promise<Received> {
    const now = await receivedBy(user);
    const known = new Set(before.inApp.map((item) => item.id));
    return {
      inApp: now.inApp.filter((item) => !known.has(item.id)),
      emails: now.emails.slice(before.emails.length),
      telegram: now.telegram.slice(before.telegram.length),
    };
  }

  const nothing: Received = { inApp: [], emails: [], telegram: [] };

  /**
   * Every event dispatched, every fan-out, `assigned` flush, delivery and
   * scan done, no delivery left pending (`followed` flushes wait 60 s:
   * `flushFollowed` ends them).
   */
  async function settled(): Promise<void> {
    await eventually(
      async () => {
        const { rows } = await sql<{ events: number; jobs: number; pending: number }>`
          SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL) AS events,
                 (SELECT count(*)::int FROM graphile_worker._private_jobs p
                    JOIN graphile_worker._private_tasks k ON k.id = p.task_id
                   WHERE k.identifier IN ('events.dispatch', 'notifications.fanout',
                                          'notifications.deliver',
                                          'notifications.date_reminder_scan')
                      OR (k.identifier = 'notifications.flush'
                          AND p.payload->>'kind' = 'assigned')) AS jobs,
                 (SELECT count(*)::int FROM meta.notification_deliveries
                   WHERE status = 'pending') AS pending
        `.execute(db.kysely);
        const row = rows[0];
        return row !== undefined && row.events === 0 && row.jobs === 0 && row.pending === 0;
      },
      'events, fan-outs, flushes and deliveries to settle',
      120_000,
    );
  }

  /** Ends the 60 s debounce of the `followed` group of a record now and waits for its flush. */
  async function flushFollowed(recordId: Id<'rec'>): Promise<void> {
    await settled();
    const buffered = async () =>
      (
        await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM meta.notification_buffer
           WHERE kind = 'followed' AND group_key = ${recordId}
        `.execute(db.kysely)
      ).rows[0]?.n ?? 0;
    if ((await buffered()) > 0) {
      await db.withTx((tx) =>
        scheduleNotificationFlush(
          tx,
          { organization_id: fx.orgId, kind: 'followed', group_key: recordId },
          new Date(),
        ),
      );
      await eventually(async () => (await buffered()) === 0, `the flush of ${recordId}`);
    }
    await settled();
  }

  async function createOrder(fields: Record<string, unknown>): Promise<Id<'rec'>> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ fields }] },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  async function edit(user: FixtureUser, recordId: Id<'rec'>, fields: Record<string, unknown>) {
    const response = await fx.call(
      user,
      'PATCH',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ id: recordId, fields }] },
    );
    expect(response.statusCode, response.body).toBe(200);
  }

  async function socketOf(user: FixtureUser): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    expect(await socket.subscribe(`user:${U(user)}`)).toMatchObject({ type: 'subscribed' });
    return socket;
  }

  const isCreated = (type: string) => (message: RealtimeServerMessage) =>
    message.type === 'notification.created' && message.notification_type === type;

  async function link(user: LinkedUser): Promise<void> {
    const created = await fx.call(user, 'POST', org('/me/channels/telegram'));
    expect(created.statusCode, created.body).toBe(201);
    const token = new URL(created.json<{ link: string }>().link).searchParams.get('start') ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    telegram.send({ chatId: CHATS[user], text: `/start ${token}` });
    await eventually(async () => {
      const response = await fx.call(user, 'GET', org('/me/channels'));
      const items = userChannelListSchema.parse(response.json()).items;
      return items[0]?.status === 'linked';
    }, `${user} linked`);
  }

  async function salesConfig() {
    const roles = roleListSchema.parse(
      (await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    ).items;
    const sales = roles.find((role) => role.id === salesRole);
    if (sales === undefined) throw new Error('no Sales role');
    return sales.config;
  }

  /** Changes the Orders entry of the Sales role through `PATCH /bases/:id/roles/:roleId`. */
  async function patchSalesOrders(
    change: (orders: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const config = await salesConfig();
    const tables = config.tables as Record<string, Record<string, unknown>>;
    const response = await fx.call('u_admin', 'PATCH', `/bases/${fx.baseId}/roles/${salesRole}`, {
      config: {
        ...config,
        tables: { ...tables, [fx.orders.id]: change(tables[fx.orders.id] ?? {}) },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  /** Moves the cursor of the `due` reminder back to `at` and runs one scan in the worker. */
  async function scanRemindersFrom(at: Date): Promise<void> {
    await settled();
    await sql`
      UPDATE meta.date_reminder_cursors
         SET armed_at = ${at}, scanned_until = ${at},
             boundary_due_at = NULL, boundary_record_ids = '{}'
       WHERE organization_id = ${fx.orgId} AND field_id = ${due}
    `.execute(db.kysely);
    await sql`SELECT graphile_worker.add_job('notifications.date_reminder_scan', '{}'::json)`.execute(
      db.kysely,
    );
    await settled();
  }

  /** The skip reasons the worker logged for the fan-out of `type` about `recordId`. */
  function fanoutSkips(type: string, recordId: Id<'rec'>): Record<string, number>[] {
    return logs.lines
      .filter(
        (line) =>
          line['msg'] === 'notifications fanned out' &&
          line['notification_type'] === type &&
          line['entity_id'] === recordId,
      )
      .map((line) => line['skipped'] as Record<string, number>);
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    smtp = await startSmtpCapture();
    telegram = await startFakeTelegramBot();
    telegram.setUsername(TOKEN, BOT_USERNAME);
    t = await startTestApp(
      {
        DATABASE_URL: database.url,
        SMTP_URL: smtp.url,
        SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
        SMTP_ALLOW_INSECURE: 'true',
      },
      { telegramClient: { baseUrl: telegram.baseUrl } },
    );
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);

    // "Phụ lục ma trận quyền S5b": `due` and `reviewers` on Orders, over HTTP.
    const dueField = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'due',
      type: 'datetime',
      options: { style: { format: 'yyyy-MM-dd' }, timezone: 'Asia/Ho_Chi_Minh' },
    });
    expect(dueField.statusCode, dueField.body).toBe(201);
    due = dueField.json<{ id: Id<'fld'> }>().id;
    const reviewersField = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'reviewers',
      type: 'user',
      options: { multiple: true, notify_on_assign: true },
    });
    expect(reviewersField.statusCode, reviewersField.body).toBe(201);
    reviewers = reviewersField.json<{ id: Id<'fld'> }>().id;
    const roles = roleListSchema.parse(
      (await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    ).items;
    salesRole = roles.find((role) => role.name === 'Sales')?.id as Id<'rol'>;

    // The organization's notification bot (owner), checked with `getMe` on the fake.
    const secret = await fx.call('owner', 'POST', org('/secrets'), {
      kind: 'telegram_bot',
      name: 'Thông báo',
      value: TOKEN,
    });
    expect(secret.statusCode, secret.body).toBe(201);
    const bot = await fx.call('owner', 'PATCH', org('/notification-channels'), {
      telegram_secret_id: secretSchema.parse(secret.json()).id,
    });
    expect(bot.statusCode, bot.body).toBe(200);
    expect(orgNotificationChannelsSchema.parse(bot.json()).telegram.bot_username).toBe(
      BOT_USERNAME,
    );

    // The worker of the API's database handle (its realtime bus is attached),
    // email and Telegram batches shortened, the fake Bot API, short polls.
    worker = await createWorker(t.config, {
      logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db: t.app.get<Db>(DB),
        logger,
        notificationEmailBatchMs: 500,
        notificationTelegramBatchMs: 300,
        telegramClient: { baseUrl: telegram.baseUrl },
        telegramPoll: { pollTimeoutSeconds: 1, maxDurationMs: 5_000 },
      }),
    });
    await link('u_sales1');
    await link('u_reader');

    // CONTRACTS §5 data: r1 (owner u_sales1), r2 (owner u_sales2).
    r1 = await createOrder({ [F('title')]: 'Đơn r1', [F('owner')]: [{ id: U('u_sales1') }] });
    r2 = await createOrder({ [F('title')]: 'Đơn r2', [F('owner')]: [{ id: U('u_sales2') }] });
    // u_sales1 keeps every channel of the S5b types on (followed_changed is off by default).
    const preferences = await fx.call('u_sales1', 'PUT', org('/me/notification-preferences'), {
      items: ['email', 'telegram'].map((channel) => ({
        type: 'record.followed_changed',
        channel,
        enabled: true,
      })),
    });
    expect(preferences.statusCode, preferences.body).toBe(200);
    await settled();
  }, 180_000);

  afterAll(async () => {
    await closeSockets(sockets);
    await worker.close();
    await t.close();
    await telegram.close();
    await smtp.close();
    await db.destroy();
    await database.drop();
  });

  it('P39: follow r2 → 404, r1 → 204; a change of cost tells u_sales1 nothing, of amount → field_ids [amount]', async () => {
    expectProblem(await fx.call('u_sales1', 'PUT', followUrl(r2)), 404, 'NOT_FOUND');
    expectProblem(await fx.call('u_sales1', 'GET', followUrl(r2)), 404, 'NOT_FOUND');
    const followed = await fx.call('u_sales1', 'PUT', followUrl(r1));
    expect(followed.statusCode, followed.body).toBe(204);
    expect(
      recordFollowSchema.parse((await fx.call('u_sales1', 'GET', followUrl(r1))).json()),
    ).toEqual({ following: true, source: 'manual' });
    const socket = await socketOf('u_sales1');

    // u_editor changes `cost` (no_perm for Sales): nothing on any channel.
    let before = await receivedBy('u_sales1');
    await edit('u_editor', r1, { [F('cost')]: 700 });
    await flushFollowed(r1);
    expect(await since('u_sales1', before)).toEqual(nothing);
    await socket.expectNone(isCreated('record.followed_changed'), 500);

    // Then `amount`: one notification naming `amount` only, with its email and Telegram.
    before = await receivedBy('u_sales1');
    await edit('u_editor', r1, { [F('amount')]: 1_500 });
    await flushFollowed(r1);
    await socket.next(isCreated('record.followed_changed'), 30_000);
    const got = await since('u_sales1', before);
    expect(got.inApp).toHaveLength(1);
    expect(got.inApp[0]).toMatchObject({
      type: 'record.followed_changed',
      entity: { type: 'record', id: r1, title: 'Đơn r1' },
      actor: { type: 'user', id: U('u_editor') },
      data: { field_ids: [F('amount')], change_count: 1, actor_ids: [U('u_editor')] },
    });
    expect(got.emails).toHaveLength(1);
    expect(got.emails[0]).toContain('Đơn r1');
    expect(got.telegram).toHaveLength(1);
    expect(got.telegram[0]).toContain('Đơn r1');
    // Nothing of the hidden value travelled: neither the cost nor its field.
    for (const text of [...got.emails, ...got.telegram, JSON.stringify(got.inApp)]) {
      expect(text).not.toContain('700');
      expect(text).not.toContain(F('cost'));
    }
  });

  it('P40: assigned to reviewers of r2 (unreadable) → nothing anywhere, no follow; of r1 → record.assigned + follow', async () => {
    const socket = await socketOf('u_sales1');
    let before = await receivedBy('u_sales1');
    await edit('u_editor', r2, { [reviewers]: [{ id: U('u_sales1') }] });
    await flushFollowed(r2);
    expect(await since('u_sales1', before)).toEqual(nothing);
    await socket.expectNone(isCreated('record.assigned'), 500);
    expect(fanoutSkips('record.assigned', r2)).toEqual([{ cannot_read_record: 1 }]);
    const follows = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.record_follows
       WHERE record_id = ${r2} AND user_id = ${U('u_sales1')}
    `.execute(db.kysely);
    expect(follows.rows[0]?.n).toBe(0);

    before = await receivedBy('u_sales1');
    await edit('u_editor', r1, { [reviewers]: [{ id: U('u_sales1') }] });
    await socket.next(isCreated('record.assigned'), 30_000);
    await settled();
    const assigned = await since('u_sales1', before);
    expect(assigned.inApp).toHaveLength(1);
    expect(assigned.inApp[0]).toMatchObject({
      type: 'record.assigned',
      entity: { type: 'record', id: r1, title: 'Đơn r1' },
      actor: { type: 'user', id: U('u_editor') },
      data: { batch_id: null, count: 1, record_ids: [r1], field_ids: [reviewers] },
    });
    expect(assigned.emails).toHaveLength(1);
    expect(assigned.emails[0]).toContain('Đơn r1');
    expect(assigned.telegram).toHaveLength(1);
    expect(assigned.telegram[0]).toContain('Đơn r1');
    // u_sales1 follows r1 (P39): the same single change is also a followed change.
    await flushFollowed(r1);
    const followedToo = (await since('u_sales1', before)).inApp.filter(
      (item) => item.type === 'record.followed_changed',
    );
    expect(followedToo.map((item) => item.data)).toEqual([
      { field_ids: [reviewers], change_count: 1, actor_ids: [U('u_editor')] },
    ]);
    // Already following r1 by hand (P39): the manual source is kept.
    expect(
      recordFollowSchema.parse((await fx.call('u_sales1', 'GET', followUrl(r1))).json()),
    ).toEqual({ following: true, source: 'manual' });
    // u_reader is assigned too: auto-follow `assigned` on a record it reads.
    await edit('u_editor', r1, { [reviewers]: [{ id: U('u_sales1') }, { id: U('u_reader') }] });
    await flushFollowed(r1);
    expect(
      recordFollowSchema.parse((await fx.call('u_reader', 'GET', followUrl(r1))).json()),
    ).toEqual({ following: true, source: 'assigned' });
    // Nothing about r2 ever reached u_sales1 on Telegram (P42).
    expect((await receivedBy('u_sales1')).telegram.some((text) => text.includes('Đơn r2'))).toBe(
      false,
    );
  });

  it('P41: reminder users [u_sales1, u_reader] — r2: only u_reader (cannot_read_record); due no_perm, r1: only u_reader (cannot_read_field)', async () => {
    const saved = await fx.call('u_admin', 'PATCH', `/fields/${due}`, {
      options: {
        reminder: { recipients: 'users', user_ids: [U('u_sales1'), U('u_reader')] },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    // r2 due three days ago at 09:00 Ho Chi Minh City; the cursor moved back before it.
    const r2Day = daysAgo(3);
    await edit('u_admin', r2, { [due]: r2Day });
    await flushFollowed(r2);
    let sales = await receivedBy('u_sales1');
    let reader = await receivedBy('u_reader');
    await scanRemindersFrom(new Date(`${daysAgo(4)}T00:00:00Z`));
    const r2Due = new Date(`${r2Day}T02:00:00.000Z`).toISOString();
    const forReader = await since('u_reader', reader);
    expect(forReader.inApp).toHaveLength(1);
    expect(forReader.inApp[0]).toMatchObject({
      type: 'date.reminder',
      entity: { type: 'record', id: r2, title: 'Đơn r2' },
      actor: null,
      data: { field_id: due, due_at: r2Due, value: r2Day },
    });
    expect(forReader.emails).toHaveLength(1);
    expect(forReader.telegram).toHaveLength(1);
    expect(forReader.telegram[0]).toContain('Đơn r2');
    expect(await since('u_sales1', sales)).toEqual(nothing);
    expect(fanoutSkips('date.reminder', r2)).toEqual([{ cannot_read_record: 1 }]);

    // Variant: role Sales with `due: no_perm`; r1 (read by u_sales1) comes due.
    await patchSalesOrders((orders) => {
      const rule = orders['field_rule'] as { fields: Record<string, string> };
      return {
        ...orders,
        field_rule: { ...rule, fields: { ...rule.fields, [due]: 'no_perm' } },
      };
    });
    const r1Day = daysAgo(2);
    await edit('u_admin', r1, { [due]: r1Day });
    // Its followers are told about the change of `due` first (u_sales1 cannot read it).
    await flushFollowed(r1);
    sales = await receivedBy('u_sales1');
    reader = await receivedBy('u_reader');
    await scanRemindersFrom(new Date(`${daysAgo(3)}T03:00:00Z`));
    const readerR1 = await since('u_reader', reader);
    expect(readerR1.inApp.map((item) => [item.type, item.entity.id])).toEqual([
      ['date.reminder', r1],
    ]);
    expect(readerR1.telegram).toHaveLength(1);
    expect(await since('u_sales1', sales)).toEqual(nothing);
    expect(fanoutSkips('date.reminder', r1)).toEqual([{ cannot_read_field: 1 }]);
    // Each value is reminded once: the same window scanned again adds nothing.
    reader = await receivedBy('u_reader');
    await scanRemindersFrom(new Date(`${daysAgo(4)}T00:00:00Z`));
    expect(await since('u_reader', reader)).toEqual(nothing);

    await patchSalesOrders((orders) => {
      const rule = orders['field_rule'] as { fields: Record<string, string> };
      const fields = Object.fromEntries(
        Object.entries(rule.fields).filter(([fieldId]) => fieldId !== due),
      );
      return { ...orders, field_rule: { ...rule, fields } };
    });
  });

  it('P42: only …/me/channels; PATCH notification-channels 403 (other org 404); no Telegram about r2', async () => {
    // A member sees their own channel only; no route reaches another member's.
    const mine = await fx.call('u_sales1', 'GET', org('/me/channels'));
    expect(mine.statusCode, mine.body).toBe(200);
    expect(userChannelListSchema.parse(mine.json())).toEqual({
      items: [
        {
          kind: 'telegram',
          status: 'linked',
          error_reason: null,
          linked_at: expect.any(String) as unknown,
          bot_username: BOT_USERNAME,
        },
      ],
      available_kinds: ['telegram'],
    });
    expect(mine.body).not.toContain(String(CHATS.u_sales1));
    for (const [method, path] of [
      ['GET', `/users/${U('u_reader')}/channels`],
      ['DELETE', `/users/${U('u_reader')}/channels/telegram`],
      ['GET', `/members/${U('u_reader')}/channels`],
      ['POST', `/users/${U('u_reader')}/channels/telegram`],
    ] as const) {
      expectProblem(await fx.call('u_sales1', method, org(path)), 404, 'NOT_FOUND');
    }
    // The organization's bot: owner/admin only.
    for (const user of ['u_sales1', 'u_editor', 'u_admin', 'u_reader'] as const) {
      expectProblem(
        await fx.call(user, 'PATCH', org('/notification-channels'), { telegram_secret_id: null }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await fx.call(user, 'GET', org('/notification-channels')),
        403,
        'PERMISSION_DENIED',
      );
    }
    expectProblem(
      await fx.call('stranger', 'PATCH', org('/notification-channels'), {
        telegram_secret_id: null,
      }),
      404,
      'NOT_FOUND',
    );
    const kept = await fx.call('owner', 'GET', org('/notification-channels'));
    expect(orgNotificationChannelsSchema.parse(kept.json()).telegram.bot_username).toBe(
      BOT_USERNAME,
    );

    // A notification about r2 for both: u_reader gets it on Telegram, u_sales1 nothing.
    const sales = await receivedBy('u_sales1');
    const reader = await receivedBy('u_reader');
    await edit('u_editor', r2, { [reviewers]: [{ id: U('u_sales1') }, { id: U('u_reader') }] });
    await flushFollowed(r2);
    expect(await since('u_sales1', sales)).toEqual(nothing);
    const readerGot = await since('u_reader', reader);
    expect(readerGot.telegram).toHaveLength(1);
    expect(readerGot.telegram[0]).toContain('Đơn r2');
    // Over the whole matrix, no Telegram message to u_sales1 ever named r2.
    expect((await receivedBy('u_sales1')).telegram.join('\n')).not.toContain('Đơn r2');

    // Unlinking is the caller's own: u_reader's channel survives u_sales1's DELETE.
    const unlinked = await fx.call('u_sales1', 'DELETE', org('/me/channels/telegram'));
    expect(unlinked.statusCode, unlinked.body).toBe(204);
    expect(
      userChannelListSchema.parse((await fx.call('u_reader', 'GET', org('/me/channels'))).json())
        .items[0]?.status,
    ).toBe('linked');
    expect(
      userChannelListSchema.parse((await fx.call('u_sales1', 'GET', org('/me/channels'))).json())
        .items,
    ).toEqual([]);
  });

  it('P43: u_sales1 duplicating what reaches cost or Customers → 422, nothing created; u_editor → 403', async () => {
    // Fixture variant of P29/P32/P33: Sales `manage`s Orders.
    await patchSalesOrders((orders) => ({ ...orders, perm: 'manage' }));
    const saved = roleSchema.parse(
      (await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles/${salesRole}`)).json(),
    ).config.tables as Record<string, { perm: string }>;
    expect(saved[fx.orders.id]?.perm).toBe('manage');
    const create = async (actions: JsonObject[]): Promise<AutomationDto> => {
      const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'P43',
        enabled: false,
        definition: {
          trigger: { type: 'record.created', table_id: fx.orders.id, skip_bulk: false },
          condition: null,
          actions,
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      return automationSchema.parse(response.json());
    };
    const usesCost = await create([
      {
        id: 'act_cost',
        type: 'update_record',
        config: {
          table_id: fx.orders.id,
          record_id: null,
          fields: { [F('cost')]: { literal: 1 } },
        },
      },
    ]);
    const usesCustomers = await create([
      {
        id: 'act_customer',
        type: 'create_record',
        config: { table_id: fx.customers.id, fields: {} },
      },
    ]);
    const count = async () =>
      (await sql<{ n: number }>`SELECT count(*)::int AS n FROM meta.automations`.execute(db.kysely))
        .rows[0]?.n;
    const before = await count();

    const cost = await fx.call('u_sales1', 'POST', `/automations/${usesCost.id}/duplicate`);
    expectProblem(cost, 422, 'AUTOMATION_INVALID');
    expect(JSON.parse(cost.body)).toMatchObject({
      errors: [
        expect.objectContaining({
          path: `definition.actions[0].config.fields.${F('cost')}`,
          code: 'UNKNOWN_FIELD',
        }),
      ],
    });
    const customers = await fx.call(
      'u_sales1',
      'POST',
      `/automations/${usesCustomers.id}/duplicate`,
    );
    expectProblem(customers, 422, 'AUTOMATION_INVALID');
    expect(JSON.parse(customers.body)).toMatchObject({
      errors: [
        expect.objectContaining({
          path: 'definition.actions[0].config.table_id',
          code: 'UNKNOWN_TABLE',
        }),
      ],
    });
    for (const id of [usesCost.id, usesCustomers.id]) {
      expectProblem(
        await fx.call('u_editor', 'POST', `/automations/${id}/duplicate`),
        403,
        'PERMISSION_DENIED',
      );
    }
    expect(await count()).toBe(before);
    // The run_as of the sources is untouched.
    const source = automationSchema.parse(
      (await fx.call('u_admin', 'GET', `/automations/${usesCost.id}`)).json(),
    );
    expect(source.run_as.id).toBe(U('u_admin'));
  });
});
