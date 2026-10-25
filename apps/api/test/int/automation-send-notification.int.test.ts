import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  fieldSchema,
  newId,
  notificationListSchema,
  roleSchema,
  type FieldDto,
  type Id,
  type NotificationDto,
  type RealtimeServerMessage,
} from '@cellhive/contracts';
import {
  AutomationRunEngine,
  AutomationRunsRepository,
  AutomationRunStepsRepository,
  AutomationsRepository,
  createSendNotificationAction,
  defaultActionRegistry,
  GroupMembersRepository,
  GroupsRepository,
  NO_AUTOMATION_NOTIFICATIONS,
  NotificationWriter,
  orgScope,
  RecordMutationService,
  RecordQueryService,
  SchemaService,
  type Db,
  type DeferrableJob,
  type JsonObject,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB } from '../../src/common/tokens.js';

import { seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

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

/**
 * BACKLOG T515 (`send_notification`, ADR-32 §1, CONTRACTS §21/§22): the
 * handler of the run engine against the real database and realtime bus —
 * per-recipient access (record and every field the text uses), rendering
 * per permission group (P35 lookup), the 100-recipient cap, the hourly cap
 * with its summary, `skip_actor`, email queueing, purge cleanup — and the
 * save-time checks through the API.
 */
describe('send_notification (T515)', () => {
  let database: TestDatabase;
  let db: Db;
  let appDb: Db;
  let t: TestApp;
  let url: string;
  let fx: RecordFixture;
  let records: RecordMutationService;
  let query: RecordQueryService;
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;
  const sockets: TestSocket[] = [];

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const scope = () => orgScope(fx.orgId);
  const user = (name: FixtureUser) => fx.users[name].id;

  function engine(): AutomationRunEngine {
    return new AutomationRunEngine(appDb, {
      defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
      query,
      actions: defaultActionRegistry({ records, query }, [
        [
          'send_notification',
          createSendNotificationAction({
            db: appDb,
            query,
            defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
            emailEnabled: true,
          }),
        ],
      ]),
      publicUrl: TEST_PUBLIC_URL,
      notifier: NO_AUTOMATION_NOTIFICATIONS,
      random: () => 0,
    });
  }

  function notify(config: Record<string, unknown>, id = 'act_note'): JsonObject {
    return {
      id,
      type: 'send_notification',
      config: {
        recipients: [{ field: F('owner') }],
        title: { template: `Đơn {{ [${F('title')}] }}` },
        body: { template: '' },
        link_record: 'trigger',
        skip_actor: false,
        ...config,
      },
    };
  }

  async function createRecord(
    tableId: Id<'tbl'>,
    fields: Record<string, unknown>,
    as: FixtureUser = 'u_admin',
  ): Promise<Id<'rec'>> {
    const response = await fx.call(as, 'POST', `/tables/${tableId}/records?field_key_type=id`, {
      records: [{ fields }],
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  /** An enabled automation (run as u_admin) and one `queued` run on `recordId`. */
  async function queuedRun(
    actions: JsonObject[],
    recordId: Id<'rec'>,
    options: { tableId?: Id<'tbl'>; event?: { id: Id<'evt'>; createdAt: string } } = {},
  ): Promise<{ automationId: Id<'aut'>; runId: Id<'run'> }> {
    const tableId = options.tableId ?? fx.orders.id;
    const automationId = newId('aut');
    const definition = {
      trigger: { type: 'record.created', table_id: tableId, skip_bulk: false },
      condition: null,
      actions,
    } as unknown as JsonObject;
    await new AutomationsRepository(db).insert(scope(), {
      id: automationId,
      baseId: fx.baseId,
      name: 'Nhắc đơn',
      description: '',
      enabled: true,
      definition,
      triggerType: 'record.created',
      triggerTableId: tableId,
      createdBy: user('u_admin'),
    });
    const runId = newId('run');
    await new AutomationRunsRepository(db).insert(scope(), {
      id: runId,
      automationId,
      automationVersion: 1,
      triggerEventId: options.event?.id ?? null,
      triggerUnit: newId('evt'),
      status: 'queued',
      depth: 0,
      input: {
        automation_version: 1,
        definition,
        trigger: {
          event_id: options.event?.id ?? null,
          event_created_at: options.event?.createdAt ?? null,
          type: 'record.created',
          table_id: tableId,
          record_id: recordId,
          bulk: false,
          batch: null,
        },
      },
    });
    return { automationId, runId };
  }

  const execute = (runId: Id<'run'>) => engine().execute(scope(), runId, jobOf(fx.orgId, runId));
  const stepOf = async (runId: Id<'run'>) =>
    (await new AutomationRunStepsRepository(db).listByRun(scope(), runId))[0];

  async function messagesOf(userId: Id<'usr'>, runId?: Id<'run'>) {
    const rows = await db.kysely
      .selectFrom('meta.notifications')
      .select(['id', 'payload', 'entity_type', 'entity_id', 'group_key', 'in_app'])
      .where('organization_id', '=', fx.orgId)
      .where('user_id', '=', userId)
      .where('type', '=', 'automation.message')
      .orderBy('created_at')
      .execute();
    return rows.filter(
      (row) => runId === undefined || (row.payload as { run_id?: string }).run_id === runId,
    );
  }

  async function list(as: FixtureUser): Promise<NotificationDto[]> {
    const response = await fx.call(as, 'GET', `/orgs/${fx.orgId}/me/notifications`);
    expect(response.statusCode, response.body).toBe(200);
    return notificationListSchema.parse(response.json()).items;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({
      DATABASE_URL: database.url,
      SMTP_URL: 'smtp://127.0.0.1:2525',
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
      SMTP_ALLOW_INSECURE: 'true',
    });
    url = await listen(t.app);
    appDb = t.app.get<Db>(DB);
    fx = await buildRecordFixture(t, db);
    records = t.app.get(RecordMutationService);
    query = t.app.get(RecordQueryService);
    // CONTRACTS §5: r1 of u_sales1, r2 of u_sales2 (Sales reads its own orders only, not cost).
    r1 = await createRecord(fx.orders.id, {
      [F('title')]: 'Đơn R1',
      [F('cost')]: 60,
      [F('owner')]: [{ id: user('u_sales1') }],
    });
    r2 = await createRecord(fx.orders.id, {
      [F('title')]: 'Đơn R2',
      [F('owner')]: [{ id: user('u_sales2') }],
    });
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('run (handler)', () => {
    it('delivers to who reads the record; u_sales1 is left out of r2 (cannot_read_record)', async () => {
      const { automationId, runId } = await queuedRun(
        [
          notify({
            recipients: [{ user_ids: [user('u_sales1'), user('u_reader')] }],
            body: { template: `Xem đơn {{ [${F('title')}] }}\r\n<b>ngay</b>` },
          }),
        ],
        r2,
      );
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      const step = await stepOf(runId);
      expect(step?.status).toBe('succeeded');
      expect(step?.output).toEqual({
        recipients: 2,
        delivered: 1,
        turned_off: 0,
        summarized: 0,
        groups: 1,
        record_id: r2,
        skipped: [{ user_id: user('u_sales1'), reason: 'cannot_read_record' }],
      });
      // No title, no body in the run log.
      expect(JSON.stringify(step?.output)).not.toContain('Đơn R2');
      expect(await messagesOf(user('u_sales1'), runId)).toEqual([]);
      const [item] = (await list('u_reader')).filter(
        (notification) => notification.data['run_id'] === runId,
      );
      expect(item).toMatchObject({
        type: 'automation.message',
        base: { id: fx.baseId },
        table_id: fx.orders.id,
        entity: { type: 'record', id: r2, title: 'Đơn R2' },
        actor: { type: 'automation', id: automationId },
        data: {
          automation_id: automationId,
          run_id: runId,
          title: 'Đơn Đơn R2',
          body: 'Xem đơn Đơn R2\n<b>ngay</b>',
        },
      });
      // The email follows the recipient's choices (T512 sends it).
      const deliveries = await db.kysely
        .selectFrom('meta.notification_deliveries')
        .select(['notification_id', 'status'])
        .where('notification_id', '=', item?.id as Id<'ntf'>)
        .execute();
      expect(deliveries).toEqual([{ notification_id: item?.id, status: 'pending' }]);
    });

    it('leaves out who reads the record but not a field of the text (cannot_read_field)', async () => {
      const { runId } = await queuedRun(
        [
          notify({
            recipients: [{ field: F('owner') }, { user_ids: [user('u_reader')] }],
            body: { template: `Giá vốn {{ [${F('cost')}] }}` },
          }),
        ],
        r1,
      );
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      expect((await stepOf(runId))?.output).toMatchObject({
        recipients: 2,
        delivered: 1,
        skipped: [{ user_id: user('u_sales1'), reason: 'cannot_read_field' }],
      });
      const [message] = await messagesOf(user('u_reader'), runId);
      expect(message?.payload).toMatchObject({ title: 'Đơn Đơn R1', body: 'Giá vốn 60' });
      // Without cost, the owner u_sales1 is notified (reminders reach the person concerned).
      const { runId: second } = await queuedRun([notify({})], r1);
      expect(await execute(second)).toEqual({ status: 'succeeded' });
      expect((await messagesOf(user('u_sales1'), second)).map((row) => row.payload)).toEqual([
        expect.objectContaining({ title: 'Đơn Đơn R1', body: '' }),
      ]);
    });

    it('renders a lookup (P35) per permission group, not as run_as', async () => {
      const customerLink = await addField(fx.orders.id, {
        name: 'customer',
        type: 'link',
        options: { link_table: fx.customers.id },
      });
      const customer = await createRecord(fx.customers.id, {
        [fx.customers.primary_field_id as string]: 'Khách P35',
      });
      for (const [index, amount] of [500_000, 700_000, 900_000].entries()) {
        await createRecord(fx.orders.id, {
          [F('title')]: `p35-${String(index)}`,
          [F('amount')]: amount,
          [customerLink.id]: [customer],
        });
      }
      // Stored lookup, backfilled after the orders exist (no recompute worker here).
      const total = await addField(fx.customers.id, {
        name: 'orders_total',
        type: 'lookup',
        options: {
          from: fx.orders.id,
          select: F('amount'),
          where: { field: customerLink.id, operator: 'intersects', value: { field_ref: '__id' } },
          aggregate: 'sum',
        },
      });
      const analyst = await analystUser();
      const { runId } = await queuedRun(
        [
          notify({
            recipients: [{ user_ids: [user('u_reader'), analyst.id] }],
            title: { template: `Khách {{ [${fx.customers.primary_field_id as string}] }}` },
            body: { template: `Tổng {{ [${total.id}] }}` },
          }),
        ],
        customer,
        { tableId: fx.customers.id },
      );
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      expect((await stepOf(runId))?.output).toMatchObject({ delivered: 2, groups: 2, skipped: [] });
      const digits = async (userId: Id<'usr'>) => {
        const [row] = await messagesOf(userId, runId);
        return String((row?.payload as { body?: string } | undefined)?.body).replace(/\D/g, '');
      };
      expect(await digits(user('u_reader'))).toBe('2100000');
      expect(await digits(analyst.id)).toBe('1600000');
    });

    it('fails a group of 150 users (too_many_recipients) without sending anything', async () => {
      const group = await new GroupsRepository(db).create(scope(), { name: 'Cả công ty' });
      const members = new GroupMembersRepository(db);
      for (let index = 0; index < 150; index += 1) {
        const seeded = await seedUser(db, {
          memberships: [{ orgId: fx.orgId, role: 'member' }],
          password: null,
        });
        await members.add(scope(), group.id, seeded.id);
      }
      const { runId } = await queuedRun(
        [notify({ recipients: [{ group_id: group.id }, { user_ids: [user('u_reader')] }] })],
        r1,
      );
      expect(await execute(runId)).toMatchObject({
        status: 'failed',
        code: 'too_many_recipients',
      });
      expect((await stepOf(runId))?.error).toMatchObject({
        code: 'too_many_recipients',
        params: { count: 151, limit: 100 },
      });
      expect(await messagesOf(user('u_reader'), runId)).toEqual([]);
    });

    it('past 100 messages in an hour, a recipient gets one summary whose count goes up', async () => {
      const target = await seedUser(db, {
        memberships: [{ orgId: fx.orgId, role: 'member' }],
        password: null,
      });
      await fx.call('owner', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: target.id,
        role_id: await systemRole('system_reader'),
      });
      const writer = new NotificationWriter(db, { emailEnabled: false });
      await db.withTx((tx) =>
        writer.write(
          tx,
          fx.orgId,
          Array.from({ length: 100 }, (_, index) => ({
            userId: target.id,
            type: 'automation.message' as const,
            baseId: fx.baseId,
            tableId: null,
            entityType: 'automation' as const,
            entityId: 'aut_EarlierMessages01',
            actor: null,
            groupKey: `earlier:${String(index)}`,
            data: {
              automation_id: 'aut_EarlierMessages01',
              run_id: 'run_EarlierMessage01',
              title: 'Tin cũ',
              body: '',
            },
          })),
        ),
      );
      const first = await queuedRun([notify({ recipients: [{ user_ids: [target.id] }] })], r1);
      expect(await execute(first.runId)).toEqual({ status: 'succeeded' });
      expect((await stepOf(first.runId))?.output).toMatchObject({ delivered: 1, summarized: 1 });
      let summaries = (await messagesOf(target.id)).filter((row) =>
        row.group_key?.startsWith('summary:'),
      );
      expect(summaries.map((row) => row.payload)).toEqual([
        expect.objectContaining({
          automation_id: first.automationId,
          title: '1 tin từ automation «Nhắc đơn»',
          summary_count: 1,
        }),
      ]);
      // Another message of the same automation: the summary is replaced with count 2.
      const runId = newId('run');
      await new AutomationRunsRepository(db).insert(scope(), {
        id: runId,
        automationId: first.automationId,
        automationVersion: 1,
        triggerEventId: null,
        triggerUnit: newId('evt'),
        status: 'queued',
        depth: 0,
        input: (await new AutomationRunsRepository(db).get(scope(), first.runId))
          ?.input as JsonObject,
      });
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      summaries = (await messagesOf(target.id)).filter((row) =>
        row.group_key?.startsWith('summary:'),
      );
      expect(summaries.map((row) => row.payload)).toEqual([
        expect.objectContaining({ title: '2 tin từ automation «Nhắc đơn»', summary_count: 2 }),
      ]);
      // Other messages were never written for that user.
      expect(
        (await messagesOf(target.id)).filter((row) => row.group_key?.startsWith('run_')),
      ).toEqual([]);
    });

    it('notifies the person behind the event unless skip_actor', async () => {
      const recordId = await createRecord(
        fx.orders.id,
        { [F('title')]: 'Đơn của reader' },
        'u_admin',
      );
      const event = await db.kysely
        .selectFrom('meta.events')
        // Exact (microseconds), as the dispatcher keeps it.
        .select(['id', sql<string>`created_at::text`.as('created_at')])
        .where('organization_id', '=', fx.orgId)
        .where('entity_id', '=', recordId)
        .where('type', '=', 'record.created')
        .executeTakeFirstOrThrow();
      const ref = { id: event.id, createdAt: event.created_at };
      const recipients = [{ user_ids: [user('u_admin'), user('u_reader')] }];
      const kept = await queuedRun([notify({ recipients })], recordId, { event: ref });
      expect(await execute(kept.runId)).toEqual({ status: 'succeeded' });
      expect((await stepOf(kept.runId))?.output).toMatchObject({ delivered: 2, skipped: [] });
      const skipped = await queuedRun([notify({ recipients, skip_actor: true })], recordId, {
        event: ref,
      });
      expect(await execute(skipped.runId)).toEqual({ status: 'succeeded' });
      expect((await stepOf(skipped.runId))?.output).toMatchObject({
        delivered: 1,
        skipped: [{ user_id: user('u_admin'), reason: 'actor' }],
      });
    });

    it('leaves out users outside the organization (not_member)', async () => {
      const { runId } = await queuedRun(
        [notify({ recipients: [{ user_ids: [user('stranger'), user('u_reader')] }] })],
        r1,
      );
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      expect((await stepOf(runId))?.output).toMatchObject({
        delivered: 1,
        skipped: [{ user_id: user('stranger'), reason: 'not_member' }],
      });
    });

    it('announces notification.created in realtime (p95 < 1 s)', async () => {
      const socket = await TestSocket.connect(url, {
        origin: TEST_PUBLIC_URL,
        cookie: await fx.cookie('u_reader'),
      });
      sockets.push(socket);
      expect(await socket.subscribe(`user:${user('u_reader')}`)).toMatchObject({
        type: 'subscribed',
      });
      const created = (message: RealtimeServerMessage) =>
        message.type === 'notification.created' &&
        message.notification_type === 'automation.message';
      const samples: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        const { runId } = await queuedRun(
          [notify({ recipients: [{ user_ids: [user('u_reader')] }] })],
          r1,
        );
        const started = performance.now();
        expect(await execute(runId)).toEqual({ status: 'succeeded' });
        await socket.next(created);
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      const p95 = samples.at(-1) ?? 0;
      const load = loadavg()[0] ?? 0;
      process.stdout.write(
        `T515 send_notification run → notification.created: p50 ${(samples[2] ?? 0).toFixed(1)} ms, ` +
          `max ${p95.toFixed(1)} ms (5 rounds, load ${load.toFixed(2)})\n`,
      );
      // Latency is only meaningful on an idle machine (BACKLOG S5 conventions).
      if (load < 8) expect(p95).toBeLessThan(1_000);
    });

    it('deletes the messages about a record when it is purged', async () => {
      const recordId = await createRecord(fx.orders.id, { [F('title')]: 'Sắp xoá' });
      const { runId } = await queuedRun(
        [notify({ recipients: [{ user_ids: [user('u_reader')] }] })],
        recordId,
      );
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      expect(await messagesOf(user('u_reader'), runId)).toHaveLength(1);
      const orders = `/tables/${fx.orders.id}/records`;
      expect((await fx.call('u_admin', 'DELETE', orders, { ids: [recordId] })).statusCode).toBe(
        200,
      );
      // In the trash: the message stays.
      expect(await messagesOf(user('u_reader'), runId)).toHaveLength(1);
      const purged = await fx.call('u_admin', 'POST', `${orders}/trash/purge`, {
        ids: [recordId],
      });
      expect(purged.statusCode, purged.body).toBe(200);
      expect(await messagesOf(user('u_reader'), runId)).toEqual([]);
    });
  });

  describe('save (API)', () => {
    const create = (actions: JsonObject[], trigger: JsonObject | null = null) =>
      fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Nhắc',
        definition: {
          trigger: trigger ?? { type: 'record.created', table_id: fx.orders.id },
          actions,
        },
      });

    it('stores a valid step with its defaults', async () => {
      const group = await new GroupsRepository(db).create(scope(), { name: 'Kho' });
      const response = await create([
        notify({ recipients: [{ field: F('owner') }, { group_id: group.id }] }),
      ]);
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json<{ definition: { actions: unknown[] } }>().definition.actions[0]).toEqual(
        {
          id: 'act_note',
          type: 'send_notification',
          config: {
            recipients: [{ field: F('owner') }, { group_id: group.id }],
            title: { template: `Đơn {{ [${F('title')}] }}` },
            body: { template: '' },
            link_record: 'trigger',
            skip_actor: false,
          },
        },
      );
    });

    it.each([
      [
        'REGEX in the body',
        () => [notify({ body: { template: `{{ REGEXEXTRACT([${F('title')}], "a+") }}` } })],
        'definition.actions[0].config.body.template',
        'UNSUPPORTED_FUNCTION',
      ],
      [
        'a user of another organization',
        () => [notify({ recipients: [{ user_ids: [user('stranger')] }] })],
        'definition.actions[0].config.recipients[0].user_ids[0]',
        'USER_NOT_FOUND',
      ],
      [
        'an unknown group',
        () => [notify({ recipients: [{ group_id: 'grp_NoSuchGroup00001' }] })],
        'definition.actions[0].config.recipients[0].group_id',
        'GROUP_NOT_FOUND',
      ],
      [
        'a find_records record in the title',
        () => [
          {
            id: 'act_find',
            type: 'find_records',
            config: { table_id: fx.orders.id, fields: [F('title')] },
          },
          notify({ title: { template: `{{ [act_find].[${F('title')}] }}` } }),
        ],
        'definition.actions[1].config.title.template',
        'UNSUPPORTED_VALUE_SOURCE',
      ],
    ])('refuses %s (422 AUTOMATION_INVALID)', async (_name, actions, path, code) => {
      const response = await create(actions());
      expectProblem(response, 422, 'AUTOMATION_INVALID');
      expect(problemOf(response.body).errors).toEqual([expect.objectContaining({ path, code })]);
    });

    it('refuses a digest key (422 VALIDATION_FAILED)', async () => {
      const step = notify({});
      (step['config'] as JsonObject)['digest'] = { step: 'act_find', row_template: '' };
      expectProblem(await create([step]), 422, 'VALIDATION_FAILED');
    });
  });

  // --- helpers --------------------------------------------------------------------------

  async function systemRole(kind: string): Promise<Id<'rol'>> {
    const row = await db.kysely
      .selectFrom('meta.base_roles')
      .select('id')
      .where('organization_id', '=', fx.orgId)
      .where('base_id', '=', fx.baseId)
      .where('kind', '=', kind as never)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** P35: reads Orders with `amount ≥ 600.000` only, and Customers. */
  async function analystUser(): Promise<SeededUser> {
    const analyst = await seedUser(db, {
      memberships: [{ orgId: fx.orgId, role: 'member' }],
      password: null,
    });
    const role = await fx.call('owner', 'POST', `/bases/${fx.baseId}/roles`, {
      name: 'P35 analysts',
      config: {
        tables: {
          [fx.orders.id]: {
            perm: 'read_only',
            record_rule: {
              read_scope: 'filter',
              read_filter: { field: F('amount'), operator: 'gte', value: 600_000 },
            },
            field_rule: { mode: 'all_read' },
          },
          [fx.customers.id]: { perm: 'read_only', field_rule: { mode: 'all_read' } },
        },
      },
    });
    expect(role.statusCode, role.body).toBe(201);
    const assigned = await fx.call('owner', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: analyst.id,
      role_id: roleSchema.parse(role.json()).id,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    return analyst;
  }

  /** A field through the API; a stored computed field is backfilled (no worker here). */
  async function addField(tableId: Id<'tbl'>, body: object): Promise<FieldDto> {
    const response = await fx.call('owner', 'POST', `/tables/${tableId}/fields`, body);
    expect(response.statusCode, response.body).toBe(201);
    const field = fieldSchema.parse(response.json());
    if (field.compute_state === 'backfilling') {
      let cursor = 0n;
      for (;;) {
        const result = await records.backfillComputedBatch(scope(), {
          fieldId: field.id,
          afterAuto: cursor,
          limit: 1_000,
          statementTimeoutMs: 30_000,
        });
        if (result.status !== 'more') break;
        cursor = result.cursor;
      }
      await t.app.get(SchemaService).finishComputedBackfill(scope(), field.id, { status: 'ready' });
    }
    return field;
  }
});
