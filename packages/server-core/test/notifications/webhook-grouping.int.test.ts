/**
 * BACKLOG T608 (ADR-35 §6; CONTRACTS §22.1–22.2) against PostgreSQL: the
 * writes of an incoming webhook's runs (`via.incoming_webhook_id`) are
 * gathered per (hook, table) over 60 s from the first row — one
 * `record.assigned` per assignee and one `record.followed_changed` per
 * follower each window, with `source` — while user writes and bulk writes
 * keep the S5b behaviour; the S5b hidden-value rules hold through the
 * webhook grouping (a record counts for an assignee only through a `user`
 * field they read on it — QA T559 H1; a follower sees only changes on records
 * they follow **and** read, through fields they read); the send-time check
 * keeps only records still readable; tenant isolation of the groups.
 */
import { newId, type Id } from '@cellhive/contracts';
import { roleConfigSchema, systemRoleConfig, type RoleConfigInput } from '@cellhive/permissions';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { AutomationDispatcher } from '../../src/automation/index.js';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  orgScope,
  UsersRepository,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import { resolveMemberBaseAccess } from '../../src/import/member-access.js';
import {
  FollowedChangeGrouper,
  NotificationBuffer,
  NotificationDeliveryChecker,
  NotificationFanout,
  NotificationFlusher,
  parseWebhookNotificationGroupKey,
  RecordAssignedGrouper,
  RecordFollowsRepository,
  webhookNotificationGroupKey,
  type NotificationFlushOutcome,
  type PendingDelivery,
} from '../../src/notifications/index.js';
import { RecordMutationService, RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { FieldRow, JsonObject, TableRow } from '../../src/db/schema.js';
import type { RecordAccessContext } from '../../src/records/types.js';

const ORG_A: Id<'org'> = 'org_T608HookGroupOrA';
const ORG_B: Id<'org'> = 'org_T608HookGroupOrB';
const DEFAULTS = { timeZone: 'UTC', locale: 'en' };

type UserKey = 'u_reader' | 'u_sales1' | 'u_sales2' | 'u_blind';
type FieldKey = 'title' | 'amount' | 'cost' | 'owner' | 'reviewers' | 'auditors';

describe('notifications of incoming webhook writes (T608)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  const scopeA: OrgScope = orgScope(ORG_A);
  const scopeB: OrgScope = orgScope(ORG_B);
  let query: RecordQueryService;
  let mutation: RecordMutationService;
  let dispatcher: AutomationDispatcher;
  let flusher: NotificationFlusher;
  let follows: RecordFollowsRepository;
  let orders: TableRow;
  let fld: Record<FieldKey, FieldRow>;
  let otherTable: TableRow;
  const users = {} as Record<UserKey, Id<'usr'>>;

  function userAudit(userId: Id<'usr'>): AuditContext {
    const requestId = newId('req');
    return {
      actor: { type: 'user', id: userId },
      via: null,
      batch_id: requestId,
      request_id: requestId,
      ip: null,
      user_agent: 'vitest',
    };
  }

  /** A step of a run started by `hookId` (T604: writes carry `via.incoming_webhook_id`). */
  function hookAudit(hookId: Id<'hok'>, automationId: Id<'aut'> = newId('aut')): AuditContext {
    const runId = newId('run');
    return {
      actor: { type: 'automation', id: automationId },
      via: { automation_id: automationId, run_id: runId, incoming_webhook_id: hookId },
      batch_id: runId,
      request_id: null,
      ip: null,
      user_agent: null,
    };
  }

  async function accessFor(userId: Id<'usr'>): Promise<RecordAccessContext> {
    const resolved = await resolveMemberBaseAccess(
      db,
      scopeA,
      { userId, baseId: a.baseId },
      DEFAULTS,
    );
    if (resolved === undefined) throw new Error(`${userId} has no access`);
    return resolved.record;
  }

  /** Records created in one (bulk) call by the org owner: no follow, no notification. */
  async function createOrders(owners: readonly Id<'usr'>[]): Promise<Id<'rec'>[]> {
    const result = await mutation.create(
      scopeA,
      orders.id,
      await accessFor(a.userId),
      {
        records: owners.map((owner, i) => ({
          fields: { title: `Order ${String(i + 1)}`, owner: [{ id: owner }] },
        })),
      },
      userAudit(a.userId),
      { readBack: true },
    );
    const ids = result.records.map((record) => record.id);
    await dispatchAll();
    return ids;
  }

  async function update(
    records: readonly { id: Id<'rec'>; fields: Record<string, unknown> }[],
    audit: AuditContext,
  ): Promise<void> {
    await mutation.update(scopeA, orders.id, await accessFor(a.userId), { records }, audit, {
      readBack: false,
    });
  }

  /** Runs `events.dispatch` for every event not dispatched yet, in order (the worker's job). */
  async function dispatchAll(): Promise<void> {
    const { rows } = await sql<{ id: Id<'evt'>; org: Id<'org'>; at: string }>`
      SELECT id, organization_id AS org,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
        FROM meta.events
       WHERE dispatched_at IS NULL
       ORDER BY created_at, id
    `.execute(db.kysely);
    for (const row of rows) {
      await dispatcher.dispatch(orgScope(row.org), { id: row.id, createdAt: row.at });
    }
  }

  async function flushJob(kind: 'assigned' | 'followed', groupKey: string) {
    const { rows } = await sql<{ id: string; run_at: Date }>`
      SELECT id::text AS id, run_at FROM graphile_worker.jobs
       WHERE task_identifier = 'notifications.flush' AND key = ${`${kind}:${groupKey}`}
    `.execute(db.kysely);
    return rows;
  }

  /** What the group's `notifications.flush` job does when it runs; the job is removed. */
  async function flush(
    kind: 'assigned' | 'followed',
    groupKey: string,
    organizationId: Id<'org'> = ORG_A,
  ): Promise<NotificationFlushOutcome> {
    const [job] = await flushJob(kind, groupKey);
    const outcome = await flusher.flush(
      { organization_id: organizationId, kind, group_key: groupKey },
      { jobId: job?.id ?? null },
    );
    await sql`DELETE FROM graphile_worker._private_jobs WHERE key = ${`${kind}:${groupKey}`}`.execute(
      db.kysely,
    );
    return outcome;
  }

  async function bufferRows(groupKey: string) {
    return db.kysely
      .selectFrom('meta.notification_buffer')
      .select(['organization_id', 'kind', 'user_id', 'record_id', 'field_ids'])
      .where('group_key', '=', groupKey)
      .orderBy('id')
      .execute();
  }

  async function notices(type: 'record.assigned' | 'record.followed_changed', userId: Id<'usr'>) {
    return db.kysely
      .selectFrom('meta.notifications')
      .select(['entity_type', 'entity_id', 'table_id', 'group_key', 'actor_type', 'payload'])
      .where('organization_id', '=', ORG_A)
      .where('type', '=', type)
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute();
  }

  async function fanoutJobs(): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM graphile_worker.jobs
       WHERE task_identifier = 'notifications.fanout'
    `.execute(db.kysely);
    return rows[0]?.n ?? 0;
  }

  const follow = (recordId: Id<'rec'>, userId: Id<'usr'>) =>
    follows.follow(scopeA, { tableId: orders.id, recordId, userId }, 'manual');

  async function role(name: string, config: RoleConfigInput, members: readonly Id<'usr'>[]) {
    const created = await new BaseRolesRepository(db).create(scopeA, {
      baseId: a.baseId,
      name,
      kind: 'custom',
      config: roleConfigSchema.parse(config) as unknown as JsonObject,
    });
    for (const userId of members) {
      await new BaseRoleMembersRepository(db).assign(scopeA, {
        baseId: a.baseId,
        roleId: created.id,
        principalType: 'user',
        principalId: userId,
      });
    }
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    for (const key of ['u_reader', 'u_sales1', 'u_sales2', 'u_blind'] as const) {
      users[key] = newId('usr');
    }
    await db.kysely
      .insertInto('meta.users')
      .values(
        Object.entries(users).map(([key, id]) => ({
          id,
          email: `${key}.${id.slice(4, 10).toLowerCase()}@t608.test`,
          display_name: key,
        })),
      )
      .execute();
    await db.kysely
      .insertInto('meta.org_members')
      .values([
        { organization_id: ORG_A, user_id: a.userId, role: 'owner' as const },
        { organization_id: ORG_B, user_id: b.userId, role: 'owner' as const },
        ...Object.values(users).map((id) => ({
          organization_id: ORG_A,
          user_id: id,
          role: 'member' as const,
        })),
      ])
      .execute();

    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db);
    mutation = new RecordMutationService(db, { schema, query });
    dispatcher = new AutomationDispatcher(db, { defaults: DEFAULTS, records: query });
    const fanout = new NotificationFanout(db, query, { emailEnabled: true, defaults: DEFAULTS });
    flusher = new NotificationFlusher(db, fanout, [
      new RecordAssignedGrouper(db),
      new FollowedChangeGrouper(db),
    ]);
    follows = new RecordFollowsRepository(db);

    const context = systemAuditContext();
    const created = await schema.createTable(
      scopeA,
      { baseId: a.baseId, name: 'Orders', primaryFieldName: 'title' },
      context,
    );
    orders = created.table;
    const add = (name: string, type: string, options: unknown = {}) =>
      schema.addField(scopeA, orders.id, { name, type, options }, context);
    fld = {
      title: created.primaryField,
      amount: await add('amount', 'number'),
      cost: await add('cost', 'number'),
      owner: await add('owner', 'user', { multiple: false }),
      reviewers: await add('reviewers', 'user', { multiple: true, notify_on_assign: true }),
      auditors: await add('auditors', 'user', { multiple: true, notify_on_assign: true }),
    };
    const schemaMeta = {
      tables: [
        { id: orders.id, fields: Object.values(fld).map((f) => ({ id: f.id, type: f.type })) },
      ],
      dashboards: [],
    };
    const reader = await new BaseRolesRepository(db).create(scopeA, {
      baseId: a.baseId,
      name: 'reader',
      kind: 'system_reader',
      config: systemRoleConfig('reader', schemaMeta) as unknown as JsonObject,
    });
    await new BaseRoleMembersRepository(db).assign(scopeA, {
      baseId: a.baseId,
      roleId: reader.id,
      principalType: 'user',
      principalId: users.u_reader,
    });
    // CONTRACTS §5 Sales: reads the orders it owns; `cost` and `auditors` hidden.
    await role(
      'Sales',
      {
        tables: {
          [orders.id]: {
            perm: 'edit',
            view_rule: { allow_edit: false, visible_views: null },
            record_rule: {
              operations: ['add'],
              edit_filter: {
                op: 'and',
                items: [
                  {
                    field: fld.owner.id,
                    operator: 'has_any_of',
                    value: [{ $var: 'current_user' }],
                  },
                ],
              },
              read_scope: 'editable',
              read_filter: null,
            },
            field_rule: {
              mode: 'specify',
              fields: { [fld.cost.id]: 'no_perm', [fld.auditors.id]: 'no_perm' },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
        },
      },
      [users.u_sales1, users.u_sales2],
    );
    // Reads every record but neither `amount` nor `cost`.
    await role(
      'Blind',
      {
        tables: {
          [orders.id]: {
            perm: 'read_only',
            field_rule: {
              mode: 'specify',
              fields: { [fld.amount.id]: 'no_perm', [fld.cost.id]: 'no_perm' },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
        },
      },
      [users.u_blind],
    );

    otherTable = (
      await schema.createTable(
        scopeB,
        { baseId: b.baseId, name: 'Other', primaryFieldName: 'name' },
        context,
      )
    ).table;
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  beforeEach(async () => {
    await dispatchAll();
  });

  it('parses only its own buffer keys', () => {
    const hook = newId('hok');
    const key = webhookNotificationGroupKey(hook, orders.id);
    expect(key).toBe(`webhook:${hook}:${orders.id}`);
    expect(parseWebhookNotificationGroupKey(key)).toEqual({
      incomingWebhookId: hook,
      tableId: orders.id,
    });
    for (const other of [
      newId('req'),
      newId('rec'),
      `webhook:${hook}`,
      `webhook:${hook}:${orders.id}:x`,
      `webhook:${newId('aut')}:${orders.id}`,
    ]) {
      expect(parseWebhookNotificationGroupKey(other)).toBeNull();
    }
  });

  describe('routing (what is buffered, when it is flushed)', () => {
    it('a webhook write assigning a user is buffered per (hook, table), flushed 60 s after the first row', async () => {
      const hook = newId('hok');
      const key = webhookNotificationGroupKey(hook, orders.id);
      const [r1, r2] = await createOrders([users.u_sales1, users.u_sales1]);
      const before = await fanoutJobs();
      const started = Date.now();
      await update(
        [{ id: r1 as Id<'rec'>, fields: { reviewers: [{ id: users.u_sales1 }] } }],
        hookAudit(hook),
      );
      await dispatchAll();
      const [first] = await flushJob('assigned', key);
      expect(first?.run_at.getTime()).toBeGreaterThanOrEqual(started + 55_000);
      expect(first?.run_at.getTime()).toBeLessThanOrEqual(Date.now() + 61_000);

      await update(
        [{ id: r2 as Id<'rec'>, fields: { reviewers: [{ id: users.u_sales1 }] } }],
        hookAudit(hook),
      );
      await dispatchAll();
      // `from_first`: a later row joins the pending flush without moving it.
      const [second] = await flushJob('assigned', key);
      expect(second?.id).toBe(first?.id);
      expect(second?.run_at.getTime()).toBe(first?.run_at.getTime());
      expect((await bufferRows(key)).map((row) => [row.kind, row.user_id, row.record_id])).toEqual([
        ['assigned', users.u_sales1, r1],
        ['assigned', users.u_sales1, r2],
      ]);
      // Never the single path: no fan-out job.
      expect(await fanoutJobs()).toBe(before);
      await flush('assigned', key);
    });

    it('a webhook change to a followed record is buffered per (hook, table), not per record', async () => {
      const hook = newId('hok');
      const key = webhookNotificationGroupKey(hook, orders.id);
      const [r1] = (await createOrders([users.u_sales1])) as [Id<'rec'>];
      await follow(r1, users.u_reader);
      const started = Date.now();
      await update([{ id: r1, fields: { amount: 5 } }], hookAudit(hook));
      await dispatchAll();
      expect(await bufferRows(r1)).toEqual([]);
      expect((await bufferRows(key)).map((row) => [row.kind, row.record_id])).toEqual([
        ['followed', r1],
      ]);
      const [job] = await flushJob('followed', key);
      expect(job?.run_at.getTime()).toBeGreaterThanOrEqual(started + 55_000);
      await flush('followed', key);
    });

    it('a bulk webhook write keeps the S5b grouping (batch.id; followers not told)', async () => {
      const hook = newId('hok');
      const key = webhookNotificationGroupKey(hook, orders.id);
      const [r1, r2] = (await createOrders([users.u_sales1, users.u_sales1])) as [
        Id<'rec'>,
        Id<'rec'>,
      ];
      await follow(r1, users.u_reader);
      const audit = hookAudit(hook);
      const batchId = audit.batch_id ?? expect.fail('no batch id');
      await update(
        [
          { id: r1, fields: { reviewers: [{ id: users.u_sales1 }], amount: 1 } },
          { id: r2, fields: { reviewers: [{ id: users.u_sales1 }], amount: 1 } },
        ],
        audit,
      );
      await dispatchAll();
      expect(await bufferRows(key)).toEqual([]);
      expect(await bufferRows(r1)).toEqual([]);
      const batch = await bufferRows(batchId);
      // One bulk write: its events share a time, dispatched in id order (any order).
      expect(batch.map((row) => [row.kind, row.record_id]).sort()).toEqual(
        [
          ['assigned', r1],
          ['assigned', r2],
        ].sort(),
      );
      await flush('assigned', batchId);
      const [notice] = (await notices('record.assigned', users.u_sales1)).filter(
        (row) => (row.payload as JsonObject).batch_id === batchId,
      );
      expect(notice?.payload).toMatchObject({ batch_id: batchId, count: 2 });
      expect(notice?.payload).not.toHaveProperty('source');
    });

    it('a user write keeps the single path (a fan-out job now, nothing buffered)', async () => {
      const [r1] = (await createOrders([users.u_sales1])) as [Id<'rec'>];
      const before = await fanoutJobs();
      await update(
        [{ id: r1, fields: { reviewers: [{ id: users.u_reader }] } }],
        userAudit(a.userId),
      );
      await dispatchAll();
      expect(await fanoutJobs()).toBe(before + 1);
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM meta.notification_buffer
         WHERE record_id = ${r1} AND kind = 'assigned'
      `.execute(db.kysely);
      expect(rows[0]?.n).toBe(0);
      await sql`DELETE FROM graphile_worker._private_jobs p USING graphile_worker._private_tasks t
                 WHERE t.id = p.task_id AND t.identifier = 'notifications.fanout'`.execute(
        db.kysely,
      );
    });
  });

  describe('record.assigned from a webhook (P52)', () => {
    it('200 webhook writes assigning u_sales1 → one notification per window, count of readable records only', async () => {
      const hook = newId('hok');
      const key = webhookNotificationGroupKey(hook, orders.id);
      const automationId = newId('aut');
      const owned = await createOrders(Array.from({ length: 200 }, () => users.u_sales1));
      // r2: not readable by u_sales1 (owned by u_sales2); r3: readable, but
      // u_sales1 is added only to `auditors`, a field hidden from them.
      const [r2, r3] = (await createOrders([users.u_sales2, users.u_sales1])) as [
        Id<'rec'>,
        Id<'rec'>,
      ];
      for (const id of owned) {
        await update(
          [{ id, fields: { reviewers: [{ id: users.u_sales1 }] } }],
          hookAudit(hook, automationId),
        );
      }
      await update(
        [{ id: r2, fields: { reviewers: [{ id: users.u_sales1 }] } }],
        hookAudit(hook, automationId),
      );
      await update(
        [{ id: r3, fields: { auditors: [{ id: users.u_sales1 }] } }],
        hookAudit(hook, automationId),
      );
      // Re-assigning the same record in the window does not count it twice.
      const firstOwned = owned[0] as Id<'rec'>;
      await update([{ id: firstOwned, fields: { reviewers: [] } }], hookAudit(hook, automationId));
      await update(
        [{ id: firstOwned, fields: { reviewers: [{ id: users.u_sales1 }] } }],
        hookAudit(hook, automationId),
      );
      await dispatchAll();
      expect(await flushJob('assigned', key)).toHaveLength(1);

      const outcome = await flush('assigned', key);
      expect(outcome).toMatchObject({ status: 'flushed', recorded: 1 });
      const list = (await notices('record.assigned', users.u_sales1)).filter((row) =>
        row.group_key?.startsWith(`${key}:`),
      );
      expect(list).toHaveLength(1);
      const [notice] = list;
      expect(notice).toMatchObject({
        entity_type: 'table',
        entity_id: orders.id,
        table_id: orders.id,
        actor_type: 'automation',
      });
      const payload = notice?.payload as {
        batch_id: unknown;
        count: number;
        record_ids: string[];
        field_ids: string[];
        source: unknown;
      };
      expect(payload.batch_id).toBeNull();
      expect(payload.count).toBe(200);
      expect(payload.record_ids).toEqual(owned.slice(0, 20));
      expect(payload.field_ids).toEqual([fld.reviewers.id]);
      expect(payload.source).toEqual({ incoming_webhook_id: hook });
      expect(JSON.stringify(notice)).not.toContain(r2);
      expect(JSON.stringify(notice)).not.toContain(r3);
      expect(JSON.stringify(notice)).not.toContain(fld.auditors.id);

      // Followed: exactly the records counted (not r2, not r3).
      const followed = await db.kysely
        .selectFrom('meta.record_follows')
        .select('record_id')
        .where('organization_id', '=', ORG_A)
        .where('user_id', '=', users.u_sales1)
        .where('record_id', 'in', [...owned, r2, r3])
        .execute();
      expect(new Set(followed.map((row) => row.record_id))).toEqual(new Set(owned));

      // The next window gets its own notification.
      await update(
        [{ id: r3, fields: { reviewers: [{ id: users.u_sales1 }] } }],
        hookAudit(hook, automationId),
      );
      await dispatchAll();
      await flush('assigned', key);
      const after = (await notices('record.assigned', users.u_sales1)).filter((row) =>
        row.group_key?.startsWith(`${key}:`),
      );
      expect(after).toHaveLength(2);
      expect(after[1]?.group_key).not.toBe(after[0]?.group_key);
      expect(after[1]?.payload).toMatchObject({ count: 1, record_ids: [r3] });
    }, 120_000);

    it('two hooks writing the same table are two groups', async () => {
      const [h1, h2] = [newId('hok'), newId('hok')];
      const [r1, r2] = (await createOrders([users.u_sales1, users.u_sales1])) as [
        Id<'rec'>,
        Id<'rec'>,
      ];
      await update([{ id: r1, fields: { reviewers: [{ id: users.u_sales1 }] } }], hookAudit(h1));
      await update([{ id: r2, fields: { reviewers: [{ id: users.u_sales1 }] } }], hookAudit(h2));
      await dispatchAll();
      for (const [hook, record] of [
        [h1, r1],
        [h2, r2],
      ] as const) {
        const key = webhookNotificationGroupKey(hook, orders.id);
        await flush('assigned', key);
        const [notice] = (await notices('record.assigned', users.u_sales1)).filter((row) =>
          row.group_key?.startsWith(`${key}:`),
        );
        expect(notice?.payload).toMatchObject({
          count: 1,
          record_ids: [record],
          source: { incoming_webhook_id: hook },
        });
      }
    });
  });

  describe('record.followed_changed from a webhook', () => {
    it('one notification per follower: records they follow and read, changes through fields they read', async () => {
      const hook = newId('hok');
      const key = webhookNotificationGroupKey(hook, orders.id);
      const [f1, f2, f3, f5] = (await createOrders([
        users.u_sales1,
        users.u_sales2,
        users.u_sales1,
        users.u_sales2,
      ])) as [Id<'rec'>, Id<'rec'>, Id<'rec'>, Id<'rec'>];
      await follow(f1, users.u_reader);
      await follow(f3, users.u_reader);
      // u_blind follows f1 only (reads neither `amount` nor `cost`).
      await follow(f1, users.u_blind);
      // u_sales1 follows f5 only, which they cannot read.
      await follow(f5, users.u_sales1);
      // f2 has no follower among them, but a follower so that its changes are buffered.
      await follow(f2, users.u_sales2);

      const automationId = newId('aut');
      // 30 changes on 3 records in the window …
      for (let i = 0; i < 10; i += 1) {
        for (const id of [f1, f2, f3]) {
          await update([{ id, fields: { amount: i } }], hookAudit(hook, automationId));
        }
      }
      // … a title change on f2 (u_blind reads titles but does not follow f2),
      // a title change on f5 (u_sales1 follows it but cannot read it),
      // a `cost` change on f1 (hidden from u_blind).
      await update([{ id: f2, fields: { title: 'Renamed F2' } }], hookAudit(hook, automationId));
      await update([{ id: f5, fields: { title: 'Renamed F5' } }], hookAudit(hook, automationId));
      await update([{ id: f1, fields: { cost: 9 } }], hookAudit(hook, automationId));
      await dispatchAll();
      for (const id of [f1, f2, f3, f5]) expect(await bufferRows(id)).toEqual([]);

      const outcome = await flush('followed', key);
      expect(outcome.status).toBe('flushed');
      const ofWindow = async (userId: Id<'usr'>) =>
        (await notices('record.followed_changed', userId)).filter((row) =>
          row.group_key?.startsWith(`${key}:`),
        );
      const [reader, ...moreReader] = await ofWindow(users.u_reader);
      expect(moreReader).toEqual([]);
      expect(reader).toMatchObject({
        entity_type: 'table',
        entity_id: orders.id,
        actor_type: 'automation',
      });
      expect(reader?.group_key?.startsWith(`${key}:`)).toBe(true);
      expect(reader?.payload).toEqual({
        field_ids: [fld.amount.id, fld.cost.id],
        change_count: 21,
        actor_ids: [],
        record_ids: [f1, f3],
        record_count: 2,
        source: { incoming_webhook_id: hook },
      });
      // u_blind: f1's changes touched only hidden fields; f2's title is not theirs.
      expect(await ofWindow(users.u_blind)).toEqual([]);
      // u_sales1: follows only f5, which they cannot read.
      expect(await ofWindow(users.u_sales1)).toEqual([]);
      // u_sales2 follows f2 and reads it (owner): `cost` is hidden, f5 not followed.
      const [sales2] = await ofWindow(users.u_sales2);
      expect(sales2?.payload).toMatchObject({
        field_ids: [fld.amount.id, fld.title.id],
        change_count: 11,
        record_ids: [f2],
        record_count: 1,
      });
    }, 120_000);
  });

  describe('send-time check (email/Telegram)', () => {
    it('lists only the records still readable; none readable → dropped', async () => {
      const [own, other] = (await createOrders([users.u_sales1, users.u_sales2])) as [
        Id<'rec'>,
        Id<'rec'>,
      ];
      const hook = newId('hok');
      const row = (n: number, recordIds: Id<'rec'>[]): PendingDelivery => ({
        notification_id: `ntf_T608Check000000${String(n)}`,
        attempts: 0,
        queued_at: new Date(),
        type: 'record.followed_changed',
        base_id: a.baseId,
        table_id: orders.id,
        entity_type: 'table',
        entity_id: orders.id,
        payload: {
          field_ids: [fld.amount.id],
          change_count: 4,
          actor_ids: [],
          record_ids: recordIds,
          record_count: recordIds.length,
          source: { incoming_webhook_id: hook },
        },
        created_at: new Date(),
      });
      const assigned: PendingDelivery = {
        ...row(3, [own]),
        type: 'record.assigned',
        payload: {
          batch_id: null,
          count: 1,
          record_ids: [own],
          field_ids: [fld.reviewers.id],
          source: { incoming_webhook_id: hook },
        },
      };
      const user = await new UsersRepository(db).findById(users.u_sales1);
      const checker = new NotificationDeliveryChecker(db, query, {
        publicUrl: 'https://cellhive.test',
        defaults: DEFAULTS,
      });
      // `record.followed_changed` email/Telegram are off by default: turn them on.
      await db.kysely
        .insertInto('meta.notification_preferences')
        .values(
          (['email', 'telegram'] as const).map((channel) => ({
            organization_id: ORG_A,
            user_id: users.u_sales1,
            type: 'record.followed_changed',
            channel,
            enabled: true,
          })),
        )
        .execute();
      for (const channel of ['email', 'telegram'] as const) {
        const result = await checker.check(
          scopeA,
          user ?? expect.fail('no user'),
          [row(1, [own, other]), row(2, [other]), assigned],
          channel,
        );
        expect(result.dropped.get('cannot_read_record')?.map((r) => r.notification_id)).toEqual([
          'ntf_T608Check0000002',
        ]);
        const [followedItem, assignedItem] = result.kept.map((kept) => kept.item);
        expect(followedItem).toMatchObject({
          type: 'record.followed_changed',
          viaWebhook: true,
          recordCount: 2,
          changeCount: 4,
          records: [{ title: expect.any(String) as unknown }],
        });
        expect(JSON.stringify(followedItem)).not.toContain(other);
        expect(assignedItem).toMatchObject({ type: 'record.assigned', viaWebhook: true, count: 1 });
      }
    });
  });

  describe('tenant isolation', () => {
    it("a flush of one organization never reads or deletes another's webhook group", async () => {
      const hook = newId('hok');
      const keyB = webhookNotificationGroupKey(hook, otherTable.id);
      const accessB = await resolveMemberBaseAccess(
        db,
        scopeB,
        { userId: b.userId, baseId: b.baseId },
        DEFAULTS,
      );
      const createdB = await mutation.create(
        scopeB,
        otherTable.id,
        accessB?.record ?? expect.fail('no access in org B'),
        { records: [{ fields: { name: 'B1' } }] },
        userAudit(b.userId),
        { readBack: true },
      );
      const rowB = createdB.records[0]?.id as Id<'rec'>;
      await db.withTx((tx) =>
        new NotificationBuffer(db).append(tx, {
          organizationId: ORG_B,
          kind: 'assigned',
          groupKey: keyB,
          rows: [
            { userId: b.userId, tableId: otherTable.id, recordId: rowB, fieldIds: [], actor: null },
          ],
          delayMs: 60_000,
        }),
      );
      expect(
        await flusher.flush({ organization_id: ORG_A, kind: 'assigned', group_key: keyB }),
      ).toEqual({
        status: 'empty',
      });
      expect((await bufferRows(keyB)).map((row) => row.organization_id)).toEqual([ORG_B]);
      await flush('assigned', keyB, ORG_B);
      expect(await bufferRows(keyB)).toEqual([]);
    });
  });
});
