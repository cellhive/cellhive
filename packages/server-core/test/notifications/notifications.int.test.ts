import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgScope, OrgMembersRepository, type Db, type OrgScope } from '../../src/db/index.js';
import { purgeExpiredNotifications } from '../../src/db/index.js';
import {
  NotificationBaseMutesRepository,
  NotificationDeliveriesRepository,
  NotificationFanout,
  NotificationPreferencesRepository,
  NotificationSettingsRepository,
  NotificationsRepository,
  NotificationWriter,
  type PreparedNotification,
} from '../../src/notifications/index.js';
import { attachRealtimePublisher, type RealtimeEnvelope } from '../../src/realtime/index.js';
import { RecordQueryService } from '../../src/records/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_NotifRepoOrgA001';
const ORG_B = 'org_NotifRepoOrgB001';
const MEMBER: Id<'usr'> = 'usr_NotifMemberA0001';
const GONE: Id<'usr'> = 'usr_NotifNotMember01';
const AUT: Id<'aut'> = 'aut_NotifRepoAuto001';

describe('notifications (T511, server-core)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  let scopeA: OrgScope;
  let scopeB: OrgScope;
  const published: RealtimeEnvelope[] = [];
  const notifications = () => new NotificationsRepository(db);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    const members = new OrgMembersRepository(db);
    await db.kysely
      .insertInto('meta.users')
      .values([
        { id: MEMBER, email: 'notif-member@example.test', display_name: 'Member' },
        { id: GONE, email: 'notif-gone@example.test', display_name: 'Gone' },
      ])
      .execute();
    await members.add(scopeA, a.userId, 'member');
    await members.add(scopeA, MEMBER, 'member');
    await members.add(scopeB, b.userId, 'member');
    // The user of A is also a member of B: rows of one organization never show in the other.
    await members.add(scopeB, a.userId, 'member');
    attachRealtimePublisher(db, {
      publish: (envelope) => {
        published.push(envelope);
        return Promise.resolve();
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  const item = (
    userId: Id<'usr'>,
    overrides: Partial<PreparedNotification> = {},
  ): PreparedNotification => ({
    userId,
    type: 'automation.message',
    baseId: a.baseId,
    tableId: null,
    entityType: 'automation',
    entityId: AUT,
    actor: null,
    groupKey: null,
    data: {
      automation_id: AUT,
      run_id: 'run_NotifRepoRun0001',
      title: 'Hello',
      body: 'World',
    },
    ...overrides,
  });

  it('writes per recipient choices, queues emails, announces in-app after commit only', async () => {
    const writer = new NotificationWriter(db, { emailEnabled: true });
    published.length = 0;
    const written = await db.withTx((tx) => writer.write(tx, ORG_A, [item(a.userId)]));
    expect(written).toEqual([
      {
        userId: a.userId,
        id: expect.stringMatching(/^ntf_/) as unknown,
        inApp: true,
        emailQueued: true,
        // No notification bot in this organization (T550).
        telegramQueued: false,
      },
    ]);
    expect(published).toEqual([
      expect.objectContaining({
        type: 'notification.created',
        organization_id: ORG_A,
        user_id: a.userId,
        notification_id: written[0]?.id,
        notification_type: 'automation.message',
        base_id: a.baseId,
      }),
    ]);

    // Rollback: nothing recorded, nothing announced.
    published.length = 0;
    const rollback = new Error('rollback');
    await expect(
      db.withTx(async (tx) => {
        await writer.write(tx, ORG_A, [item(a.userId, { groupKey: 'rolled-back' })]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(published).toEqual([]);

    // Preferences: in-app off keeps an email-only row; both off writes nothing.
    await new NotificationPreferencesRepository(db).upsert(scopeA, MEMBER, [
      { type: 'automation.message', channel: 'in_app', enabled: false },
    ]);
    const emailOnly = await db.withTx((tx) => writer.write(tx, ORG_A, [item(MEMBER)]));
    expect(emailOnly[0]).toMatchObject({ inApp: false, emailQueued: true });
    await new NotificationPreferencesRepository(db).upsert(scopeA, MEMBER, [
      { type: 'automation.message', channel: 'email', enabled: false },
    ]);
    const none = await db.withTx((tx) => writer.write(tx, ORG_A, [item(MEMBER)]));
    expect(none).toEqual([
      { userId: MEMBER, id: null, inApp: false, emailQueued: false, telegramQueued: false },
    ]);
    // A mandatory type ignores a stored in-app "off".
    await new NotificationPreferencesRepository(db).upsert(scopeA, MEMBER, [
      { type: 'automation.disabled', channel: 'in_app', enabled: false },
    ]);
    const mandatory = await db.withTx((tx) =>
      writer.write(tx, ORG_A, [
        item(MEMBER, {
          type: 'automation.disabled',
          data: { automation_id: AUT, reason: 'circuit_breaker' },
        }),
      ]),
    );
    expect(mandatory[0]).toMatchObject({ inApp: true, emailQueued: true });

    // Without SMTP no email is ever queued.
    const noSmtp = new NotificationWriter(db, { emailEnabled: false });
    const plain = await db.withTx((tx) => noSmtp.write(tx, ORG_A, [item(a.userId)]));
    expect(plain[0]).toMatchObject({ inApp: true, emailQueued: false });
  });

  it('mutes and email frequency silence email only; never a mandatory type', async () => {
    const writer = new NotificationWriter(db, { emailEnabled: true });
    const mutes = new NotificationBaseMutesRepository(db);
    await mutes.mute(scopeA, a.userId, a.baseId);
    await mutes.mute(scopeA, a.userId, a.baseId);
    expect(await mutes.listBaseIds(scopeA, a.userId)).toEqual([a.baseId]);
    const muted = await db.withTx((tx) =>
      writer.write(tx, ORG_A, [
        item(a.userId),
        item(a.userId, {
          type: 'automation.disabled',
          data: { automation_id: AUT, reason: 'circuit_breaker' },
        }),
      ]),
    );
    expect(muted.map((row) => [row.inApp, row.emailQueued])).toEqual([
      [true, false],
      [true, true],
    ]);
    expect(await mutes.unmute(scopeA, a.userId, a.baseId)).toBe(true);
    expect(await mutes.unmute(scopeA, a.userId, a.baseId)).toBe(false);

    const settings = new NotificationSettingsRepository(db);
    await settings.upsert(scopeA, a.userId, { emailFrequency: 'off', dailyHour: 8 });
    const off = await db.withTx((tx) => writer.write(tx, ORG_A, [item(a.userId)]));
    expect(off[0]).toMatchObject({ inApp: true, emailQueued: false });
    await settings.upsert(scopeA, a.userId, { emailFrequency: 'daily', dailyHour: 6 });
    expect(await settings.listForUsers(scopeA, [a.userId])).toEqual([
      {
        user_id: a.userId,
        email_frequency: 'daily',
        daily_hour: 6,
        // T543: the auto-follow switches, kept at their defaults.
        auto_follow_created: true,
        auto_follow_assigned: true,
      },
    ]);
  });

  it('a group_key is recorded once per user and type', async () => {
    const writer = new NotificationWriter(db, { emailEnabled: false });
    const first = await db.withTx((tx) =>
      writer.write(tx, ORG_A, [item(a.userId, { groupKey: 'once' })]),
    );
    const second = await db.withTx((tx) =>
      writer.write(tx, ORG_A, [item(a.userId, { groupKey: 'once' })]),
    );
    expect(first[0]?.id).not.toBeNull();
    expect(second[0]?.id).toBeNull();
  });

  it('isolates every repository by organization', async () => {
    const writer = new NotificationWriter(db, { emailEnabled: true });
    const [inA] = await db.withTx((tx) => writer.write(tx, ORG_A, [item(a.userId)]));
    const id = inA?.id as Id<'ntf'>;
    const repo = notifications();
    const page = { cursor: null, limit: 50 };
    expect((await repo.list(scopeA, { userId: a.userId }, page)).items.map((r) => r.id)).toContain(
      id,
    );
    expect((await repo.list(scopeB, { userId: a.userId }, page)).items).toEqual([]);
    expect(await repo.countUnread(scopeB, a.userId, 1000)).toBe(0);
    expect(await repo.markRead(scopeB, a.userId, { ids: [id] }, new Date())).toBe(0);
    expect(await repo.markRead(scopeB, a.userId, { all: true }, new Date())).toBe(0);
    expect(await repo.deleteByEntity(scopeB, 'automation', [AUT])).toBe(0);
    expect(
      await new NotificationDeliveriesRepository(db).listByNotifications(scopeB, [id]),
    ).toEqual([]);
    expect(
      (await new NotificationDeliveriesRepository(db).listByNotifications(scopeA, [id])).map(
        (row) => row.status,
      ),
    ).toEqual(['pending']);

    await new NotificationPreferencesRepository(db).upsert(scopeA, a.userId, [
      { type: 'automation.message', channel: 'email', enabled: false },
    ]);
    expect(
      await new NotificationPreferencesRepository(db).listForUsers(scopeB, [a.userId]),
    ).toEqual([]);
    expect(await new NotificationSettingsRepository(db).listForUsers(scopeB, [a.userId])).toEqual(
      [],
    );
    await new NotificationBaseMutesRepository(db).mute(scopeA, a.userId, a.baseId);
    expect(await new NotificationBaseMutesRepository(db).listBaseIds(scopeB, a.userId)).toEqual([]);
    expect(
      await new NotificationBaseMutesRepository(db).mutedUsers(scopeB, a.baseId, [a.userId]),
    ).toEqual(new Set());
    expect(await new NotificationBaseMutesRepository(db).unmute(scopeB, a.userId, a.baseId)).toBe(
      false,
    );
    // A base of another organization cannot be referenced (composite FK).
    await expect(
      new NotificationBaseMutesRepository(db).mute(scopeB, a.userId, a.baseId),
    ).rejects.toThrow();
    await new NotificationBaseMutesRepository(db).unmute(scopeA, a.userId, a.baseId);

    // Marking read in the right organization works, once.
    expect(await repo.markRead(scopeA, a.userId, { ids: [id] }, new Date())).toBe(1);
    expect(await repo.markRead(scopeA, a.userId, { ids: [id] }, new Date())).toBe(0);
  });

  it('fan-out: base admins, members without access left out, non-members left out', async () => {
    const fanout = new NotificationFanout(db, new RecordQueryService(db), {
      emailEnabled: false,
      defaults: { timeZone: 'UTC', locale: 'en' },
    });
    const result = await fanout.run({
      organization_id: ORG_A,
      type: 'automation.disabled',
      base_id: a.baseId,
      table_id: null,
      entity_type: 'automation',
      entity_id: AUT,
      actor: null,
      group_key: 'fanout-1',
      // MEMBER has no access to the base; GONE is not a member at all.
      recipients: { user_ids: [MEMBER, GONE], base_admins: true },
      requires: { record_id: null, field_ids: [] },
      skip_actor: true,
      data: { automation_id: AUT, reason: 'circuit_breaker' },
    });
    // The seeded user owns the base: an admin.
    expect(result.written.map((row) => row.userId)).toEqual([a.userId]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { userId: MEMBER, reason: 'cannot_read_base' },
        { userId: GONE, reason: 'cannot_read_base' },
      ]),
    );

    // The user behind the change is left out unless skip_actor is false.
    const skipActor = await fanout.run({
      organization_id: ORG_A,
      type: 'automation.message',
      base_id: a.baseId,
      table_id: null,
      entity_type: 'automation',
      entity_id: AUT,
      actor: { type: 'user', id: a.userId },
      group_key: 'fanout-2',
      recipients: { user_ids: [a.userId], base_admins: false },
      requires: { record_id: null, field_ids: [] },
      skip_actor: true,
      data: { automation_id: AUT, run_id: 'run_NotifRepoRun0001', title: 'x', body: '' },
    });
    expect(skipActor).toEqual({ written: [], skipped: [{ userId: a.userId, reason: 'actor' }] });

    // Without a base: membership only.
    const orgLevel = await fanout.run({
      organization_id: ORG_A,
      type: 'automation.message',
      base_id: null,
      table_id: null,
      entity_type: 'automation',
      entity_id: AUT,
      actor: null,
      group_key: 'fanout-3',
      recipients: { user_ids: [MEMBER, GONE, b.userId], base_admins: false },
      requires: { record_id: null, field_ids: [] },
      skip_actor: false,
      data: { automation_id: AUT, run_id: 'run_NotifRepoRun0001', title: 'x', body: '' },
    });
    expect(orgLevel.written.map((row) => row.userId)).toEqual([MEMBER]);
    expect(orgLevel.skipped.map((row) => row.reason)).toEqual(['not_member', 'not_member']);
  });

  it('purges notifications past the retention, in every organization, with their deliveries', async () => {
    const writer = new NotificationWriter(db, { emailEnabled: true });
    const [oldA] = await db.withTx((tx) => writer.write(tx, ORG_A, [item(a.userId)]));
    const [oldB] = await db.withTx((tx) =>
      writer.write(tx, ORG_B, [item(b.userId, { baseId: b.baseId })]),
    );
    const [fresh] = await db.withTx((tx) => writer.write(tx, ORG_A, [item(a.userId)]));
    await db.kysely
      .updateTable('meta.notifications')
      .set({ created_at: new Date('2026-01-01T00:00:00.000Z') } as never)
      .where('id', 'in', [oldA?.id as Id<'ntf'>, oldB?.id as Id<'ntf'>])
      .execute();
    const deleted = await purgeExpiredNotifications(db, {
      now: new Date('2026-06-01T00:00:00.000Z'),
      retentionDays: 90,
      batchSize: 1,
    });
    expect(deleted).toBeGreaterThanOrEqual(2);
    const left = await db.kysely
      .selectFrom('meta.notifications')
      .select('id')
      .where('id', 'in', [oldA?.id as Id<'ntf'>, oldB?.id as Id<'ntf'>, fresh?.id as Id<'ntf'>])
      .execute();
    expect(left.map((row) => row.id)).toEqual([fresh?.id]);
    const orphans = await db.kysely
      .selectFrom('meta.notification_deliveries')
      .select('notification_id')
      .where('notification_id', 'in', [oldA?.id as Id<'ntf'>, oldB?.id as Id<'ntf'>])
      .execute();
    expect(orphans).toEqual([]);
    await expect(
      purgeExpiredNotifications(db, { now: new Date(), retentionDays: 0 }),
    ).rejects.toThrow(RangeError);
  });
});
