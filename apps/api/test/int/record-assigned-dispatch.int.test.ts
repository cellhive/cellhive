import {
  notificationListSchema,
  notificationPreferencesSchema,
  recordFollowSchema,
  recordsResponseSchema,
  type Id,
  type NotificationDto,
} from '@cellhive/contracts';
import {
  AutomationDispatcher,
  emit,
  NotificationBuffer,
  NotificationFanout,
  NotificationFlusher,
  orgScope,
  RecordAssignedGrouper,
  RecordAssignedListener,
  RecordQueryService,
  toEventDocument,
  type Db,
  type EventInput,
  type FanoutResult,
  type NotificationFlushOutcome,
  type NotificationsFanoutPayload,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

const DEFAULTS = { timeZone: 'UTC', locale: 'en' };

/** Follow rows in code-unit order (whatever the database collation). */
function byRecordThenUser<T extends { record_id: string; user_id: string }>(rows: T[]): T[] {
  const key = (row: T) => `${row.record_id} ${row.user_id}`;
  return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

interface StoredNotification {
  readonly user_id: string;
  readonly type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly table_id: string | null;
  readonly group_key: string | null;
  readonly actor_type: string | null;
  readonly actor_id: string | null;
  readonly payload: Record<string, unknown>;
}

/**
 * BACKLOG T544 (ADR-29 §1, ADR-34 §2, "Quyết định S5b" #7; CONTRACTS §22.1,
 * §22.2; P40) through the real API, with `events.dispatch`, the fan-out and
 * the flush driven by the test (no worker: every step is observed):
 *
 * - a single write that adds a person to a `user` field with
 *   `notify_on_assign` queues one `record.assigned` per assignee, checked
 *   when it runs (record + at least one of the fields), and the assignee
 *   follows the record (`source = assigned`) when they read it;
 * - bulk writes are buffered per `batch.id` and flushed into one
 *   notification per assignee (`count` = records they read), early once
 *   `batch.size` records are buffered, else 10 s after the first row — an
 *   import 10 s after its last row; a worker stopped in the middle still
 *   gives exactly one notification;
 * - nobody is told about their own assignment, removals or fields without
 *   the flag; recomputed values, deleted fields and former members assign
 *   nobody; automation assignments are notified; the follow switch and
 *   "unfollowing by hand wins" hold; organizations stay apart.
 */
describe('record.assigned: listener, fan-out and flush (T544)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let fxB: RecordFixture;
  let query: RecordQueryService;
  let dispatcher: AutomationDispatcher;
  let fanout: NotificationFanout;
  let flusher: NotificationFlusher;
  let reviewers: Id<'fld'>;
  let helper: Id<'fld'>;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const U = (user: FixtureUser) => fx.users[user].id;
  const me = (path: string, orgId: Id<'org'> = fx.orgId) => `/orgs/${orgId}/me${path}`;

  async function createOrders(
    user: FixtureUser,
    records: readonly Record<string, unknown>[],
    on: RecordFixture = fx,
  ): Promise<Id<'rec'>[]> {
    const response = await on.call(
      user,
      'POST',
      `/tables/${on.orders.id}/records?field_key_type=id`,
      { records: records.map((fields) => ({ fields })) },
    );
    expect(response.statusCode, response.body).toBe(201);
    return recordsResponseSchema.parse(response.json()).records.map((record) => record.id);
  }

  async function update(
    user: FixtureUser,
    records: readonly { id: Id<'rec'>; fields: Record<string, unknown> }[],
    on: RecordFixture = fx,
  ): Promise<void> {
    const response = await on.call(
      user,
      'PATCH',
      `/tables/${on.orders.id}/records?field_key_type=id`,
      { records },
    );
    expect(response.statusCode, response.body).toBe(200);
  }

  const users = (...keys: FixtureUser[]) => keys.map((key) => ({ id: U(key) }));

  /** Undispatched events of an organization, oldest first, as `events.dispatch` keys. */
  async function pendingEvents(orgId: Id<'org'> = fx.orgId) {
    const { rows } = await sql<{ id: Id<'evt'>; at: string }>`
      SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
        FROM meta.events
       WHERE organization_id = ${orgId} AND dispatched_at IS NULL
       ORDER BY created_at, id
    `.execute(db.kysely);
    return rows.map((row) => ({ id: row.id, createdAt: row.at }));
  }

  /** Dispatches pending events (at most `limit`), like `events.dispatch` would. */
  async function dispatch(
    orgId: Id<'org'> = fx.orgId,
    limit = Number.POSITIVE_INFINITY,
    using: AutomationDispatcher = dispatcher,
  ): Promise<number> {
    const keys = (await pendingEvents(orgId)).slice(0, limit);
    for (const key of keys) await using.dispatch(orgScope(orgId), key);
    return keys.length;
  }

  /** Queued `notifications.fanout` jobs: run them (like the worker) and remove them. */
  async function runFanouts(): Promise<
    { payload: NotificationsFanoutPayload; result: FanoutResult }[]
  > {
    const { rows } = await sql<{ id: string; payload: NotificationsFanoutPayload }>`
      SELECT p.id::text AS id, p.payload FROM graphile_worker._private_jobs p
        JOIN graphile_worker._private_tasks t ON t.id = p.task_id
       WHERE t.identifier = 'notifications.fanout'
       ORDER BY p.id
    `.execute(db.kysely);
    const out: { payload: NotificationsFanoutPayload; result: FanoutResult }[] = [];
    for (const row of rows)
      out.push({ payload: row.payload, result: await fanout.run(row.payload) });
    if (rows.length > 0) {
      await sql`DELETE FROM graphile_worker._private_jobs WHERE id = ANY(${rows.map((row) => row.id)}::bigint[])`.execute(
        db.kysely,
      );
    }
    return out;
  }

  interface FlushJob {
    readonly id: string;
    readonly key: string | null;
    readonly run_at: Date;
    readonly payload: { organization_id: Id<'org'>; kind: 'assigned'; group_key: string };
  }

  async function flushJobs(): Promise<FlushJob[]> {
    const { rows } = await sql<FlushJob>`
      SELECT p.id::text AS id, p.key, p.run_at, p.payload FROM graphile_worker._private_jobs p
        JOIN graphile_worker._private_tasks t ON t.id = p.task_id
       WHERE t.identifier = 'notifications.flush' AND p.payload->>'kind' = 'assigned'
       ORDER BY p.id
    `.execute(db.kysely);
    return rows;
  }

  /** Runs every queued `notifications.flush` of `assigned` (like the worker) and removes the jobs. */
  async function runFlushes(): Promise<NotificationFlushOutcome[]> {
    const jobs = await flushJobs();
    const out: NotificationFlushOutcome[] = [];
    for (const job of jobs) out.push(await flusher.flush(job.payload, { jobId: job.id }));
    if (jobs.length > 0) {
      await sql`DELETE FROM graphile_worker._private_jobs WHERE id = ANY(${jobs.map((job) => job.id)}::bigint[])`.execute(
        db.kysely,
      );
    }
    return out;
  }

  /** Dispatch everything, then run the fan-outs (single writes). */
  async function settle(orgId: Id<'org'> = fx.orgId) {
    await dispatch(orgId);
    return runFanouts();
  }

  async function assignedTo(
    user: FixtureUser,
    on: RecordFixture = fx,
  ): Promise<StoredNotification[]> {
    return db.kysely
      .selectFrom('meta.notifications')
      .select([
        'user_id',
        'type',
        'entity_type',
        'entity_id',
        'table_id',
        'group_key',
        'actor_type',
        'actor_id',
        'payload',
      ])
      .where('organization_id', '=', on.orgId)
      .where('user_id', '=', on.users[user].id)
      .where('type', '=', 'record.assigned')
      .orderBy('created_at')
      .orderBy('id')
      .execute() as Promise<StoredNotification[]>;
  }

  async function listed(user: FixtureUser): Promise<NotificationDto[]> {
    const response = await fx.call(user, 'GET', me('/notifications?limit=200'));
    expect(response.statusCode, response.body).toBe(200);
    return notificationListSchema
      .parse(response.json())
      .items.filter((item) => item.type === 'record.assigned');
  }

  async function follow(user: FixtureUser, recordId: Id<'rec'>) {
    const response = await fx.call(
      user,
      'GET',
      `/tables/${fx.orders.id}/records/${recordId}/follow`,
    );
    if (response.statusCode === 404) return 'not_found' as const;
    expect(response.statusCode, response.body).toBe(200);
    return recordFollowSchema.parse(response.json());
  }

  async function followRows(recordIds: readonly Id<'rec'>[]) {
    if (recordIds.length === 0) return [];
    return db.kysely
      .selectFrom('meta.record_follows')
      .select(['record_id', 'user_id', 'source', 'muted'])
      .where('organization_id', '=', fx.orgId)
      .where('record_id', 'in', [...recordIds])
      .orderBy('record_id')
      .orderBy('user_id')
      .execute();
  }

  async function bufferRows() {
    return (
      db.kysely
        .selectFrom('meta.notification_buffer')
        .select(['organization_id', 'group_key', 'user_id', 'record_id', 'field_ids'])
        // Only `assigned`: the follow notifications (T545) buffer their own rows.
        .where('kind', '=', 'assigned')
        .orderBy('id')
        .execute()
    );
  }

  /** Writes an event as a service would (synthetic: automation actor, recompute, …). */
  async function emitted(input: Omit<EventInput, 'organizationId' | 'baseId' | 'tableId'>) {
    return db.withTx(async (tx) =>
      emit(tx, { ...input, organizationId: fx.orgId, baseId: fx.baseId, tableId: fx.orders.id }),
    );
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    fxB = await buildRecordFixture(t, db);
    query = new RecordQueryService(db, { defaultTimeZone: 'UTC' });
    dispatcher = new AutomationDispatcher(db, { defaults: DEFAULTS, records: query });
    fanout = new NotificationFanout(db, query, { emailEnabled: false, defaults: DEFAULTS });
    flusher = new NotificationFlusher(db, fanout, [new RecordAssignedGrouper(db)]);

    for (const on of [fx, fxB]) {
      // `owner` notifies on assignment (C§5 fixture + T544); `reviewers` is the
      // P40 field (several people, flag on); `helper` has no flag.
      const patched = await on.call('owner', 'PATCH', `/fields/${on.fld.owner?.id ?? ''}`, {
        options: { multiple: false, notify_on_assign: true },
      });
      expect(patched.statusCode, patched.body).toBe(200);
    }
    const added = async (name: string, options: object) => {
      const response = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/fields`, {
        name,
        type: 'user',
        options,
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<{ id: Id<'fld'> }>().id;
    };
    reviewers = await added('reviewers', { multiple: true, notify_on_assign: true });
    helper = await added('helper', { multiple: true });
    // Fixture writes and schema events: dispatched before the tests start.
    await settle();
    await settle(fxB.orgId);
    await runFlushes();
  }, 120_000);

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('record.assigned is produced: preferences list it, email on by default', async () => {
    const preferences = notificationPreferencesSchema.parse(
      (await fx.call('u_sales1', 'GET', me('/notification-preferences'))).json(),
    );
    expect(preferences.items).toContainEqual({
      type: 'record.assigned',
      channel: 'in_app',
      enabled: true,
      locked: false,
    });
    expect(preferences.items).toContainEqual({
      type: 'record.assigned',
      channel: 'email',
      enabled: true,
      locked: false,
    });
  });

  it('single write: u_editor sets owner = u_sales1 on r1 → one record.assigned, u_sales1 follows r1', async () => {
    const [r1] = await createOrders('u_editor', [{ [F('title')]: 'Đơn R1' }]);
    await settle();
    expect(await assignedTo('u_sales1')).toEqual([]);

    await update('u_editor', [
      { id: r1 as Id<'rec'>, fields: { [F('owner')]: users('u_sales1') } },
    ]);
    const [event] = await pendingEvents();
    const fanouts = await settle();
    // One fan-out for u_sales1: the record and at least one of the fields required when it runs.
    expect(fanouts.map((item) => item.payload)).toEqual([
      expect.objectContaining({
        type: 'record.assigned',
        base_id: fx.baseId,
        table_id: fx.orders.id,
        entity_type: 'record',
        entity_id: r1,
        actor: { type: 'user', id: U('u_editor') },
        group_key: `${event?.id ?? ''}:${U('u_sales1')}`,
        recipients: { user_ids: [U('u_sales1')], base_admins: false },
        requires: { record_id: r1, field_ids: [], any_field_ids: [F('owner')] },
        skip_actor: true,
        data: { batch_id: null, count: 1, record_ids: [r1], field_ids: [F('owner')] },
      }),
    ]);
    const [stored, ...more] = await assignedTo('u_sales1');
    expect(more).toEqual([]);
    expect(stored).toMatchObject({
      entity_type: 'record',
      entity_id: r1,
      table_id: fx.orders.id,
      actor_type: 'user',
      actor_id: U('u_editor'),
      payload: { batch_id: null, count: 1, record_ids: [r1], field_ids: [F('owner')] },
    });
    // Through the API, with the record title rendered for u_sales1.
    const [item] = await listed('u_sales1');
    expect(item).toMatchObject({
      type: 'record.assigned',
      base: { id: fx.baseId },
      table_id: fx.orders.id,
      entity: { type: 'record', id: r1, title: 'Đơn R1' },
      actor: { type: 'user', id: U('u_editor') },
      read_at: null,
    });
    // The assignee follows the record (same transaction as the dispatch).
    expect(await follow('u_sales1', r1 as Id<'rec'>)).toEqual({
      following: true,
      source: 'assigned',
    });
    // Nobody else: not the actor, not the other people of the base.
    for (const user of ['u_editor', 'u_admin', 'u_reader', 'u_sales2'] as const) {
      expect(await assignedTo(user)).toEqual([]);
    }
    // A redelivered event changes nothing.
    await sql`UPDATE meta.events SET dispatched_at = now() WHERE id = ${event?.id ?? ''}`.execute(
      db.kysely,
    );
    if (event !== undefined) {
      expect(await dispatcher.dispatch(orgScope(fx.orgId), event)).toMatchObject({
        status: 'redelivered',
      });
    }
    expect(await runFanouts()).toEqual([]);
    expect(await assignedTo('u_sales1')).toHaveLength(1);
  });

  it('P40: assigned to reviewers of r2 (unreadable) → nothing, no follow; of r1 → record.assigned', async () => {
    const [r1, r2] = await createOrders('u_editor', [
      { [F('title')]: 'P40 R1', [F('owner')]: users('u_sales1') },
      { [F('title')]: 'P40 R2', [F('owner')]: users('u_sales2') },
    ]);
    await settle();
    await runFlushes();
    const before = (await assignedTo('u_sales1')).length;

    await update('u_editor', [{ id: r2 as Id<'rec'>, fields: { [reviewers]: users('u_sales1') } }]);
    const unreadable = await settle();
    expect(unreadable.map((item) => item.result)).toEqual([
      { written: [], skipped: [{ userId: U('u_sales1'), reason: 'cannot_read_record' }] },
    ]);
    expect(await assignedTo('u_sales1')).toHaveLength(before);
    expect(
      (await followRows([r2 as Id<'rec'>])).filter((row) => row.user_id === U('u_sales1')),
    ).toEqual([]);
    expect(await follow('u_sales1', r2 as Id<'rec'>)).toBe('not_found');
    // No notification row means no channel at all (in-app, email, later Telegram).
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.notification_deliveries d
        JOIN meta.notifications n ON n.id = d.notification_id
       WHERE n.user_id = ${U('u_sales1')} AND n.entity_id = ${r2 ?? ''}
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe(0);

    await update('u_editor', [{ id: r1 as Id<'rec'>, fields: { [reviewers]: users('u_sales1') } }]);
    await settle();
    const fresh = (await assignedTo('u_sales1')).slice(before);
    expect(fresh).toEqual([
      expect.objectContaining({
        entity_type: 'record',
        entity_id: r1,
        payload: { batch_id: null, count: 1, record_ids: [r1], field_ids: [reviewers] },
      }),
    ]);
    expect(await follow('u_sales1', r1 as Id<'rec'>)).toEqual({
      following: true,
      source: 'assigned',
    });
  });

  it('only people added to a flagged field: no flag, removals, re-ordering and unchanged values notify nobody', async () => {
    const [r] = await createOrders('u_editor', [
      { [F('title')]: 'Chỉ người mới', [reviewers]: users('u_reader', 'u_admin') },
    ]);
    await settle();
    const start = {
      reader: (await assignedTo('u_reader')).length,
      admin: (await assignedTo('u_admin')).length,
      sales2: (await assignedTo('u_sales2')).length,
    };
    const id = r as Id<'rec'>;
    // A field without `notify_on_assign`.
    await update('u_editor', [{ id, fields: { [helper]: users('u_sales2') } }]);
    // Removing someone, re-ordering, writing the same value.
    await update('u_editor', [{ id, fields: { [reviewers]: users('u_admin') } }]);
    await update('u_editor', [{ id, fields: { [reviewers]: users('u_admin') } }]);
    expect(await settle()).toEqual([]);
    expect((await assignedTo('u_sales2')).length).toBe(start.sales2);
    expect((await assignedTo('u_admin')).length).toBe(start.admin);
    // Adding back one person notifies that person only, with that field.
    await update('u_editor', [{ id, fields: { [reviewers]: users('u_reader', 'u_admin') } }]);
    await settle();
    expect((await assignedTo('u_reader')).length).toBe(start.reader + 1);
    expect((await assignedTo('u_admin')).length).toBe(start.admin);
  });

  it('a new record assigns everyone of its value; two fields → one notification naming both; the creator is left out', async () => {
    const before = {
      reader: (await assignedTo('u_reader')).length,
      editor: (await assignedTo('u_editor')).length,
    };
    const [r] = await createOrders('u_editor', [
      {
        [F('title')]: 'Hai field',
        [F('owner')]: users('u_reader'),
        [reviewers]: users('u_reader', 'u_editor'),
      },
    ]);
    await settle();
    const fresh = (await assignedTo('u_reader')).slice(before.reader);
    expect(fresh).toEqual([
      expect.objectContaining({
        entity_id: r,
        payload: {
          batch_id: null,
          count: 1,
          record_ids: [r],
          field_ids: [F('owner'), reviewers],
        },
      }),
    ]);
    // Assigning yourself: no notification, and the follow comes only from creating it.
    expect((await assignedTo('u_editor')).length).toBe(before.editor);
    expect(byRecordThenUser(await followRows([r as Id<'rec'>]))).toEqual(
      byRecordThenUser([
        { record_id: r as string, user_id: U('u_editor'), source: 'created', muted: false },
        { record_id: r as string, user_id: U('u_reader'), source: 'assigned', muted: false },
      ]),
    );
  });

  it('assigning yourself on an existing record: no notification, no follow', async () => {
    const [r] = await createOrders('u_admin', [{ [F('title')]: 'Tự gán' }]);
    await settle();
    const before = (await assignedTo('u_sales2')).length;
    // u_admin assigns u_admin.
    await update('u_admin', [{ id: r as Id<'rec'>, fields: { [reviewers]: users('u_admin') } }]);
    expect(await settle()).toEqual([]);
    expect(await assignedTo('u_admin')).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ entity_id: r })]),
    );
    expect((await followRows([r as Id<'rec'>])).filter((row) => row.source === 'assigned')).toEqual(
      [],
    );
    expect((await assignedTo('u_sales2')).length).toBe(before);
  });

  it('an automation (or any non-user actor) assigning someone is notified', async () => {
    const [r] = await createOrders('u_admin', [{ [F('title')]: 'Automation gán' }]);
    await settle();
    const automationId = 'aut_T544AutoAssign01' as Id<'aut'>;
    await emitted({
      type: 'record.updated',
      entityId: r as Id<'rec'>,
      actor: { type: 'automation', id: automationId },
      changes: { [F('owner')]: { from: null, to: [U('u_reader')] } },
      recordVersion: 2,
    });
    await settle();
    const [last] = (await assignedTo('u_reader')).slice(-1);
    expect(last).toMatchObject({
      entity_id: r,
      actor_type: 'automation',
      actor_id: automationId,
      payload: { batch_id: null, count: 1, record_ids: [r], field_ids: [F('owner')] },
    });
  });

  it('recomputed values, deleted fields and people outside the organization assign nobody', async () => {
    const [r] = await createOrders('u_admin', [{ [F('title')]: 'Không ai' }]);
    await settle();
    const listener = new RecordAssignedListener(db, { defaults: DEFAULTS, records: query });
    const handle = (event: Awaited<ReturnType<typeof emitted>>) =>
      db.withTx(async (tx) => {
        const row = await db.kysely
          .selectFrom('meta.events')
          .selectAll()
          .where('id', '=', event.id)
          .executeTakeFirstOrThrow();
        return listener.handle(orgScope(fx.orgId, tx), toEventDocument(row));
      });

    const recomputed = await emitted({
      type: 'record.updated',
      entityId: r as Id<'rec'>,
      actor: { type: 'system', id: null },
      changes: { [F('owner')]: { from: null, to: [U('u_reader')] } },
      via: { computed_recompute: true, job_id: null },
    });
    expect(await handle(recomputed)).toEqual({ status: 'ignored' });

    // A flagged field deleted since the change.
    const gone = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'tạm',
      type: 'user',
      options: { multiple: true, notify_on_assign: true },
    });
    expect(gone.statusCode, gone.body).toBe(201);
    const goneId = gone.json<{ id: Id<'fld'> }>().id;
    const deleted = await fx.call('owner', 'DELETE', `/fields/${goneId}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    const onDeleted = await emitted({
      type: 'record.updated',
      entityId: r as Id<'rec'>,
      actor: { type: 'user', id: U('u_admin') },
      changes: { [goneId]: { from: null, to: [U('u_reader')] } },
      recordVersion: 2,
    });
    expect(await handle(onDeleted)).toEqual({ status: 'none' });

    // A user of another organization (and a malformed value): single and bulk.
    const outsider = await emitted({
      type: 'record.updated',
      entityId: r as Id<'rec'>,
      actor: { type: 'user', id: U('u_admin') },
      changes: { [reviewers]: { from: null, to: [fx.users.stranger.id, 'nope'] } },
      recordVersion: 3,
    });
    expect(await handle(outsider)).toEqual({ status: 'none' });
    const outsiderBulk = await emitted({
      type: 'record.updated',
      entityId: r as Id<'rec'>,
      actor: { type: 'user', id: U('u_admin') },
      changes: { [reviewers]: { from: null, to: [fx.users.stranger.id] } },
      recordVersion: 4,
      batch: { id: 'req_T544Outsider0001', size: 2 },
    });
    expect(await handle(outsiderBulk)).toEqual({ status: 'none' });
    // A deleted record type event never assigns.
    const removed = await emitted({
      type: 'record.deleted',
      entityId: r as Id<'rec'>,
      actor: { type: 'user', id: U('u_admin') },
      changes: { [F('owner')]: { from: null, to: [U('u_reader')] } },
    });
    expect(await handle(removed)).toEqual({ status: 'ignored' });

    // Dispatched for real: nothing queued, nothing buffered.
    expect(await settle()).toEqual([]);
    expect(await bufferRows()).toEqual([]);
    expect(await flushJobs()).toEqual([]);
  });

  it('paste of 3 records, u_sales1 reads 1 → one notification count 1; u_reader count 3; follows only readable records', async () => {
    const [rA, rB, rC] = (await createOrders('u_editor', [
      { [F('title')]: 'Lô A', [F('owner')]: users('u_sales1') },
      { [F('title')]: 'Lô B', [F('owner')]: users('u_sales2') },
      { [F('title')]: 'Lô C', [F('owner')]: users('u_sales2') },
    ])) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
    await settle();
    await runFlushes();
    // u_reader unfollowed rB by hand before: the paste must not follow it again.
    const followed = await fx.call(
      'u_reader',
      'PUT',
      `/tables/${fx.orders.id}/records/${rB}/follow`,
    );
    expect(followed.statusCode).toBe(204);
    const unfollowed = await fx.call(
      'u_reader',
      'DELETE',
      `/tables/${fx.orders.id}/records/${rB}/follow`,
    );
    expect(unfollowed.statusCode).toBe(204);
    const before = {
      sales1: (await assignedTo('u_sales1')).length,
      reader: (await assignedTo('u_reader')).length,
    };

    await update(
      'u_editor',
      [rA, rB, rC].map((id) => ({ id, fields: { [reviewers]: users('u_sales1', 'u_reader') } })),
    );
    // Events of one request: `batch = { id: req_…, size: 3 }`.
    const batchId = (
      await db.kysely
        .selectFrom('meta.events')
        .select('payload')
        .where('organization_id', '=', fx.orgId)
        .where('dispatched_at', 'is', null)
        .executeTakeFirstOrThrow()
    ).payload as { batch?: { id: string; size: number } };
    expect(batchId.batch?.size).toBe(3);
    const batch = batchId.batch?.id ?? '';

    // Two of three dispatched: buffered, the flush waits (10 s after the first row).
    await dispatch(fx.orgId, 2);
    expect(await runFanouts()).toEqual([]);
    expect((await bufferRows()).map((row) => row.group_key)).toEqual(Array(4).fill(batch));
    const [pending] = await flushJobs();
    expect(pending?.key).toBe(`assigned:${batch}`);
    expect(pending?.run_at.getTime()).toBeGreaterThan(Date.now() + 5_000);
    // The third: every record of the call is buffered → flush now.
    await dispatch(fx.orgId, 1);
    const [due, ...others] = await flushJobs();
    expect(others).toEqual([]);
    expect(due?.run_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    const [outcome] = await runFlushes();
    expect(outcome).toEqual({
      status: 'flushed',
      rows: 6,
      requests: 2,
      recorded: 2,
      skipped: {},
    });
    const [sales1, ...moreSales1] = (await assignedTo('u_sales1')).slice(before.sales1);
    expect(moreSales1).toEqual([]);
    expect(sales1).toMatchObject({
      entity_type: 'table',
      entity_id: fx.orders.id,
      table_id: fx.orders.id,
      group_key: `${batch}:${fx.orders.id}`,
      actor_type: 'user',
      actor_id: U('u_editor'),
      payload: { batch_id: batch, count: 1, record_ids: [rA], field_ids: [reviewers] },
    });
    const [reader, ...moreReader] = (await assignedTo('u_reader')).slice(before.reader);
    expect(moreReader).toEqual([]);
    // Records in append (dispatch) order.
    expect(reader?.payload).toEqual({
      batch_id: batch,
      count: 3,
      record_ids: expect.arrayContaining([rA, rB, rC]) as unknown,
      field_ids: [reviewers],
    });
    expect(reader?.payload.record_ids).toHaveLength(3);
    // API: a grouped item is about the table.
    const [item] = await listed('u_sales1');
    expect(item).toMatchObject({
      entity: { type: 'table', id: fx.orders.id, title: 'Orders' },
      data: { batch_id: batch, count: 1 },
    });
    // Follows: u_sales1 only the record they read; u_reader every record but rB (unfollowed).
    expect(
      byRecordThenUser(
        (await followRows([rA, rB, rC])).filter(
          (row) => row.user_id === U('u_sales1') || row.user_id === U('u_reader'),
        ),
      ),
    ).toEqual(
      byRecordThenUser([
        { record_id: rA, user_id: U('u_sales1'), source: 'assigned', muted: false },
        { record_id: rA, user_id: U('u_reader'), source: 'assigned', muted: false },
        { record_id: rB, user_id: U('u_reader'), source: 'manual', muted: true },
        { record_id: rC, user_id: U('u_reader'), source: 'assigned', muted: false },
      ]),
    );
    // Rows deleted with the flush; a re-run writes nothing twice.
    expect(await bufferRows()).toEqual([]);
    expect(
      await flusher.flush({ organization_id: fx.orgId, kind: 'assigned', group_key: batch }),
    ).toEqual({
      status: 'empty',
    });
    await db.withTx((tx) =>
      new NotificationBuffer(db).append(tx, {
        organizationId: fx.orgId,
        kind: 'assigned',
        groupKey: batch,
        rows: [
          {
            userId: U('u_reader'),
            tableId: fx.orders.id,
            recordId: rA,
            fieldIds: [reviewers],
            actor: { type: 'user', id: U('u_editor') },
          },
        ],
      }),
    );
    expect(await runFlushes()).toEqual([
      { status: 'flushed', rows: 1, requests: 1, recorded: 0, skipped: {} },
    ]);
    expect((await assignedTo('u_reader')).slice(before.reader)).toHaveLength(1);
  });

  it('bulk write where u_sales1 reads none of the records → no notification, no follow', async () => {
    const records = await createOrders('u_editor', [
      { [F('title')]: 'Không đọc 1', [F('owner')]: users('u_sales2') },
      { [F('title')]: 'Không đọc 2', [F('owner')]: users('u_sales2') },
    ]);
    await settle();
    await runFlushes();
    const before = (await assignedTo('u_sales1')).length;
    await update(
      'u_editor',
      records.map((id) => ({ id, fields: { [reviewers]: users('u_sales1') } })),
    );
    await settle();
    expect(await runFlushes()).toEqual([
      { status: 'flushed', rows: 2, requests: 1, recorded: 0, skipped: { cannot_read_record: 1 } },
    ]);
    expect(await assignedTo('u_sales1')).toHaveLength(before);
    expect((await followRows(records)).filter((row) => row.user_id === U('u_sales1'))).toEqual([]);
  });

  it('bulk write where only part of the records assign: flushed 10 s after the first row (preserve_run_at)', async () => {
    const records = await createOrders('u_editor', [
      { [F('title')]: 'Một phần 1' },
      { [F('title')]: 'Một phần 2' },
      { [F('title')]: 'Một phần 3' },
      { [F('title')]: 'Một phần 4' },
    ]);
    await settle();
    await runFlushes();
    const before = (await assignedTo('u_admin')).length;
    await update('u_editor', [
      { id: records[0] as Id<'rec'>, fields: { [reviewers]: users('u_admin') } },
      { id: records[1] as Id<'rec'>, fields: { [F('title')]: 'Đổi tên' } },
      { id: records[2] as Id<'rec'>, fields: { [reviewers]: users('u_admin') } },
      { id: records[3] as Id<'rec'>, fields: { [F('title')]: 'Đổi tên 2' } },
    ]);
    await settle();
    const [job, ...others] = await flushJobs();
    expect(others).toEqual([]);
    // Two of four records buffered: not early.
    expect(job?.run_at.getTime()).toBeGreaterThan(Date.now() + 5_000);
    await runFlushes();
    const fresh = (await assignedTo('u_admin')).slice(before);
    expect(fresh.map((row) => row.payload)).toEqual([
      expect.objectContaining({ count: 2, field_ids: [reviewers] }),
    ]);
    expect([...(fresh[0]?.payload.record_ids as string[])].sort()).toEqual(
      [records[0], records[2]].sort(),
    );
  });

  it('a worker stopped in the middle of a batch: after it restarts, exactly one notification for the whole batch', async () => {
    const records = await createOrders(
      'u_editor',
      Array.from({ length: 6 }, (_, i) => ({ [F('title')]: `Dừng ${String(i)}` })),
    );
    await settle();
    await runFlushes();
    const before = (await assignedTo('u_reader')).length;
    await update(
      'u_editor',
      records.map((id) => ({ id, fields: { [reviewers]: users('u_reader') } })),
    );
    // The worker dispatches 3 events, then stops.
    await dispatch(fx.orgId, 3);
    expect(await bufferRows()).toHaveLength(3);
    const [waiting] = await flushJobs();
    expect(waiting?.run_at.getTime()).toBeGreaterThan(Date.now() + 5_000);
    expect((await assignedTo('u_reader')).length).toBe(before);
    // It runs again: the rest of the batch, then the flush (moved to now).
    await dispatch();
    const [due, ...others] = await flushJobs();
    expect(others).toEqual([]);
    expect(due?.run_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(await runFlushes()).toEqual([
      { status: 'flushed', rows: 6, requests: 1, recorded: 1, skipped: {} },
    ]);
    // A copy of the flush job that runs again finds nothing.
    if (due !== undefined) {
      expect(await flusher.flush(due.payload, { jobId: due.id })).toEqual({ status: 'empty' });
    }
    const fresh = (await assignedTo('u_reader')).slice(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.payload).toMatchObject({ count: 6 });
  });

  it('import batches are flushed 10 s after their last row; other batches 10 s after their first', async () => {
    const [r1, r2] = (await createOrders('u_editor', [
      { [F('title')]: 'Debounce 1' },
      { [F('title')]: 'Debounce 2' },
    ])) as [Id<'rec'>, Id<'rec'>];
    await settle();
    await runFlushes();
    let clock = new Date('2026-10-17T03:00:00.000Z');
    const pinned = new AutomationDispatcher(db, {
      defaults: DEFAULTS,
      records: query,
      assignedListener: new RecordAssignedListener(db, {
        defaults: DEFAULTS,
        records: query,
        buffer: new NotificationBuffer(db, { now: () => clock }),
      }),
    });
    const bulk = (recordId: Id<'rec'>, batchId: string, importJob: boolean, version: number) =>
      emitted({
        type: 'record.updated',
        entityId: recordId,
        actor: { type: 'user', id: U('u_editor') },
        changes: { [reviewers]: { from: null, to: [U('u_reader')] } },
        recordVersion: version,
        batch: { id: batchId as Id<'req'> | Id<'job'>, size: 1000 },
        ...(importJob ? { via: { import_job_id: batchId as Id<'job'> } } : {}),
      });
    const runAt = async (batchId: string) =>
      (await flushJobs()).find((job) => job.payload.group_key === batchId)?.run_at.getTime();

    const importJob = 'job_T544ImportDeb001';
    await bulk(r1, importJob, true, 10);
    await dispatch(fx.orgId, Number.POSITIVE_INFINITY, pinned);
    expect(await runAt(importJob)).toBe(clock.getTime() + 10_000);
    clock = new Date(clock.getTime() + 8_000);
    await bulk(r2, importJob, true, 11);
    await dispatch(fx.orgId, Number.POSITIVE_INFINITY, pinned);
    expect(await runAt(importJob)).toBe(clock.getTime() + 10_000);

    const request = 'req_T544RequestDeb01';
    const first = clock.getTime();
    await bulk(r1, request, false, 12);
    await dispatch(fx.orgId, Number.POSITIVE_INFINITY, pinned);
    clock = new Date(clock.getTime() + 8_000);
    await bulk(r2, request, false, 13);
    await dispatch(fx.orgId, Number.POSITIVE_INFINITY, pinned);
    expect(await runAt(request)).toBe(first + 10_000);

    const outcomes = await runFlushes();
    expect(outcomes).toEqual([
      { status: 'flushed', rows: 2, requests: 1, recorded: 1, skipped: {} },
      { status: 'flushed', rows: 2, requests: 1, recorded: 1, skipped: {} },
    ]);
    const imported = (await assignedTo('u_reader')).find(
      (row) => row.payload.batch_id === importJob,
    );
    expect(imported?.payload).toEqual({
      batch_id: importJob,
      count: 2,
      record_ids: [r1, r2],
      field_ids: [reviewers],
    });
  });

  it('auto_follow_assigned off: notified, not followed; unfollowed by hand: re-assigning never follows again', async () => {
    const off = await fx.call('u_admin', 'PUT', me('/notification-settings'), {
      auto_follow_assigned: false,
    });
    expect(off.statusCode, off.body).toBe(200);
    const [r, s] = (await createOrders('u_editor', [
      { [F('title')]: 'Công tắc' },
      { [F('title')]: 'Bỏ theo dõi', [F('owner')]: users('u_sales1') },
    ])) as [Id<'rec'>, Id<'rec'>];
    await settle();
    await runFlushes();
    const before = (await assignedTo('u_admin')).length;
    await update('u_editor', [{ id: r, fields: { [reviewers]: users('u_admin') } }]);
    await settle();
    expect((await assignedTo('u_admin')).length).toBe(before + 1);
    expect(await follow('u_admin', r)).toEqual({ following: false, source: null });
    // Bulk path too.
    await update('u_editor', [
      { id: r, fields: { [helper]: users('u_admin') } },
      { id: s, fields: { [reviewers]: users('u_admin') } },
    ]);
    await settle();
    await runFlushes();
    expect(await follow('u_admin', s)).toEqual({ following: false, source: null });
    const on = await fx.call('u_admin', 'PUT', me('/notification-settings'), {
      auto_follow_assigned: true,
    });
    expect(on.statusCode, on.body).toBe(200);

    // "Câu hỏi mở S5b" #2: u_sales1 created nothing here; follows s by hand, unfollows, is re-assigned.
    expect(
      (await fx.call('u_sales1', 'PUT', `/tables/${fx.orders.id}/records/${s}/follow`)).statusCode,
    ).toBe(204);
    expect(
      (await fx.call('u_sales1', 'DELETE', `/tables/${fx.orders.id}/records/${s}/follow`))
        .statusCode,
    ).toBe(204);
    const sales1 = (await assignedTo('u_sales1')).length;
    await update('u_editor', [{ id: s, fields: { [reviewers]: users('u_sales1') } }]);
    await settle();
    expect((await assignedTo('u_sales1')).length).toBe(sales1 + 1);
    expect(await follow('u_sales1', s)).toEqual({ following: false, source: null });
  });

  it('organizations stay apart: assignments in org B notify org B only; flushing org A finds nothing of B', async () => {
    const [b1, b2] = (await createOrders(
      'u_editor',
      [{ [fxB.fld.title?.id ?? '']: 'Org B 1' }, { [fxB.fld.title?.id ?? '']: 'Org B 2' }],
      fxB,
    )) as [Id<'rec'>, Id<'rec'>];
    await settle(fxB.orgId);
    await runFlushes();
    const beforeA = (await assignedTo('u_reader')).length;
    await update(
      'u_editor',
      [b1, b2].map((id) => ({
        id,
        fields: { [fxB.fld.owner?.id ?? '']: [{ id: fxB.users.u_reader.id }] },
      })),
      fxB,
    );
    await dispatch(fxB.orgId);
    const rows = await bufferRows();
    expect(rows.map((row) => row.organization_id)).toEqual([fxB.orgId, fxB.orgId]);
    const groupKey = rows[0]?.group_key ?? '';
    // Org A's flush of the same group key sees nothing of org B.
    expect(
      await flusher.flush({ organization_id: fx.orgId, kind: 'assigned', group_key: groupKey }),
    ).toEqual({ status: 'empty' });
    await runFlushes();
    expect(await assignedTo('u_reader', fxB)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ count: 2 }) as unknown }),
    ]);
    expect((await assignedTo('u_reader')).length).toBe(beforeA);
    // The other organization's notification is not visible from org A's API.
    const fromA = await fxB.call('u_reader', 'GET', me('/notifications?limit=200', fx.orgId));
    expect(fromA.statusCode).toBe(404);
  });
});
