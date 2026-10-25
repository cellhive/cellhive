/**
 * BACKLOG T545 (ADR-29 §1, ADR-34 §2; CONTRACTS §22.1–22.2): the producer of
 * `record.followed_changed` against PostgreSQL — `FollowedChangeListener`
 * called by `events.dispatch` for each event (single `record.updated` only:
 * not bulk, not recomputed values, fields still there and not computed, a
 * record somebody follows), the 60 s debounced group per record, and
 * `FollowedChangeGrouper` behind `notifications.flush` (followers now, every
 * actor of the group left out, per-recipient record and field access,
 * `field_ids`/`change_count`/`actor_ids`/`actor` from the changes each
 * recipient may see, preferences and base mutes, the follower cap, the
 * `group_key` of the flush job), P39 and tenant isolation.
 */
import { NOTIFICATION_FOLLOWERS_MAX, newId, type Id } from '@cellhive/contracts';
import { roleConfigSchema, systemRoleConfig, type RoleConfigInput } from '@cellhive/permissions';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { AutomationDispatcher } from '../../src/automation/index.js';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  orgScope,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import { resolveMemberBaseAccess } from '../../src/import/member-access.js';
import {
  FollowedChangeGrouper,
  FollowedChangeListener,
  NotificationBaseMutesRepository,
  NotificationFanout,
  NotificationFlusher,
  NotificationPreferencesRepository,
  RecordFollowsRepository,
  type FollowedChangeOutcome,
  type NotificationFlushOutcome,
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
import type { EventDocument } from '../../src/events/event.js';
import type { RecordAccessContext } from '../../src/records/types.js';

const ORG_A: Id<'org'> = 'org_T545FollowedOrgA';
const ORG_B: Id<'org'> = 'org_T545FollowedOrgB';
const DEFAULTS = { timeZone: 'UTC', locale: 'en' };

type UserKey = 'u_editor' | 'u_reader' | 'u_sales1' | 'u_sales2' | 'u_blind';

describe('record.followed_changed (T545)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  const scopeA: OrgScope = orgScope(ORG_A);
  const scopeB: OrgScope = orgScope(ORG_B);
  let schema: SchemaService;
  let mutation: RecordMutationService;
  let dispatcher: AutomationDispatcher;
  let flusher: NotificationFlusher;
  let follows: RecordFollowsRepository;
  let orders: TableRow;
  let fld: Record<'title' | 'amount' | 'cost' | 'owner', FieldRow>;
  let otherTable: TableRow;
  let otherTitle: FieldRow;
  const users = {} as Record<UserKey, Id<'usr'>>;
  let userB: Id<'usr'>;
  let salesRole: Id<'rol'>;
  let jobSeq = 0;

  function auditOf(userId: Id<'usr'>, via: AuditContext['via'] = null): AuditContext {
    const requestId = newId('req');
    return {
      actor: { type: 'user', id: userId },
      via,
      batch_id: requestId,
      request_id: requestId,
      ip: null,
      user_agent: 'vitest',
    };
  }

  function automationAudit(): AuditContext {
    const automationId = newId('aut');
    const runId = newId('run');
    return {
      actor: { type: 'automation', id: automationId },
      via: { automation_id: automationId, run_id: runId },
      batch_id: runId,
      request_id: null,
      ip: null,
      user_agent: null,
    };
  }

  async function accessFor(
    userId: Id<'usr'>,
    scope: OrgScope = scopeA,
    baseId: Id<'bse'> = a.baseId,
  ): Promise<RecordAccessContext> {
    const resolved = await resolveMemberBaseAccess(db, scope, { userId, baseId }, DEFAULTS);
    if (resolved === undefined) throw new Error(`${userId} has no access`);
    return resolved.record;
  }

  async function createOrder(title: string, owner: Id<'usr'>): Promise<Id<'rec'>> {
    const result = await mutation.create(
      scopeA,
      orders.id,
      await accessFor(a.userId),
      { records: [{ fields: { title, owner: [{ id: owner }] } }] },
      auditOf(a.userId),
    );
    return result.records[0]?.id as Id<'rec'>;
  }

  async function update(
    userId: Id<'usr'>,
    records: readonly { id: Id<'rec'>; fields: Record<string, unknown> }[],
    audit: AuditContext = auditOf(userId),
  ): Promise<void> {
    await mutation.update(scopeA, orders.id, await accessFor(userId), { records }, audit, {
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

  async function bufferRows(recordId: Id<'rec'>) {
    return db.kysely
      .selectFrom('meta.notification_buffer')
      .select([
        'organization_id',
        'kind',
        'group_key',
        'user_id',
        'table_id',
        'record_id',
        'field_ids',
        'actor_type',
        'actor_id',
      ])
      .where('record_id', '=', recordId)
      .orderBy('id')
      .execute();
  }

  async function flushJob(recordId: Id<'rec'>) {
    const { rows } = await sql<{ id: string; run_at: Date; payload: JsonObject }>`
      SELECT jobs.id::text AS id, jobs.run_at, p.payload
        FROM graphile_worker.jobs JOIN graphile_worker._private_jobs p USING (id)
       WHERE jobs.task_identifier = 'notifications.flush' AND jobs.key = ${`followed:${recordId}`}
    `.execute(db.kysely);
    return rows;
  }

  /** What the `notifications.flush` job of the record's group does when it runs. */
  async function flush(
    recordId: Id<'rec'>,
    organizationId: Id<'org'> = ORG_A,
  ): Promise<NotificationFlushOutcome & { jobId: string }> {
    const [job] = await flushJob(recordId);
    const jobId = job?.id ?? `t${String((jobSeq += 1))}`;
    const outcome = await flusher.flush(
      { organization_id: organizationId, kind: 'followed', group_key: recordId },
      { jobId },
    );
    await sql`DELETE FROM graphile_worker._private_jobs WHERE key = ${`followed:${recordId}`}`.execute(
      db.kysely,
    );
    return { ...outcome, jobId };
  }

  async function notificationsOf(recordId: Id<'rec'>) {
    return db.kysely
      .selectFrom('meta.notifications')
      .select([
        'organization_id',
        'user_id',
        'type',
        'base_id',
        'table_id',
        'entity_type',
        'entity_id',
        'actor_type',
        'actor_id',
        'group_key',
        'payload',
      ])
      .where('type', '=', 'record.followed_changed')
      .where('entity_id', '=', recordId)
      .orderBy('created_at')
      .orderBy('user_id')
      .execute();
  }

  const follow = (recordId: Id<'rec'>, userId: Id<'usr'>, scope: OrgScope = scopeA) =>
    follows.follow(scope, { tableId: orders.id, recordId, userId }, 'manual');

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
    return created.id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    userB = b.userId;
    for (const key of ['u_editor', 'u_reader', 'u_sales1', 'u_sales2', 'u_blind'] as const) {
      users[key] = newId('usr');
    }
    await db.kysely
      .insertInto('meta.users')
      .values(
        Object.entries(users).map(([key, id]) => ({
          id,
          email: `${key}.${id.slice(4, 10).toLowerCase()}@t545.test`,
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

    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const query = new RecordQueryService(db);
    mutation = new RecordMutationService(db, { schema, query });
    dispatcher = new AutomationDispatcher(db, { defaults: DEFAULTS, records: query });
    const fanout = new NotificationFanout(db, query, { emailEnabled: true, defaults: DEFAULTS });
    flusher = new NotificationFlusher(db, fanout, [new FollowedChangeGrouper(db)]);
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
    };
    const schemaMeta = {
      tables: [
        { id: orders.id, fields: Object.values(fld).map((f) => ({ id: f.id, type: f.type })) },
      ],
      dashboards: [],
    };
    for (const [kind, preset, userId] of [
      ['system_editor', 'editor', users.u_editor],
      ['system_reader', 'reader', users.u_reader],
    ] as const) {
      const created = await new BaseRolesRepository(db).create(scopeA, {
        baseId: a.baseId,
        name: preset,
        kind,
        config: systemRoleConfig(preset, schemaMeta) as unknown as JsonObject,
      });
      await new BaseRoleMembersRepository(db).assign(scopeA, {
        baseId: a.baseId,
        roleId: created.id,
        principalType: 'user',
        principalId: userId,
      });
    }
    // CONTRACTS §5 Sales: reads/edits the orders it owns, `cost` hidden.
    salesRole = await role(
      'Sales',
      {
        base_rule: { copy: false, download: false, share_link: false },
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
              fields: { [fld.cost.id]: 'no_perm' },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
        },
        dashboards: {},
      },
      [users.u_sales1, users.u_sales2],
    );
    // Reads every record but none of `amount`, `cost` (only title + owner).
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

    const createdB = await schema.createTable(
      scopeB,
      { baseId: b.baseId, name: 'Other', primaryFieldName: 'name' },
      context,
    );
    otherTable = createdB.table;
    otherTitle = createdB.primaryField;
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  beforeEach(async () => {
    // Events of the previous test's setup are not this test's business.
    await dispatchAll();
  });

  describe('FollowedChangeListener (what is buffered)', () => {
    let r1: Id<'rec'>;

    beforeAll(async () => {
      r1 = await createOrder('Listener R1', users.u_sales1);
      await follow(r1, users.u_reader);
    });

    const event = (overrides: Partial<EventDocument> = {}): EventDocument => ({
      id: newId('evt'),
      type: 'record.updated',
      organization_id: ORG_A,
      base_id: a.baseId,
      table_id: orders.id,
      entity_type: 'record',
      entity_id: r1,
      actor: { type: 'user', id: users.u_editor },
      changes: { [fld.amount.id]: { from: 1, to: 2 } },
      causation: { root_event_id: newId('evt'), depth: 0, automation_chain: [] },
      created_at: new Date().toISOString(),
      ...overrides,
    });

    const cases: readonly {
      name: string;
      event: () => EventDocument;
      outcome: FollowedChangeOutcome;
    }[] = [
      { name: 'a single update', event: () => event(), outcome: 'buffered' },
      {
        name: 'a single update of a batch of one',
        event: () => event({ batch: { id: newId('req'), size: 1 } }),
        outcome: 'buffered',
      },
      {
        name: 'an automation step changing one record',
        event: () =>
          event({
            actor: { type: 'automation', id: newId('aut') },
            batch: { id: newId('run'), size: 1 },
            via: { automation_id: newId('aut'), run_id: newId('run') },
          }),
        outcome: 'buffered',
      },
      {
        name: 'record.created',
        event: () => event({ type: 'record.created' }),
        outcome: 'not_record_update',
      },
      {
        name: 'record.deleted',
        event: () => event({ type: 'record.deleted' }),
        outcome: 'not_record_update',
      },
      {
        name: 'record.restored',
        event: () => event({ type: 'record.restored' }),
        outcome: 'not_record_update',
      },
      {
        name: 'an event without table',
        event: () => {
          const withoutTable: EventDocument = { ...event() };
          delete (withoutTable as { table_id?: Id<'tbl'> }).table_id;
          return withoutTable;
        },
        outcome: 'not_record_update',
      },
      {
        name: 'a bulk update (two records in one call)',
        event: () => event({ batch: { id: newId('req'), size: 2 } }),
        outcome: 'bulk',
      },
      {
        name: 'a paste of 200 rows',
        event: () => event({ batch: { id: newId('req'), size: 200 } }),
        outcome: 'bulk',
      },
      {
        name: 'an import',
        event: () =>
          event({ batch: { id: newId('job'), size: 1 }, via: { import_job_id: newId('job') } }),
        outcome: 'bulk',
      },
      {
        name: 'values recomputed in the write itself',
        event: () =>
          event({
            actor: { type: 'system', id: null },
            batch: { id: newId('req'), size: 1 },
            via: { computed_recompute: true, job_id: null },
          }),
        outcome: 'computed',
      },
      {
        name: 'values recomputed by computed.recompute',
        event: () =>
          event({
            actor: { type: 'system', id: null },
            batch: { id: newId('job'), size: 1 },
            via: { computed_recompute: true, job_id: newId('job') },
          }),
        outcome: 'computed',
      },
      { name: 'no changes', event: () => event({ changes: {} }), outcome: 'no_fields' },
      {
        name: 'changes on a field that does not exist',
        event: () => event({ changes: { [newId('fld')]: { from: null, to: 1 } } }),
        outcome: 'no_fields',
      },
    ];

    it.each(cases)('$name → $outcome', async ({ event: build, outcome }) => {
      const before = (await bufferRows(r1)).length;
      const result = await db.withTx((tx) =>
        new FollowedChangeListener(db).onEvent(orgScope(ORG_A, tx), build()),
      );
      expect(result).toBe(outcome);
      expect((await bufferRows(r1)).length).toBe(before + (outcome === 'buffered' ? 1 : 0));
      await flush(r1);
    });

    it('buffers ids only: the live, non-computed changed fields and the actor; one debounced flush', async () => {
      const deleted = await schema.addField(
        scopeA,
        orders.id,
        { name: 'gone', type: 'text', options: {} },
        systemAuditContext(),
      );
      await schema.deleteField(scopeA, deleted.id, systemAuditContext());
      const formula = await schema.addField(
        scopeA,
        orders.id,
        { name: 'double', type: 'formula', options: { expression: '[amount] * 2' } },
        systemAuditContext(),
      );
      const now = new Date('2026-10-17T03:00:00.000Z');
      const listener = new FollowedChangeListener(db, { buffer: { now: () => now } });
      await db.withTx((tx) =>
        listener.onEvent(
          orgScope(ORG_A, tx),
          event({
            changes: {
              [fld.amount.id]: { from: 1, to: 2 },
              [deleted.id]: { from: 'a', to: 'b' },
              [formula.id]: { from: 2, to: 4 },
              [fld.cost.id]: { from: null, to: 5 },
            },
          }),
        ),
      );
      expect(await bufferRows(r1)).toEqual([
        {
          organization_id: ORG_A,
          kind: 'followed',
          group_key: r1,
          user_id: null,
          table_id: orders.id,
          record_id: r1,
          field_ids: [fld.amount.id, fld.cost.id],
          actor_type: 'user',
          actor_id: users.u_editor,
        },
      ]);
      const [job] = await flushJob(r1);
      expect(job?.payload).toEqual({ organization_id: ORG_A, kind: 'followed', group_key: r1 });
      expect(job?.run_at.toISOString()).toBe('2026-10-17T03:01:00.000Z');

      // A later change joins the pending flush (preserve_run_at): the window is not extended.
      const later = new Date('2026-10-17T03:00:30.000Z');
      expect(
        await db.withTx((tx) =>
          new FollowedChangeListener(db, { buffer: { now: () => later } }).onEvent(
            orgScope(ORG_A, tx),
            event({ changes: { [formula.id]: { from: 4, to: 6 } } }),
          ),
        ),
      ).toBe('no_fields');
      await db.withTx((tx) =>
        new FollowedChangeListener(db, { buffer: { now: () => later } }).onEvent(
          orgScope(ORG_A, tx),
          event({ actor: { type: 'system', id: null } }),
        ),
      );
      const jobs = await flushJob(r1);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.run_at.toISOString()).toBe('2026-10-17T03:01:00.000Z');
      expect((await bufferRows(r1)).map((row) => [row.actor_type, row.actor_id])).toEqual([
        ['user', users.u_editor],
        [null, null],
      ]);
      await flush(r1);
      await schema.deleteField(scopeA, formula.id, systemAuditContext());
    });

    it('buffers nothing for a record nobody follows (muted rows do not count)', async () => {
      const lonely = await createOrder('Nobody follows', users.u_sales1);
      await follow(lonely, users.u_reader);
      await follows.unfollow(scopeA, {
        tableId: orders.id,
        recordId: lonely,
        userId: users.u_reader,
      });
      expect(
        await db.withTx((tx) =>
          new FollowedChangeListener(db).onEvent(orgScope(ORG_A, tx), event({ entity_id: lonely })),
        ),
      ).toBe('no_followers');
      expect(await bufferRows(lonely)).toEqual([]);
      expect(await flushJob(lonely)).toEqual([]);
    });

    it('needs the dispatch transaction', async () => {
      await expect(new FollowedChangeListener(db).onEvent(scopeA, event())).rejects.toThrow(
        TypeError,
      );
    });
  });

  describe('through events.dispatch and notifications.flush (P39)', () => {
    let r1: Id<'rec'>;
    let r2: Id<'rec'>;

    beforeAll(async () => {
      // r1: owner u_sales1 (Sales reads it); r2: owner u_sales2 (u_sales1 cannot read it).
      r1 = await createOrder('Đơn R1', users.u_sales1);
      r2 = await createOrder('Đơn R2', users.u_sales2);
      await dispatchAll();
      await follow(r1, users.u_sales1);
    });

    it('creating a record notifies nobody; every dispatched event is marked once', async () => {
      expect(await bufferRows(r1)).toEqual([]);
      expect(await notificationsOf(r1)).toEqual([]);
    });

    it('u_editor changes r1.cost → u_sales1 (cannot read cost) gets nothing', async () => {
      await update(users.u_editor, [{ id: r1, fields: { cost: 10 } }]);
      await dispatchAll();
      expect(await bufferRows(r1)).toHaveLength(1);
      const outcome = await flush(r1);
      expect(outcome).toMatchObject({
        status: 'flushed',
        rows: 1,
        requests: 1,
        recorded: 0,
        skipped: { cannot_read_field: 1 },
      });
      expect(await notificationsOf(r1)).toEqual([]);
      expect(await bufferRows(r1)).toEqual([]);
    });

    it('u_editor changes r1.amount → u_sales1 is told, data.field_ids = [amount]', async () => {
      await update(users.u_editor, [{ id: r1, fields: { amount: 900 } }]);
      await dispatchAll();
      const outcome = await flush(r1);
      expect(outcome).toMatchObject({ status: 'flushed', recorded: 1, skipped: {} });
      expect(await notificationsOf(r1)).toEqual([
        {
          organization_id: ORG_A,
          user_id: users.u_sales1,
          type: 'record.followed_changed',
          base_id: a.baseId,
          table_id: orders.id,
          entity_type: 'record',
          entity_id: r1,
          actor_type: 'user',
          actor_id: users.u_editor,
          group_key: `${r1}:${outcome.jobId}`,
          payload: { field_ids: [fld.amount.id], change_count: 1, actor_ids: [users.u_editor] },
        },
      ]);
      await sql`DELETE FROM meta.notifications WHERE entity_id = ${r1}`.execute(db.kysely);
    });

    it('amount + cost in one change → field_ids = [amount] for u_sales1, both for u_reader', async () => {
      await follow(r1, users.u_reader);
      await update(users.u_editor, [{ id: r1, fields: { amount: 901, cost: 11 } }]);
      await dispatchAll();
      await flush(r1);
      const rows = await notificationsOf(r1);
      expect(Object.fromEntries(rows.map((row) => [row.user_id, row.payload]))).toEqual({
        [users.u_sales1]: {
          field_ids: [fld.amount.id],
          change_count: 1,
          actor_ids: [users.u_editor],
        },
        [users.u_reader]: {
          field_ids: [fld.amount.id, fld.cost.id],
          change_count: 1,
          actor_ids: [users.u_editor],
        },
      });
      await follows.unfollow(scopeA, { tableId: orders.id, recordId: r1, userId: users.u_reader });
      await sql`DELETE FROM meta.notifications WHERE entity_id = ${r1}`.execute(db.kysely);
    });

    it('5 changes within 30 s → one notification, change_count = 5; a re-run writes nothing twice', async () => {
      for (let i = 0; i < 5; i += 1) {
        await update(users.u_editor, [{ id: r1, fields: { amount: 1000 + i } }]);
      }
      await dispatchAll();
      expect(await bufferRows(r1)).toHaveLength(5);
      expect(await flushJob(r1)).toHaveLength(1);
      const outcome = await flush(r1);
      expect(outcome).toMatchObject({ status: 'flushed', rows: 5, requests: 1, recorded: 1 });
      expect((await notificationsOf(r1)).map((row) => [row.user_id, row.payload])).toEqual([
        [
          users.u_sales1,
          { field_ids: [fld.amount.id], change_count: 5, actor_ids: [users.u_editor] },
        ],
      ]);

      // The same flush job again (a retry after its commit was lost): nothing new.
      await update(users.u_editor, [{ id: r1, fields: { amount: 2000 } }]);
      await dispatchAll();
      const again = await flusher.flush(
        { organization_id: ORG_A, kind: 'followed', group_key: r1 },
        { jobId: outcome.jobId },
      );
      expect(again).toMatchObject({ status: 'flushed', rows: 1, recorded: 0 });
      expect(await notificationsOf(r1)).toHaveLength(1);
      await sql`DELETE FROM graphile_worker._private_jobs WHERE key = ${`followed:${r1}`}`.execute(
        db.kysely,
      );
      await sql`DELETE FROM meta.notifications WHERE entity_id = ${r1}`.execute(db.kysely);
    });

    it('the follower who made the change is not told; any actor of the window is left out', async () => {
      await follow(r1, users.u_reader);
      // Only u_sales1's own change: u_sales1 nothing, u_reader told.
      await update(users.u_sales1, [{ id: r1, fields: { amount: 3000 } }]);
      await dispatchAll();
      let outcome = await flush(r1);
      expect(outcome).toMatchObject({ recorded: 1, skipped: { actor: 1 } });
      expect((await notificationsOf(r1)).map((row) => [row.user_id, row.payload])).toEqual([
        [
          users.u_reader,
          { field_ids: [fld.amount.id], change_count: 1, actor_ids: [users.u_sales1] },
        ],
      ]);
      await sql`DELETE FROM meta.notifications WHERE entity_id = ${r1}`.execute(db.kysely);

      // u_sales1 then u_editor in the same window: u_sales1 still left out.
      await update(users.u_sales1, [{ id: r1, fields: { amount: 3001 } }]);
      await update(users.u_editor, [{ id: r1, fields: { amount: 3002 } }]);
      await dispatchAll();
      outcome = await flush(r1);
      expect(outcome).toMatchObject({ recorded: 1, skipped: { actor: 1 } });
      expect(
        (await notificationsOf(r1)).map((row) => [row.user_id, row.actor_id, row.payload]),
      ).toEqual([
        [
          users.u_reader,
          users.u_editor,
          {
            field_ids: [fld.amount.id],
            change_count: 2,
            actor_ids: [users.u_sales1, users.u_editor],
          },
        ],
      ]);
      await follows.unfollow(scopeA, { tableId: orders.id, recordId: r1, userId: users.u_reader });
      await sql`DELETE FROM meta.notifications WHERE entity_id = ${r1}`.execute(db.kysely);
    });

    it('counts and attributes only the changes a recipient may see', async () => {
      await follow(r1, users.u_reader);
      await update(users.u_editor, [{ id: r1, fields: { cost: 20 } }]);
      await update(a.userId, [{ id: r1, fields: { cost: 21 } }]);
      await update(users.u_editor, [{ id: r1, fields: { amount: 4000 } }]);
      await update(a.userId, [{ id: r1, fields: { cost: 22 } }]);
      await dispatchAll();
      await flush(r1);
      const rows = await notificationsOf(r1);
      expect(
        Object.fromEntries(rows.map((row) => [row.user_id, [row.actor_id, row.payload]])),
      ).toEqual({
        // Sees one change of amount, by u_editor; the hidden cost changes are not counted.
        [users.u_sales1]: [
          users.u_editor,
          { field_ids: [fld.amount.id], change_count: 1, actor_ids: [users.u_editor] },
        ],
        [users.u_reader]: [
          a.userId,
          {
            field_ids: [fld.cost.id, fld.amount.id],
            change_count: 4,
            actor_ids: [users.u_editor, a.userId],
          },
        ],
      });
      await follows.unfollow(scopeA, { tableId: orders.id, recordId: r1, userId: users.u_reader });
      await sql`DELETE FROM meta.notifications WHERE entity_id = ${r1}`.execute(db.kysely);
    });

    it('a follower reading none of the changed fields gets nothing (cannot_read_field)', async () => {
      await follow(r1, users.u_blind);
      await update(users.u_editor, [{ id: r1, fields: { amount: 4100, cost: 30 } }]);
      await dispatchAll();
      const outcome = await flush(r1);
      expect(outcome).toMatchObject({ recorded: 1, skipped: { cannot_read_field: 1 } });
      expect((await notificationsOf(r1)).map((row) => row.user_id)).toEqual([users.u_sales1]);
      // The record's title is a change u_blind reads.
      await update(users.u_editor, [{ id: r1, fields: { title: 'Đơn R1 (sửa)' } }]);
      await dispatchAll();
      await flush(r1);
      expect(
        (await notificationsOf(r1))
          .filter((row) => row.user_id === users.u_blind)
          .map((row) => row.payload),
      ).toEqual([{ field_ids: [fld.title.id], change_count: 1, actor_ids: [users.u_editor] }]);
      await follows.unfollow(scopeA, { tableId: orders.id, recordId: r1, userId: users.u_blind });
      await sql`DELETE FROM meta.notifications WHERE entity_id = ${r1}`.execute(db.kysely);
    });

    it('a follower of r2 who cannot read r2 is never told (P39 r2)', async () => {
      // Followed before losing access, e.g. the owner changed: the row stays, nothing is sent.
      await follows.follow(
        scopeA,
        { tableId: orders.id, recordId: r2, userId: users.u_sales1 },
        'manual',
      );
      await update(users.u_editor, [{ id: r2, fields: { amount: 50 } }]);
      await dispatchAll();
      const outcome = await flush(r2);
      expect(outcome).toMatchObject({ recorded: 0, skipped: { cannot_read_record: 1 } });
      expect(await notificationsOf(r2)).toEqual([]);
      await follows.unfollow(scopeA, { tableId: orders.id, recordId: r2, userId: users.u_sales1 });
    });

    it('a paste of several rows (bulk) including r1 → followers get nothing', async () => {
      const others: Id<'rec'>[] = [];
      for (let i = 0; i < 3; i += 1)
        others.push(await createOrder(`Paste ${String(i)}`, users.u_sales1));
      await dispatchAll();
      await update(users.u_editor, [
        { id: r1, fields: { amount: 5000 } },
        ...others.map((id, i) => ({ id, fields: { amount: i } })),
      ]);
      await dispatchAll();
      expect(await bufferRows(r1)).toEqual([]);
      expect(await flushJob(r1)).toEqual([]);
      expect(await notificationsOf(r1)).toEqual([]);
    });

    it('an import touching r1 → nothing (bulk by definition)', async () => {
      const importJob = newId('job');
      await update(users.u_editor, [{ id: r1, fields: { amount: 5001 } }], {
        ...auditOf(users.u_editor, { import_job_id: importJob }),
        batch_id: importJob,
      });
      await dispatchAll();
      expect(await bufferRows(r1)).toEqual([]);
      expect(await notificationsOf(r1)).toEqual([]);
    });

    it('a change made by an automation (one record) is told, without a user actor', async () => {
      const automationId = newId('aut');
      const runId = newId('run');
      await update(users.u_editor, [{ id: r1, fields: { amount: 5100 } }], {
        actor: { type: 'automation', id: automationId },
        via: { automation_id: automationId, run_id: runId },
        batch_id: runId,
        request_id: null,
        ip: null,
        user_agent: null,
      });
      await dispatchAll();
      await flush(r1);
      expect(
        (await notificationsOf(r1)).map((row) => [
          row.user_id,
          row.actor_type,
          row.actor_id,
          row.payload,
        ]),
      ).toEqual([
        [
          users.u_sales1,
          'automation',
          automationId,
          { field_ids: [fld.amount.id], change_count: 1, actor_ids: [] },
        ],
      ]);
      await sql`DELETE FROM meta.notifications WHERE entity_id = ${r1}`.execute(db.kysely);
    });

    it('losing read access to r1 before the flush → nothing', async () => {
      await update(users.u_editor, [{ id: r1, fields: { amount: 5200 } }]);
      await dispatchAll();
      // u_sales1 loses the Sales role (no access to the base any more).
      const roles = new BaseRoleMembersRepository(db);
      await roles.remove(scopeA, a.baseId, 'user', users.u_sales1);
      const outcome = await flush(r1);
      expect(outcome).toMatchObject({ recorded: 0, skipped: { cannot_read_base: 1 } });
      expect(await notificationsOf(r1)).toEqual([]);
      await roles.assign(scopeA, {
        baseId: a.baseId,
        roleId: salesRole,
        principalType: 'user',
        principalId: users.u_sales1,
      });
    });

    it('unfollowing before the flush → nothing; the record deleted meanwhile → the whole group dropped', async () => {
      await update(users.u_editor, [{ id: r1, fields: { amount: 5300 } }]);
      await dispatchAll();
      await follows.unfollow(scopeA, { tableId: orders.id, recordId: r1, userId: users.u_sales1 });
      expect(await flush(r1)).toMatchObject({ status: 'flushed', recorded: 0 });
      expect(await notificationsOf(r1)).toEqual([]);

      const doomed = await createOrder('Doomed', users.u_sales1);
      await follow(doomed, users.u_sales1);
      await follow(doomed, users.u_reader);
      await dispatchAll();
      await update(users.u_editor, [{ id: doomed, fields: { amount: 1 } }]);
      await dispatchAll();
      await mutation.delete(
        scopeA,
        orders.id,
        await accessFor(a.userId),
        { ids: [doomed] },
        auditOf(a.userId),
      );
      await dispatchAll();
      expect(await flush(doomed)).toMatchObject({
        status: 'flushed',
        recorded: 0,
        skipped: { cannot_read_record: 2 },
      });
      expect(await notificationsOf(doomed)).toEqual([]);
      await follow(r1, users.u_sales1);
    });

    it('respects the type × channel preferences (email off by default) and base mutes', async () => {
      await follow(r1, users.u_reader);
      const preferences = new NotificationPreferencesRepository(db);
      await preferences.upsert(scopeA, users.u_reader, [
        { type: 'record.followed_changed', channel: 'in_app', enabled: false },
      ]);
      await preferences.upsert(scopeA, users.u_sales1, [
        { type: 'record.followed_changed', channel: 'email', enabled: true },
      ]);
      await new NotificationBaseMutesRepository(db).mute(scopeA, users.u_sales1, a.baseId);
      await update(users.u_editor, [{ id: r1, fields: { amount: 5400 } }]);
      await dispatchAll();
      await flush(r1);
      // u_reader turned in-app off and keeps the email default (off): no row at all.
      expect((await notificationsOf(r1)).map((row) => row.user_id)).toEqual([users.u_sales1]);
      // u_sales1 muted the base: in-app only, no email queued despite the preference.
      const deliveries = await db.kysely
        .selectFrom('meta.notification_deliveries')
        .innerJoin(
          'meta.notifications',
          'meta.notifications.id',
          'meta.notification_deliveries.notification_id',
        )
        .select(['meta.notification_deliveries.channel'])
        .where('meta.notifications.entity_id', '=', r1)
        .execute();
      expect(deliveries).toEqual([]);

      // Unmuted: the email is queued; u_reader with email on gets an email-only row.
      await new NotificationBaseMutesRepository(db).unmute(scopeA, users.u_sales1, a.baseId);
      await preferences.upsert(scopeA, users.u_reader, [
        { type: 'record.followed_changed', channel: 'email', enabled: true },
      ]);
      await update(users.u_editor, [{ id: r1, fields: { amount: 5401 } }]);
      await dispatchAll();
      await flush(r1);
      const emailed = await db.kysely
        .selectFrom('meta.notification_deliveries')
        .innerJoin(
          'meta.notifications',
          'meta.notifications.id',
          'meta.notification_deliveries.notification_id',
        )
        .select(['meta.notifications.user_id', 'meta.notification_deliveries.channel'])
        .where('meta.notifications.entity_id', '=', r1)
        .orderBy('meta.notifications.user_id')
        .execute();
      // Code-unit order on both sides (the database collation orders mixed-case ids differently).
      expect(emailed.sort((a, b) => (a.user_id < b.user_id ? -1 : 1))).toEqual(
        [users.u_reader, users.u_sales1].sort().map((user_id) => ({ user_id, channel: 'email' })),
      );
      await preferences.upsert(scopeA, users.u_reader, [
        { type: 'record.followed_changed', channel: 'in_app', enabled: true },
        { type: 'record.followed_changed', channel: 'email', enabled: false },
      ]);
      await preferences.upsert(scopeA, users.u_sales1, [
        { type: 'record.followed_changed', channel: 'email', enabled: false },
      ]);
      await follows.unfollow(scopeA, { tableId: orders.id, recordId: r1, userId: users.u_reader });
      await sql`DELETE FROM meta.notifications WHERE entity_id = ${r1}`.execute(db.kysely);
    });

    it('an actor who left the organization is not named in actor_ids', async () => {
      const leaver = newId('usr');
      await db.kysely
        .insertInto('meta.users')
        .values({
          id: leaver,
          email: `leaver.${leaver.slice(4, 10).toLowerCase()}@t545.test`,
          display_name: 'Leaver',
        })
        .execute();
      await db.kysely
        .insertInto('meta.org_members')
        .values({ organization_id: ORG_A, user_id: leaver, role: 'admin' })
        .execute();
      await update(leaver, [{ id: r1, fields: { amount: 5500 } }]);
      await update(users.u_editor, [{ id: r1, fields: { amount: 5501 } }]);
      await dispatchAll();
      await db.kysely
        .deleteFrom('meta.org_members')
        .where('organization_id', '=', ORG_A)
        .where('user_id', '=', leaver)
        .execute();
      await flush(r1);
      expect((await notificationsOf(r1)).map((row) => row.payload)).toEqual([
        { field_ids: [fld.amount.id], change_count: 2, actor_ids: [users.u_editor] },
      ]);
      await sql`DELETE FROM meta.notifications WHERE entity_id = ${r1}`.execute(db.kysely);
    });
  });

  describe('FollowedChangeGrouper', () => {
    it(`notifies at most ${String(NOTIFICATION_FOLLOWERS_MAX)} followers of a record per flush, actors left out first`, async () => {
      const record = await createOrder('Popular', users.u_sales1);
      await dispatchAll();
      const many = Array.from({ length: NOTIFICATION_FOLLOWERS_MAX + 2 }, () => newId('usr'));
      await db.kysely
        .insertInto('meta.users')
        .values(
          many.map((id) => ({ id, email: `${id.toLowerCase()}@t545-many.test`, display_name: id })),
        )
        .execute();
      await db.kysely
        .insertInto('meta.org_members')
        .values(
          many.map((id) => ({ organization_id: ORG_A, user_id: id, role: 'member' as const })),
        )
        .execute();
      const actor = [...many].sort()[0] as Id<'usr'>;
      await db.kysely
        .insertInto('meta.record_follows')
        .values(
          many.map((userId) => ({
            organization_id: ORG_A,
            table_id: orders.id,
            record_id: record,
            user_id: userId,
            source: 'manual',
          })),
        )
        .execute();
      const { request, recipients } = await db.withTx(async (tx) => {
        const [grouped] = await new FollowedChangeGrouper(db).group({
          organizationId: ORG_A,
          kind: 'followed',
          groupKey: record,
          jobId: '42',
          tx,
          rows: [
            {
              id: '7',
              kind: 'followed',
              group_key: record,
              user_id: null,
              table_id: orders.id,
              record_id: record,
              field_ids: [fld.amount.id],
              actor_type: 'user',
              actor_id: actor,
              created_at: new Date(),
            },
          ],
        });
        return {
          request: grouped,
          recipients: typeof grouped?.recipients === 'function' ? await grouped.recipients() : [],
        };
      });
      expect(request).toMatchObject({
        type: 'record.followed_changed',
        baseId: a.baseId,
        tableId: orders.id,
        entityType: 'record',
        entityId: record,
        groupKey: `${record}:42`,
        skipUserIds: [actor],
        requires: { recordIds: [record], anyFieldIds: [fld.amount.id] },
      });
      expect(recipients).toHaveLength(NOTIFICATION_FOLLOWERS_MAX + 1);
      expect(recipients[0]).toBe(actor);
      expect(recipients.slice(1)).toEqual(
        [...many].sort().slice(1, NOTIFICATION_FOLLOWERS_MAX + 1),
      );

      // A real flush checks the actor plus 1 000 followers, never the last one
      // (none of them has a role in the base here).
      await update(users.u_editor, [{ id: record, fields: { amount: 7 } }], auditOf(actor));
      await dispatchAll();
      expect(await flush(record)).toMatchObject({
        status: 'flushed',
        recorded: 0,
        skipped: { actor: 1, cannot_read_base: NOTIFICATION_FOLLOWERS_MAX },
      });
      await db.kysely.deleteFrom('meta.record_follows').where('record_id', '=', record).execute();
    });

    it('a group of a purged table writes nothing; without a job the first row stands in for it', async () => {
      const grouper = new FollowedChangeGrouper(db);
      const row = {
        id: '99',
        kind: 'followed' as const,
        group_key: 'rec_T545Purged000001',
        user_id: null,
        table_id: newId('tbl'),
        record_id: 'rec_T545Purged000001' as Id<'rec'>,
        field_ids: [fld.amount.id],
        actor_type: null,
        actor_id: null,
        created_at: new Date(),
      };
      expect(
        await db.withTx((tx) =>
          grouper.group({
            organizationId: ORG_A,
            kind: 'followed',
            groupKey: row.group_key,
            jobId: null,
            tx,
            rows: [row],
          }),
        ),
      ).toEqual([]);
      const [request] = await db.withTx((tx) =>
        grouper.group({
          organizationId: ORG_A,
          kind: 'followed',
          groupKey: row.group_key,
          jobId: null,
          tx,
          rows: [{ ...row, table_id: orders.id }],
        }),
      );
      expect(request?.groupKey).toBe(`${row.record_id}:row99`);
      expect(request?.actor).toBeNull();
      expect(
        await db.withTx((tx) =>
          grouper.group({
            organizationId: ORG_A,
            kind: 'followed',
            groupKey: row.group_key,
            jobId: null,
            tx,
            rows: [],
          }),
        ),
      ).toEqual([]);
    });
  });

  describe('tenant isolation', () => {
    it('followers, buffer rows and flushes stay in their organization', async () => {
      const r1 = await createOrder('Tenant R1', users.u_sales1);
      await follow(r1, users.u_reader);
      // Org B: its owner follows its own record.
      const [recB] = (
        await mutation.create(
          scopeB,
          otherTable.id,
          await accessFor(userB, scopeB, b.baseId),
          { records: [{ fields: { name: 'B1' } }] },
          auditOf(userB),
        )
      ).records.map((record) => record.id);
      await follows.follow(
        scopeB,
        { tableId: otherTable.id, recordId: recB as Id<'rec'>, userId: userB },
        'manual',
      );
      await dispatchAll();

      // The listener in org B's scope finds no follower of org A's record.
      const eventA: EventDocument = {
        id: newId('evt'),
        type: 'record.updated',
        organization_id: ORG_A,
        table_id: orders.id,
        entity_type: 'record',
        entity_id: r1,
        actor: { type: 'user', id: users.u_editor },
        changes: { [fld.amount.id]: { from: null, to: 1 } },
        causation: { root_event_id: newId('evt'), depth: 0, automation_chain: [] },
        created_at: new Date().toISOString(),
      };
      expect(
        await db.withTx((tx) =>
          new FollowedChangeListener(db).onEvent(orgScope(ORG_B, tx), eventA),
        ),
      ).toBe('no_followers');

      await update(users.u_editor, [{ id: r1, fields: { amount: 1 } }]);
      await mutation.update(
        scopeB,
        otherTable.id,
        await accessFor(userB, scopeB, b.baseId),
        { records: [{ id: recB as Id<'rec'>, fields: { name: 'B1 edited' } }] },
        automationAudit(),
      );
      await dispatchAll();
      expect((await bufferRows(r1)).map((row) => row.organization_id)).toEqual([ORG_A]);
      expect((await bufferRows(recB as Id<'rec'>)).map((row) => row.organization_id)).toEqual([
        ORG_B,
      ]);
      // Org A's group flushed as org B: nothing (rows are scoped by organization).
      expect(
        await flusher.flush(
          { organization_id: ORG_B, kind: 'followed', group_key: r1 },
          { jobId: '1' },
        ),
      ).toEqual({ status: 'empty' });
      await flush(r1);
      await flush(recB as Id<'rec'>, ORG_B);
      expect((await notificationsOf(r1)).map((row) => [row.organization_id, row.user_id])).toEqual([
        [ORG_A, users.u_reader],
      ]);
      expect(
        (await notificationsOf(recB as Id<'rec'>)).map((row) => [
          row.organization_id,
          row.user_id,
          row.payload,
        ]),
      ).toEqual([[ORG_B, userB, { field_ids: [otherTitle.id], change_count: 1, actor_ids: [] }]]);
    });
  });
});
