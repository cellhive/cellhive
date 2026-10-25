import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  markNotificationsReadResultSchema,
  notificationListSchema,
  notificationPreferencesSchema,
  notificationSettingsSchema,
  notificationUnreadCountSchema,
  recordsResponseSchema,
  type Id,
  type NotificationDto,
  type RealtimeServerMessage,
} from '@cellhive/contracts';
import {
  AutomationsRepository,
  enqueueNotification,
  notifyAutomationDisabled,
  orgScope,
  type Db,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const AUT: Id<'aut'> = 'aut_NotifAutomation1';
const RUN: Id<'run'> = 'run_NotifRun00000001';

/**
 * T511: notification infrastructure through the real API and worker
 * (CONTRACTS §7, §22; ADR-29 §1, ADR-32 §1): fan-out with a per-recipient
 * access check at send time, realtime `notification.created` on `user:`,
 * list/read/unread count, preferences (mandatory types), email settings,
 * base mutes, permissions (404 for non-members) and tenant isolation.
 */
describe('notifications (T511)', () => {
  let database: TestDatabase;
  let db: Db;
  let smtp: SmtpCapture;
  let t: TestApp;
  let url: string;
  let worker: WorkerHandle;
  let fx: RecordFixture;
  let r1: Id<'rec'>;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    smtp = await startSmtpCapture();
    // SMTP configured: notifications queue emails (sent by T512).
    t = await startTestApp({
      DATABASE_URL: database.url,
      SMTP_URL: smtp.url,
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
      SMTP_ALLOW_INSECURE: 'true',
    });
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 100 });
    const created = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: [
          {
            fields: {
              [F('title')]: 'Đơn R1',
              [F('cost')]: 60,
              [F('owner')]: [{ id: fx.users.u_sales1.id }],
            },
          },
        ],
      },
    );
    expect(created.statusCode, created.body).toBe(201);
    [r1] = recordsResponseSchema.parse(created.json()).records.map((r) => r.id) as [Id<'rec'>];
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await worker.close();
    await t.close();
    await smtp.close();
    await db.destroy();
    await database.drop();
  });

  function F(name: string): Id<'fld'> {
    const field = fx.fld[name];
    if (field === undefined) throw new Error(`no field ${name}`);
    return field.id;
  }

  const me = (path = '') => `/orgs/${fx.orgId}/me${path}`;

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

  const created =
    (type?: string) =>
    (message: RealtimeServerMessage): boolean =>
      message.type === 'notification.created' &&
      (type === undefined || message.notification_type === type);

  async function list(user: FixtureUser, query = ''): Promise<NotificationDto[]> {
    const response = await fx.call(user, 'GET', me(`/notifications${query}`));
    expect(response.statusCode, response.body).toBe(200);
    return notificationListSchema.parse(response.json()).items;
  }

  async function unread(user: FixtureUser): Promise<number> {
    const response = await fx.call(user, 'GET', me('/notifications/unread-count'));
    expect(response.statusCode, response.body).toBe(200);
    return notificationUnreadCountSchema.parse(response.json()).count;
  }

  async function deliveries(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await db.kysely
      .selectFrom('meta.notification_deliveries')
      .select('notification_id')
      .where('notification_id', 'in', ids as Id<'ntf'>[])
      .execute();
    return rows.map((row) => row.notification_id);
  }

  async function message(
    userIds: readonly FixtureUser[],
    extra: { recordId?: Id<'rec'>; fieldIds?: Id<'fld'>[]; groupKey?: string } = {},
  ): Promise<void> {
    await db.withTx((tx) =>
      enqueueNotification(tx, {
        organizationId: fx.orgId,
        type: 'automation.message',
        baseId: fx.baseId,
        tableId: fx.orders.id,
        entityType: 'record',
        entityId: extra.recordId ?? r1,
        ...(extra.recordId === undefined ? { recordId: r1 } : { recordId: extra.recordId }),
        ...(extra.fieldIds === undefined ? {} : { fieldIds: extra.fieldIds }),
        ...(extra.groupKey === undefined ? {} : { groupKey: extra.groupKey }),
        userIds: userIds.map((user) => fx.users[user].id),
        data: { automation_id: AUT, run_id: RUN, title: 'Đơn cần duyệt', body: 'Xem đơn R1' },
      }),
    );
  }

  it('a disabled automation reaches its run_as user and every base admin in realtime (p95 < 1 s), nobody else', async () => {
    const owner = await own('owner');
    const admin = await own('u_admin');
    const runAs = await own('u_editor');
    const reader = await own('u_reader');
    const outsider = await own('u_out');
    const samples: number[] = [];
    for (let round = 0; round < 10; round += 1) {
      const started = performance.now();
      await db.withTx((tx) =>
        notifyAutomationDisabled(tx, {
          organizationId: fx.orgId,
          baseId: fx.baseId,
          automationId: AUT,
          runAsUserId: fx.users.u_editor.id,
          reason: 'circuit_breaker',
          groupKey: `breaker:${String(round)}`,
        }),
      );
      const [first] = await Promise.all([
        owner.next(created('automation.disabled')),
        admin.next(created('automation.disabled')),
        runAs.next(created('automation.disabled')),
      ]);
      samples.push(performance.now() - started);
      expect(first).toMatchObject({
        organization_id: fx.orgId,
        base_id: fx.baseId,
        channel: `user:${fx.users.owner.id}`,
      });
    }
    await reader.expectNone(created());
    await outsider.expectNone(created());
    samples.sort((x, y) => x - y);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? 0;
    const load = loadavg()[0] ?? 0;
    process.stdout.write(
      `T511 breaker → notification.created: p50 ${samples[5]?.toFixed(1) ?? '?'} ms, p95 ${p95.toFixed(1)} ms (load ${load.toFixed(2)})\n`,
    );
    // Latency is only meaningful on an idle machine (BACKLOG S5 conventions).
    if (load < 8) expect(p95).toBeLessThan(1_000);

    const items = await list('u_admin');
    expect(items).toHaveLength(10);
    expect(items[0]).toMatchObject({
      type: 'automation.disabled',
      base: { id: fx.baseId, name: 'B' },
      table_id: null,
      entity: { type: 'automation', id: AUT, title: null },
      actor: null,
      data: { automation_id: AUT, reason: 'circuit_breaker' },
      read_at: null,
    });
    expect(await list('u_reader')).toEqual([]);
    expect(await list('u_out')).toEqual([]);
  });

  it('names an automation the reader can see (T502 title source)', async () => {
    const automation = await new AutomationsRepository(db).insert(orgScope(fx.orgId), {
      id: 'aut_NotifNamedAuto01',
      baseId: fx.baseId,
      name: 'Nhắc đơn quá hạn',
      description: '',
      enabled: false,
      definition: {},
      triggerType: 'record.created',
      triggerTableId: fx.orders.id,
      createdBy: fx.users.u_admin.id,
    });
    const admin = await own('u_admin');
    await db.withTx((tx) =>
      notifyAutomationDisabled(tx, {
        organizationId: fx.orgId,
        baseId: fx.baseId,
        automationId: automation.id,
        runAsUserId: null,
        reason: 'circuit_breaker',
        groupKey: 'named',
      }),
    );
    await admin.next(created('automation.disabled'));
    const [item] = await list('u_admin');
    expect(item?.entity).toEqual({
      type: 'automation',
      id: automation.id,
      title: 'Nhắc đơn quá hạn',
    });
  });

  it('a run_as user who lost access to the base is not notified', async () => {
    const outsider = await own('u_out');
    const admin = await own('u_admin');
    await db.withTx((tx) =>
      notifyAutomationDisabled(tx, {
        organizationId: fx.orgId,
        baseId: fx.baseId,
        automationId: AUT,
        runAsUserId: fx.users.u_out.id,
        reason: 'run_as_lost_access',
        groupKey: 'lost-access',
      }),
    );
    // The admins still get it; the former run_as user gets nothing.
    await admin.next(created('automation.disabled'));
    await outsider.expectNone(created());
    expect(await list('u_out')).toEqual([]);
  });

  it('a producer retry with the same group_key records nothing twice', async () => {
    const before = (await list('owner', '?limit=200')).length;
    const owner = await own('owner');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await db.withTx((tx) =>
        notifyAutomationDisabled(tx, {
          organizationId: fx.orgId,
          baseId: fx.baseId,
          automationId: AUT,
          runAsUserId: null,
          reason: 'circuit_breaker',
          groupKey: 'retried',
        }),
      );
    }
    await owner.next(created('automation.disabled'));
    await owner.expectNone(created(), 1_000);
    expect((await list('owner', '?limit=200')).length).toBe(before + 1);
  });

  it('checks each recipient when sending: the record, then every field the content uses', async () => {
    const sales1 = await own('u_sales1');
    const sales2 = await own('u_sales2');
    const reader = await own('u_reader');
    const outsider = await own('u_out');
    await message(['u_sales1', 'u_sales2', 'u_reader', 'u_out'], { groupKey: 'record-check' });
    await sales1.next(created('automation.message'));
    await reader.next(created('automation.message'));
    // u_sales2 reads only their own orders; u_out cannot open the base.
    await sales2.expectNone(created());
    await outsider.expectNone(created());

    const [item] = await list('u_sales1');
    expect(item).toMatchObject({
      type: 'automation.message',
      table_id: fx.orders.id,
      entity: { type: 'record', id: r1, title: 'Đơn R1' },
      data: { title: 'Đơn cần duyệt', body: 'Xem đơn R1', automation_id: AUT, run_id: RUN },
    });

    // `cost` is no_perm for the Sales role: content naming it skips them.
    await message(['u_sales1', 'u_reader'], { fieldIds: [F('cost')], groupKey: 'field-check' });
    await reader.next(created('automation.message'));
    await sales1.expectNone(created());
  });

  it('keeps an item whose record became unreadable, without its title', async () => {
    const response = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ id: r1, fields: { [F('owner')]: [{ id: fx.users.u_sales2.id }] } }] },
    );
    expect(response.statusCode, response.body).toBe(200);
    const [item] = await list('u_sales1');
    expect(item).toMatchObject({ entity: { type: 'record', id: r1, title: null } });
    expect(item?.data).toMatchObject({ title: 'Đơn cần duyệt' });
    const readerItems = await list('u_reader');
    expect(readerItems[0]?.entity.title).toBe('Đơn R1');
    // Back to u_sales1 for the next tests.
    await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records?field_key_type=id`, {
      records: [{ id: r1, fields: { [F('owner')]: [{ id: fx.users.u_sales1.id }] } }],
    });
  });

  it('marks read by id (others ignored) or all, with unread count, filters and cursor', async () => {
    const mine = await list('u_admin');
    expect(mine.length).toBeGreaterThanOrEqual(10);
    expect(await unread('u_admin')).toBe(mine.length);
    const ownerItems = await list('owner');
    const first = mine[0] as NotificationDto;

    const byId = await fx.call('u_admin', 'POST', me('/notifications/read'), {
      ids: [first.id, (ownerItems[0] as NotificationDto).id],
    });
    expect(byId.statusCode, byId.body).toBe(200);
    expect(markNotificationsReadResultSchema.parse(byId.json())).toEqual({ updated: 1 });
    expect(await unread('u_admin')).toBe(mine.length - 1);
    // Someone else's id was not touched.
    expect((await list('owner', '?unread=true')).map((item) => item.id)).toContain(
      (ownerItems[0] as NotificationDto).id,
    );
    expect((await list('u_admin', '?unread=true')).map((item) => item.id)).not.toContain(first.id);

    // Cursor pages, newest first, no overlap.
    const page1 = await fx.call('u_admin', 'GET', me('/notifications?limit=4'));
    const parsed1 = notificationListSchema.parse(page1.json());
    expect(parsed1.items).toHaveLength(4);
    expect(parsed1.next_cursor).not.toBeNull();
    const page2 = notificationListSchema.parse(
      (
        await fx.call(
          'u_admin',
          'GET',
          me(`/notifications?limit=4&cursor=${parsed1.next_cursor ?? ''}`),
        )
      ).json(),
    );
    expect(page2.items.map((item) => item.id)).toEqual(mine.slice(4, 8).map((item) => item.id));
    expectProblem(
      await fx.call('u_admin', 'GET', me('/notifications?cursor=not-a-cursor')),
      422,
      'VALIDATION_FAILED',
    );
    expect(await list('u_admin', `?base_id=${fx.baseId}`)).toHaveLength(mine.length);

    const all = await fx.call('u_admin', 'POST', me('/notifications/read'), { all: true });
    expect(markNotificationsReadResultSchema.parse(all.json())).toEqual({
      updated: mine.length - 1,
    });
    expect(await unread('u_admin')).toBe(0);
    expect(await list('u_admin', '?unread=true')).toEqual([]);
    expectProblem(
      await fx.call('u_admin', 'POST', me('/notifications/read'), { ids: [] }),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('preferences: defaults, change, and mandatory in-app cannot be turned off (422)', async () => {
    const initial = notificationPreferencesSchema.parse(
      (await fx.call('u_reader', 'GET', me('/notification-preferences'))).json(),
    );
    expect(initial.items).toContainEqual({
      type: 'automation.disabled',
      channel: 'in_app',
      enabled: true,
      locked: true,
    });
    expect(initial.items).toContainEqual({
      type: 'automation.message',
      channel: 'email',
      enabled: true,
      locked: false,
    });

    const locked = await fx.call('u_reader', 'PUT', me('/notification-preferences'), {
      items: [{ type: 'automation.disabled', channel: 'in_app', enabled: false }],
    });
    expectProblem(locked, 422, 'VALIDATION_FAILED');
    expect(JSON.parse(locked.body)).toMatchObject({
      errors: [{ path: 'items.0.enabled', code: 'NOT_ALLOWED' }],
    });

    const changed = await fx.call('u_reader', 'PUT', me('/notification-preferences'), {
      items: [
        { type: 'automation.message', channel: 'in_app', enabled: false },
        { type: 'automation.disabled', channel: 'email', enabled: false },
      ],
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const after = notificationPreferencesSchema.parse(changed.json());
    expect(after.items).toContainEqual({
      type: 'automation.message',
      channel: 'in_app',
      enabled: false,
      locked: false,
    });

    // In-app off, email on: the row exists for email only, never listed or announced.
    const reader = await own('u_reader');
    const before = await list('u_reader', '?limit=200');
    await message(['u_reader'], { groupKey: 'in-app-off' });
    const row = await waitForRow('u_reader', 'in-app-off');
    expect(row.in_app).toBe(false);
    expect(await deliveries([row.id])).toEqual([row.id]);
    await reader.expectNone(created());
    expect(await list('u_reader', '?limit=200')).toHaveLength(before.length);
    await fx.call('u_reader', 'PUT', me('/notification-preferences'), {
      items: [{ type: 'automation.message', channel: 'in_app', enabled: true }],
    });
  });

  async function waitForRow(user: FixtureUser, groupKey: string) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const row = await db.kysely
        .selectFrom('meta.notifications')
        .select(['id', 'in_app'])
        .where('user_id', '=', fx.users[user].id)
        .where('group_key', '=', groupKey)
        .executeTakeFirst();
      if (row !== undefined) return row;
      if (Date.now() > deadline) throw new Error(`no notification ${groupKey} for ${user}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('settings: email frequency and digest hour, validated', async () => {
    const initial = notificationSettingsSchema.parse(
      (await fx.call('u_editor', 'GET', me('/notification-settings'))).json(),
    );
    expect(initial).toEqual({
      email_frequency: 'immediate',
      daily_hour: 8,
      muted_bases: [],
      // T543: the auto-follow switches, on by default.
      auto_follow_created: true,
      auto_follow_assigned: true,
    });
    const daily = await fx.call('u_editor', 'PUT', me('/notification-settings'), {
      email_frequency: 'daily',
      daily_hour: 7,
    });
    expect(daily.statusCode, daily.body).toBe(200);
    expect(notificationSettingsSchema.parse(daily.json())).toMatchObject({
      email_frequency: 'daily',
      daily_hour: 7,
    });
    const hourOnly = await fx.call('u_editor', 'PUT', me('/notification-settings'), {
      daily_hour: 9,
    });
    expect(notificationSettingsSchema.parse(hourOnly.json())).toMatchObject({
      email_frequency: 'daily',
      daily_hour: 9,
    });
    for (const body of [{}, { daily_hour: 24 }, { email_frequency: 'weekly' }, { extra: 1 }]) {
      expectProblem(
        await fx.call('u_editor', 'PUT', me('/notification-settings'), body),
        422,
        'VALIDATION_FAILED',
      );
    }
  });

  it('email frequency off: in-app only', async () => {
    await fx.call('u_sales1', 'PUT', me('/notification-settings'), { email_frequency: 'off' });
    await message(['u_sales1'], { groupKey: 'frequency-off' });
    const row = await waitForRow('u_sales1', 'frequency-off');
    expect(row.in_app).toBe(true);
    expect(await deliveries([row.id])).toEqual([]);
    await fx.call('u_sales1', 'PUT', me('/notification-settings'), {
      email_frequency: 'immediate',
    });
  });

  it('muting a base: no email queued but in-app kept; mandatory types still emailed', async () => {
    expectProblem(
      await fx.call('u_out', 'PUT', me(`/notification-mutes/bases/${fx.baseId}`)),
      404,
      'NOT_FOUND',
    );
    for (const user of ['u_sales1', 'owner'] as const) {
      const mute = await fx.call(user, 'PUT', me(`/notification-mutes/bases/${fx.baseId}`));
      expect(mute.statusCode, mute.body).toBe(204);
      // Idempotent.
      expect(
        (await fx.call(user, 'PUT', me(`/notification-mutes/bases/${fx.baseId}`))).statusCode,
      ).toBe(204);
    }
    expect(
      notificationSettingsSchema.parse(
        (await fx.call('u_sales1', 'GET', me('/notification-settings'))).json(),
      ).muted_bases,
    ).toEqual([{ id: fx.baseId, name: 'B' }]);

    await message(['u_sales1'], { groupKey: 'muted' });
    const muted = await waitForRow('u_sales1', 'muted');
    expect(muted.in_app).toBe(true);
    expect(await deliveries([muted.id])).toEqual([]);

    await db.withTx((tx) =>
      notifyAutomationDisabled(tx, {
        organizationId: fx.orgId,
        baseId: fx.baseId,
        automationId: AUT,
        runAsUserId: null,
        reason: 'circuit_breaker',
        groupKey: 'muted-mandatory',
      }),
    );
    const mandatory = await waitForRow('owner', 'muted-mandatory');
    expect(await deliveries([mandatory.id])).toEqual([mandatory.id]);

    const unmute = await fx.call(
      'u_sales1',
      'DELETE',
      me(`/notification-mutes/bases/${fx.baseId}`),
    );
    expect(unmute.statusCode, unmute.body).toBe(204);
    expect(
      (await fx.call('u_sales1', 'DELETE', me(`/notification-mutes/bases/${fx.baseId}`)))
        .statusCode,
    ).toBe(204);
    await message(['u_sales1'], { groupKey: 'unmuted' });
    const unmuted = await waitForRow('u_sales1', 'unmuted');
    expect(await deliveries([unmuted.id])).toEqual([unmuted.id]);
    await fx.call('owner', 'DELETE', me(`/notification-mutes/bases/${fx.baseId}`));
  });

  it('is per member: other organizations 404, anonymous 401, other users never see an item', async () => {
    for (const [method, path] of [
      ['GET', '/notifications'],
      ['GET', '/notifications/unread-count'],
      ['POST', '/notifications/read'],
      ['GET', '/notification-preferences'],
      ['PUT', '/notification-preferences'],
      ['GET', '/notification-settings'],
      ['PUT', '/notification-settings'],
      ['PUT', `/notification-mutes/bases/${fx.baseId}`],
      ['DELETE', `/notification-mutes/bases/${fx.baseId}`],
    ] as const) {
      const body =
        method === 'POST'
          ? { all: true }
          : path === '/notification-preferences'
            ? { items: [{ type: 'automation.message', channel: 'email', enabled: true }] }
            : path === '/notification-settings'
              ? { daily_hour: 8 }
              : undefined;
      expectProblem(await fx.call('stranger', method, me(path), body), 404, 'NOT_FOUND');
      const anonymous = await t.app.inject({ method, url: `/api/v1${me(path)}` });
      expect(anonymous.statusCode).toBe(401);
    }
    // The stranger's own organization lists nothing of this one.
    const strangerOrg = (
      await db.kysely
        .selectFrom('meta.org_members')
        .select('organization_id')
        .where('user_id', '=', fx.users.stranger.id)
        .executeTakeFirstOrThrow()
    ).organization_id;
    const own = await fx.call('stranger', 'GET', `/orgs/${strangerOrg}/me/notifications`);
    expect(notificationListSchema.parse(own.json()).items).toEqual([]);
    // A base of another organization cannot be muted through this one.
    expectProblem(
      await fx.call(
        'owner',
        'PUT',
        `/orgs/${strangerOrg}/me/notification-mutes/bases/${fx.baseId}`,
      ),
      404,
      'NOT_FOUND',
    );
  });
});
