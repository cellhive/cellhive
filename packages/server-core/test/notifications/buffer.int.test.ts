/**
 * BACKLOG T542 (ADR-34 §2): the notification buffer, its flush and the
 * grouped fan-out against PostgreSQL — one job per group (debounce,
 * `flushWhenCount`), one notification per recipient, idempotent re-runs,
 * rollback of a failed flush, per-recipient access (records in one read,
 * "at least one field" with `data.field_ids` filtered), turns of at most
 * 1 000 recipients, the stale-row lookup and tenant isolation.
 */
import { newId, type Id } from '@cellhive/contracts';
import { roleConfigSchema, systemRoleConfig, type RoleConfigInput } from '@cellhive/permissions';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  listStaleNotificationBuffers,
  orgScope,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import {
  MAX_NOTIFICATION_RECIPIENTS,
  NotificationBuffer,
  NotificationBufferRepository,
  NotificationFanout,
  NotificationFlusher,
  NotificationWriter,
  type GroupedNotificationRequest,
  type NotificationGroup,
  type NotificationGrouper,
} from '../../src/notifications/index.js';
import { RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { insertRows } from '../records/fixtures.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { FieldRow, JsonObject, TableRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_NtfBufferOrgA001';
const ORG_B: Id<'org'> = 'org_NtfBufferOrgB001';
const DEFAULTS = { timeZone: 'UTC', locale: 'en' };

/** A grouper of `assigned` like T544's: one notification per recipient, records they read. */
function assignedGrouper(calls: NotificationGroup[] = []): NotificationGrouper {
  return {
    kind: 'assigned',
    group(group) {
      calls.push(group);
      const byUser = new Map<Id<'usr'>, { records: Id<'rec'>[]; fields: Set<Id<'fld'>> }>();
      for (const row of group.rows) {
        if (row.user_id === null) continue;
        const entry = byUser.get(row.user_id) ?? { records: [], fields: new Set<Id<'fld'>>() };
        entry.records.push(row.record_id);
        for (const field of row.field_ids) entry.fields.add(field);
        byUser.set(row.user_id, entry);
      }
      const tableId = group.rows[0]?.table_id ?? null;
      return [...byUser].map(([userId, entry]): GroupedNotificationRequest => ({
        type: 'record.assigned',
        baseId: baseOf(tableId),
        tableId,
        entityType: 'table',
        entityId: tableId ?? '',
        actor: null,
        groupKey: group.groupKey,
        recipients: [userId],
        requires: { recordIds: entry.records },
        dataFor: (_user, readable) =>
          readable.recordIds.length === 0
            ? null
            : {
                batch_id: group.groupKey,
                count: readable.recordIds.length,
                record_ids: readable.recordIds.slice(0, 20),
                field_ids: [...entry.fields],
              },
      }));
    },
  };
}

/** A grouper of `followed` like T545's: followers from a function, fields filtered per person. */
function followedGrouper(followers: () => readonly Id<'usr'>[]): NotificationGrouper {
  return {
    kind: 'followed',
    group(group) {
      const first = group.rows[0];
      if (first === undefined) return [];
      const actors = [
        ...new Set(group.rows.flatMap((row) => (row.actor_id === null ? [] : [row.actor_id]))),
      ] as Id<'usr'>[];
      return [
        {
          type: 'record.followed_changed',
          baseId: baseOf(first.table_id),
          tableId: first.table_id,
          entityType: 'record',
          entityId: first.record_id,
          actor: null,
          groupKey: `${first.record_id}:${group.jobId ?? 'nojob'}`,
          recipients: () => Promise.resolve(followers()),
          skipUserIds: actors,
          requires: {
            recordIds: [first.record_id],
            anyFieldIds: [...new Set(group.rows.flatMap((row) => row.field_ids))],
          },
          dataFor: (_user, readable) => ({
            field_ids: [...readable.fieldIds],
            change_count: group.rows.length,
            actor_ids: actors.slice(0, 5),
          }),
        },
      ];
    },
  };
}

const bases = new Map<Id<'tbl'>, Id<'bse'>>();
function baseOf(tableId: Id<'tbl'> | null): Id<'bse'> | null {
  return tableId === null ? null : (bases.get(tableId) ?? null);
}

describe('notification buffer and flush (T542)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let a: SeededTenant;
  let b: SeededTenant;
  let scopeA: OrgScope;
  let scopeB: OrgScope;
  let table: TableRow;
  let tableB: TableRow;
  let title: FieldRow;
  let amount: FieldRow;
  const f: FieldRow[] = [];
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;
  let r3: Id<'rec'>;
  let fanout: NotificationFanout;
  const users: Record<'reader' | 'partial' | 'blind' | 'filtered' | 'outsider', Id<'usr'>> = {
    reader: 'usr_NtfBufReader0001',
    partial: 'usr_NtfBufPartial001',
    blind: 'usr_NtfBufBlind00001',
    filtered: 'usr_NtfBufFilter0001',
    outsider: 'usr_NtfBufOutside001',
  };
  let groupSeq = 0;
  const nextGroup = (prefix: string) => `${prefix}_${String((groupSeq += 1))}`;

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

  async function notificationsOf(groupKey: string) {
    return db.kysely
      .selectFrom('meta.notifications')
      .select(['user_id', 'type', 'entity_type', 'entity_id', 'group_key', 'payload'])
      .where('group_key', '=', groupKey)
      .orderBy('user_id')
      .execute();
  }

  async function flushJobs(kind: string, groupKey: string) {
    const { rows } = await sql<{ payload: Record<string, unknown>; run_at: Date }>`
      SELECT p.payload, jobs.run_at
        FROM graphile_worker.jobs JOIN graphile_worker._private_jobs p USING (id)
       WHERE jobs.task_identifier = 'notifications.flush'
         AND jobs.key = ${`${kind}:${groupKey}`}
    `.execute(db.kysely);
    return rows;
  }

  async function bufferRows(groupKey: string) {
    return db.kysely
      .selectFrom('meta.notification_buffer')
      .select(['organization_id', 'user_id', 'record_id'])
      .where('group_key', '=', groupKey)
      .execute();
  }

  const buffer = (now?: Date) =>
    new NotificationBuffer(db, now === undefined ? {} : { now: () => now });

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 2 });
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    await db.kysely
      .insertInto('meta.users')
      .values(
        Object.entries(users).map(([key, id]) => ({
          id,
          email: `${key}@ntf-buffer.test`,
          display_name: key,
        })),
      )
      .execute();
    await db.kysely
      .insertInto('meta.org_members')
      .values([
        { organization_id: ORG_A, user_id: a.userId, role: 'owner' },
        { organization_id: ORG_B, user_id: b.userId, role: 'owner' },
        ...Object.entries(users)
          .filter(([key]) => key !== 'outsider')
          .map(([, id]) => ({ organization_id: ORG_A, user_id: id, role: 'member' as const })),
        { organization_id: ORG_B, user_id: users.outsider, role: 'member' as const },
      ])
      .execute();

    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const created = await schema.createTable(
      scopeA,
      { baseId: a.baseId, name: 'Orders', primaryFieldName: 'title' },
      systemAuditContext(),
    );
    table = created.table;
    title = created.primaryField;
    bases.set(table.id, a.baseId);
    amount = await schema.addField(
      scopeA,
      table.id,
      { name: 'amount', type: 'number', options: {} },
      systemAuditContext(),
    );
    for (const name of ['f1', 'f2', 'f3']) {
      f.push(
        await schema.addField(
          scopeA,
          table.id,
          { name, type: 'text', options: {} },
          systemAuditContext(),
        ),
      );
    }
    [r1, r2, r3] = (await insertRows(pool, table, [
      { [title.db_column_name as string]: 'Order R1', [amount.db_column_name as string]: 900 },
      { [title.db_column_name as string]: 'Order R2', [amount.db_column_name as string]: 100 },
      { [title.db_column_name as string]: 'Order R3', [amount.db_column_name as string]: 50 },
    ])) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
    tableB = (
      await schema.createTable(
        scopeB,
        { baseId: b.baseId, name: 'Other', primaryFieldName: 'name' },
        systemAuditContext(),
      )
    ).table;
    bases.set(tableB.id, b.baseId);

    const fieldsMeta = [title, amount, ...f].map((field) => ({ id: field.id, type: field.type }));
    const schemaMeta = { tables: [{ id: table.id, fields: fieldsMeta }], dashboards: [] };
    const reader = await new BaseRolesRepository(db).create(scopeA, {
      baseId: a.baseId,
      name: 'Reader',
      kind: 'system_reader',
      config: systemRoleConfig('reader', schemaMeta) as unknown as JsonObject,
    });
    await new BaseRoleMembersRepository(db).assign(scopeA, {
      baseId: a.baseId,
      roleId: reader.id,
      principalType: 'user',
      principalId: users.reader,
    });
    const [f1, f2, f3] = f as [FieldRow, FieldRow, FieldRow];
    await role(
      'Partial',
      {
        tables: {
          [table.id]: {
            perm: 'read_only',
            field_rule: {
              mode: 'specify',
              fields: { [f2.id]: 'no_perm', [f3.id]: 'no_perm' },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
        },
      },
      [users.partial],
    );
    await role(
      'Blind',
      {
        tables: {
          [table.id]: {
            perm: 'read_only',
            field_rule: {
              mode: 'specify',
              fields: { [f1.id]: 'no_perm', [f2.id]: 'no_perm', [f3.id]: 'no_perm' },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
        },
      },
      [users.blind],
    );
    await role(
      'Filtered',
      {
        tables: {
          [table.id]: {
            perm: 'read_only',
            record_rule: {
              read_scope: 'filter',
              read_filter: { field: amount.id, operator: 'gte', value: 500 },
            },
            field_rule: { mode: 'all_read' },
          },
        },
      },
      [users.filtered],
    );

    fanout = new NotificationFanout(db, new RecordQueryService(db), {
      emailEnabled: false,
      defaults: DEFAULTS,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  const row = (userId: Id<'usr'> | null, recordId: Id<'rec'>, fieldIds?: Id<'fld'>[]) => ({
    userId,
    tableId: table.id,
    recordId,
    fieldIds: fieldIds ?? [(f[0] as FieldRow).id],
    actor: null,
  });

  it('3 appends to one group: 1 job (debounced), 1 flush, 1 notification per recipient', async () => {
    const group = nextGroup('job');
    const now = new Date('2026-10-17T03:00:00.000Z');
    const owner = (f[0] as FieldRow).id;
    await db.withTx((tx) =>
      buffer(now).append(tx, {
        organizationId: ORG_A,
        kind: 'assigned',
        groupKey: group,
        rows: [row(users.reader, r1, [owner]), row(users.filtered, r1, [owner])],
      }),
    );
    await db.withTx((tx) =>
      buffer(new Date(now.getTime() + 4_000)).append(tx, {
        organizationId: ORG_A,
        kind: 'assigned',
        groupKey: group,
        rows: [row(users.reader, r2, [owner]), row(users.filtered, r2, [owner])],
      }),
    );
    await db.withTx((tx) =>
      buffer(new Date(now.getTime() + 8_000)).append(tx, {
        organizationId: ORG_A,
        kind: 'assigned',
        groupKey: group,
        rows: [row(users.reader, r3, [owner])],
      }),
    );
    // One job, `preserve_run_at`: 10 s after the first row.
    const jobs = await flushJobs('assigned', group);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({
      organization_id: ORG_A,
      kind: 'assigned',
      group_key: group,
    });
    expect(jobs[0]?.run_at.toISOString()).toBe('2026-10-17T03:00:10.000Z');
    expect(await bufferRows(group)).toHaveLength(5);

    const calls: NotificationGroup[] = [];
    const flusher = new NotificationFlusher(db, fanout, [assignedGrouper(calls)]);
    const outcome = await flusher.flush(
      { organization_id: ORG_A, kind: 'assigned', group_key: group },
      { jobId: '42' },
    );
    expect(outcome).toEqual({ status: 'flushed', rows: 5, requests: 2, recorded: 2, skipped: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.rows.map((r) => r.record_id)).toEqual([r1, r1, r2, r2, r3]);
    expect(calls[0]?.jobId).toBe('42');
    const written = await notificationsOf(group);
    expect(written).toEqual([
      {
        user_id: users.filtered,
        type: 'record.assigned',
        entity_type: 'table',
        entity_id: table.id,
        group_key: group,
        // Reads r1 only (amount ≥ 500): counted alone.
        payload: { batch_id: group, count: 1, record_ids: [r1], field_ids: [owner] },
      },
      {
        user_id: users.reader,
        type: 'record.assigned',
        entity_type: 'table',
        entity_id: table.id,
        group_key: group,
        payload: { batch_id: group, count: 3, record_ids: [r1, r2, r3], field_ids: [owner] },
      },
    ]);
    // Flushed rows are gone with the same transaction.
    expect(await bufferRows(group)).toEqual([]);

    // The job runs twice: nothing left, nothing written twice.
    expect(
      await flusher.flush({ organization_id: ORG_A, kind: 'assigned', group_key: group }),
    ).toEqual({ status: 'empty' });
    // Rows of the same group flushed again (e.g. a re-delivered batch): group_key holds.
    await db.withTx((tx) =>
      buffer(now).append(tx, {
        organizationId: ORG_A,
        kind: 'assigned',
        groupKey: group,
        rows: [row(users.reader, r1, [owner])],
      }),
    );
    expect(
      await flusher.flush({ organization_id: ORG_A, kind: 'assigned', group_key: group }),
    ).toMatchObject({ status: 'flushed', rows: 1, recorded: 0 });
    expect(await notificationsOf(group)).toHaveLength(2);
  });

  it('flushWhenCount: the pending flush moves to now once enough records are buffered', async () => {
    const group = nextGroup('req');
    const now = new Date('2026-10-17T04:00:00.000Z');
    const first = await db.withTx((tx) =>
      buffer(now).append(tx, {
        organizationId: ORG_A,
        kind: 'assigned',
        groupKey: group,
        rows: [row(users.reader, r1), row(users.partial, r1)],
        flushWhenCount: 2,
      }),
    );
    expect(first).toEqual({ flushNow: false });
    expect((await flushJobs('assigned', group))[0]?.run_at.toISOString()).toBe(
      '2026-10-17T04:00:10.000Z',
    );
    // Same record again: still one distinct record.
    expect(
      await db.withTx((tx) =>
        buffer(new Date(now.getTime() + 1_000)).append(tx, {
          organizationId: ORG_A,
          kind: 'assigned',
          groupKey: group,
          rows: [row(users.filtered, r1)],
          flushWhenCount: 2,
        }),
      ),
    ).toEqual({ flushNow: false });
    const second = await db.withTx((tx) =>
      buffer(new Date(now.getTime() + 2_000)).append(tx, {
        organizationId: ORG_A,
        kind: 'assigned',
        groupKey: group,
        rows: [row(users.reader, r2)],
        flushWhenCount: 2,
      }),
    );
    expect(second).toEqual({ flushNow: true });
    const jobs = await flushJobs('assigned', group);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.run_at.toISOString()).toBe('2026-10-17T04:00:02.000Z');

    // Nothing appended without rows; the arguments are checked.
    expect(
      await db.withTx((tx) =>
        buffer().append(tx, { organizationId: ORG_A, kind: 'assigned', groupKey: group, rows: [] }),
      ),
    ).toEqual({ flushNow: false });
    await expect(
      db.withTx((tx) =>
        buffer().append(tx, {
          organizationId: ORG_A,
          kind: 'assigned',
          groupKey: '',
          rows: [row(users.reader, r1)],
        }),
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      db.withTx((tx) =>
        buffer().append(tx, {
          organizationId: ORG_A,
          kind: 'assigned',
          groupKey: group,
          rows: [row(users.reader, r1)],
          flushWhenCount: 0,
        }),
      ),
    ).rejects.toThrow(RangeError);
  });

  it('an append rolled back leaves neither rows nor a job (outbox)', async () => {
    const group = nextGroup('job');
    const rollback = new Error('rollback');
    await expect(
      db.withTx(async (tx) => {
        await buffer().append(tx, {
          organizationId: ORG_A,
          kind: 'followed',
          groupKey: group,
          rows: [row(null, r1, [(f[0] as FieldRow).id])],
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await bufferRows(group)).toEqual([]);
    expect(await flushJobs('followed', group)).toEqual([]);
    // `followed` waits 60 s.
    const now = new Date('2026-10-17T05:00:00.000Z');
    await db.withTx((tx) =>
      buffer(now).append(tx, {
        organizationId: ORG_A,
        kind: 'followed',
        groupKey: group,
        rows: [row(null, r1, [(f[0] as FieldRow).id])],
      }),
    );
    expect((await flushJobs('followed', group))[0]?.run_at.toISOString()).toBe(
      '2026-10-17T05:01:00.000Z',
    );
    await db.kysely.deleteFrom('meta.notification_buffer').where('group_key', '=', group).execute();
  });

  it('a flush failing half-way rolls back: rows stay, the next flush writes them right', async () => {
    const group = nextGroup('job');
    await db.withTx((tx) =>
      buffer().append(tx, {
        organizationId: ORG_A,
        kind: 'assigned',
        groupKey: group,
        rows: [row(users.filtered, r1), row(users.reader, r2)],
      }),
    );
    const failing: NotificationGrouper = {
      kind: 'assigned',
      group(input) {
        const requests = assignedGrouper().group(input) as GroupedNotificationRequest[];
        // The second recipient's data is broken: the first one was already written.
        return requests.map((request, index) =>
          index === 0 ? request : { ...request, dataFor: () => ({ broken: true }) },
        );
      },
    };
    await expect(
      new NotificationFlusher(db, fanout, [failing]).flush({
        organization_id: ORG_A,
        kind: 'assigned',
        group_key: group,
      }),
    ).rejects.toThrow();
    expect(await notificationsOf(group)).toEqual([]);
    expect(await bufferRows(group)).toHaveLength(2);

    const outcome = await new NotificationFlusher(db, fanout, [assignedGrouper()]).flush({
      organization_id: ORG_A,
      kind: 'assigned',
      group_key: group,
    });
    expect(outcome).toMatchObject({ status: 'flushed', rows: 2, recorded: 2 });
    expect((await notificationsOf(group)).map((n) => n.user_id).sort()).toEqual(
      [users.filtered, users.reader].sort(),
    );
    expect(await bufferRows(group)).toEqual([]);
  });

  it('no grouper for the kind: rows kept; a second grouper for a kind is refused', async () => {
    const group = nextGroup('rec');
    await db.withTx((tx) =>
      buffer().append(tx, {
        organizationId: ORG_A,
        kind: 'followed',
        groupKey: group,
        rows: [row(null, r1, [(f[0] as FieldRow).id])],
      }),
    );
    expect(
      await new NotificationFlusher(db, fanout, [assignedGrouper()]).flush({
        organization_id: ORG_A,
        kind: 'followed',
        group_key: group,
      }),
    ).toEqual({ status: 'no_grouper', rows: 1 });
    expect(await bufferRows(group)).toHaveLength(1);
    expect(
      () => new NotificationFlusher(db, fanout, [assignedGrouper(), assignedGrouper()]),
    ).toThrow(TypeError);
    await db.kysely.deleteFrom('meta.notification_buffer').where('group_key', '=', group).execute();
  });

  it('a group locked by a running flush is skipped by a concurrent one', async () => {
    const group = nextGroup('job');
    await db.withTx((tx) =>
      buffer().append(tx, {
        organizationId: ORG_A,
        kind: 'assigned',
        groupKey: group,
        rows: [row(users.reader, r1)],
      }),
    );
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow: NotificationGrouper = {
      kind: 'assigned',
      async group(input) {
        entered();
        await held;
        return assignedGrouper().group(input);
      },
    };
    const first = new NotificationFlusher(db, fanout, [slow]).flush({
      organization_id: ORG_A,
      kind: 'assigned',
      group_key: group,
    });
    await inside;
    expect(
      await new NotificationFlusher(db, fanout, [assignedGrouper()]).flush({
        organization_id: ORG_A,
        kind: 'assigned',
        group_key: group,
      }),
    ).toEqual({ status: 'empty' });
    release();
    expect(await first).toMatchObject({ status: 'flushed', recorded: 1 });
  });

  it('any_field_ids: data.field_ids per recipient; nobody reads none of them', async () => {
    const group = r1;
    const [f1, f2, f3] = f as [FieldRow, FieldRow, FieldRow];
    await db.withTx((tx) =>
      buffer().append(tx, {
        organizationId: ORG_A,
        kind: 'followed',
        groupKey: group,
        rows: [
          { ...row(null, r1, [f1.id, f2.id]), actor: { type: 'user', id: a.userId } },
          { ...row(null, r1, [f3.id]), actor: { type: 'user', id: a.userId } },
        ],
      }),
    );
    const flusher = new NotificationFlusher(db, fanout, [
      followedGrouper(() => [users.reader, users.partial, users.blind, users.outsider, a.userId]),
    ]);
    const outcome = await flusher.flush(
      { organization_id: ORG_A, kind: 'followed', group_key: group },
      { jobId: '77' },
    );
    expect(outcome).toEqual({
      status: 'flushed',
      rows: 2,
      requests: 1,
      recorded: 2,
      skipped: { actor: 1, cannot_read_field: 1, cannot_read_base: 1 },
    });
    const written = await notificationsOf(`${r1}:77`);
    expect(Object.fromEntries(written.map((n) => [n.user_id, n.payload]))).toEqual({
      [users.partial]: { field_ids: [f1.id], change_count: 2, actor_ids: [a.userId] },
      [users.reader]: { field_ids: [f1.id, f2.id, f3.id], change_count: 2, actor_ids: [a.userId] },
    });
    expect(written).toHaveLength(2);
  });

  it("debounce 'from_last' (T544): every append moves the pending flush to the delay after it", async () => {
    const group = nextGroup('job');
    const now = new Date('2026-10-17T05:00:00.000Z');
    const at = (ms: number) => new Date(now.getTime() + ms);
    for (const [offset, record] of [
      [0, r1],
      [8_000, r2],
      [15_000, r3],
    ] as const) {
      await db.withTx((tx) =>
        buffer(at(offset)).append(tx, {
          organizationId: ORG_A,
          kind: 'assigned',
          groupKey: group,
          rows: [row(users.reader, record)],
          debounce: 'from_last',
        }),
      );
      const jobs = await flushJobs('assigned', group);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.run_at.toISOString()).toBe(at(offset + 10_000).toISOString());
    }
    // `from_first` (the default) keeps the first row's time.
    const other = nextGroup('req');
    for (const offset of [0, 8_000]) {
      await db.withTx((tx) =>
        buffer(at(offset)).append(tx, {
          organizationId: ORG_A,
          kind: 'assigned',
          groupKey: other,
          rows: [row(users.reader, r1)],
          debounce: 'from_first',
        }),
      );
    }
    expect((await flushJobs('assigned', other))[0]?.run_at.toISOString()).toBe(
      at(10_000).toISOString(),
    );
    expect(await bufferRows(group)).toHaveLength(3);
  });

  it('onAccepted (T544): called in the flush transaction for each accepted recipient only', async () => {
    const group = nextGroup('job');
    await db.withTx((tx) =>
      buffer().append(tx, {
        organizationId: ORG_A,
        kind: 'assigned',
        groupKey: group,
        rows: [row(users.filtered, r2), row(users.reader, r1), row(users.reader, r3)],
      }),
    );
    const accepted: { userId: Id<'usr'>; recordIds: readonly Id<'rec'>[]; inTx: boolean }[] = [];
    const base = assignedGrouper();
    const withHook: NotificationGrouper = {
      kind: 'assigned',
      async group(flushed) {
        const requests = await base.group(flushed);
        return requests.map((request) => ({
          ...request,
          onAccepted: async (userId: Id<'usr'>, readable: { recordIds: readonly Id<'rec'>[] }) => {
            // Runs inside the flush transaction: the group's rows are still there.
            const { rows } = await sql<{ n: number }>`
              SELECT count(*)::int AS n FROM meta.notification_buffer WHERE group_key = ${group}
            `.execute(flushed.tx);
            accepted.push({ userId, recordIds: readable.recordIds, inTx: rows[0]?.n === 3 });
          },
        }));
      },
    };
    const outcome = await new NotificationFlusher(db, fanout, [withHook]).flush({
      organization_id: ORG_A,
      kind: 'assigned',
      group_key: group,
    });
    expect(outcome).toMatchObject({ status: 'flushed', recorded: 1 });
    // `filtered` reads none of its records (left out): no call.
    expect(accepted).toEqual([{ userId: users.reader, recordIds: [r1, r3], inTx: true }]);
  });

  it('a recipient reading none of the records is left out; a gone base reads nothing', async () => {
    const group = nextGroup('job');
    await db.withTx((tx) =>
      buffer().append(tx, {
        organizationId: ORG_A,
        kind: 'assigned',
        groupKey: group,
        rows: [row(users.filtered, r2), row(users.filtered, r3), row(users.reader, r3)],
      }),
    );
    const outcome = await new NotificationFlusher(db, fanout, [assignedGrouper()]).flush({
      organization_id: ORG_A,
      kind: 'assigned',
      group_key: group,
    });
    expect(outcome).toMatchObject({
      status: 'flushed',
      recorded: 1,
      skipped: { cannot_read_record: 1 },
    });
    expect((await notificationsOf(group)).map((n) => n.user_id)).toEqual([users.reader]);

    // The fan-out itself: every candidate of a base that is gone is `cannot_read_base`.
    const gone = await db.withTx((tx) =>
      fanout.runGrouped(tx, ORG_A, {
        type: 'record.assigned',
        baseId: 'bse_NtfBufGoneBase001',
        tableId: null,
        entityType: 'base',
        entityId: 'bse_NtfBufGoneBase001',
        actor: null,
        groupKey: nextGroup('gone'),
        recipients: [users.reader],
        dataFor: () => ({
          batch_id: null,
          count: 1,
          record_ids: [r1],
          field_ids: [(f[0] as FieldRow).id],
        }),
      }),
    );
    expect(gone).toEqual({
      written: [],
      skipped: [{ userId: users.reader, reason: 'cannot_read_base' }],
    });
    // A type without a data schema is a programming error.
    await expect(
      db.withTx((tx) =>
        fanout.runGrouped(tx, ORG_A, {
          type: 'comment.mentioned',
          baseId: a.baseId,
          tableId: null,
          entityType: 'base',
          entityId: a.baseId,
          actor: null,
          groupKey: null,
          recipients: [users.reader],
          dataFor: () => ({}),
        }),
      ),
    ).rejects.toThrow(TypeError);
  });

  it('plain fan-out: any_field_ids filters data.field_ids and drops who reads none', async () => {
    const [f1, f2] = f as [FieldRow, FieldRow];
    const group = nextGroup('plain');
    const result = await fanout.run({
      organization_id: ORG_A,
      type: 'record.followed_changed',
      base_id: a.baseId,
      table_id: table.id,
      entity_type: 'record',
      entity_id: r1,
      actor: null,
      group_key: group,
      recipients: { user_ids: [users.reader, users.partial, users.blind], base_admins: false },
      requires: { record_id: r1, field_ids: [], any_field_ids: [f1.id, f2.id] },
      skip_actor: true,
      data: { field_ids: [f1.id, f2.id], change_count: 1, actor_ids: [] },
    });
    expect(result.skipped).toEqual([{ userId: users.blind, reason: 'cannot_read_field' }]);
    const written = await notificationsOf(group);
    expect(
      Object.fromEntries(
        written.map((n) => [n.user_id, (n.payload as { field_ids: string[] }).field_ids]),
      ),
    ).toEqual({ [users.reader]: [f1.id, f2.id], [users.partial]: [f1.id] });
    // `field_ids` still means "every one" (unchanged T511 behaviour).
    const strict = await fanout.run({
      organization_id: ORG_A,
      type: 'record.followed_changed',
      base_id: a.baseId,
      table_id: table.id,
      entity_type: 'record',
      entity_id: r1,
      actor: null,
      group_key: nextGroup('plain'),
      recipients: { user_ids: [users.partial], base_admins: false },
      requires: { record_id: r1, field_ids: [f1.id, f2.id] },
      skip_actor: true,
      data: { field_ids: [f1.id, f2.id], change_count: 1, actor_ids: [] },
    });
    expect(strict.skipped).toEqual([{ userId: users.partial, reason: 'cannot_read_field' }]);
  });

  it('1 500 recipients: written in turns of at most 1 000, all 1 500 notified', async () => {
    const many: Id<'usr'>[] = Array.from({ length: 1500 }, () => newId('usr'));
    await db.kysely
      .insertInto('meta.users')
      .values(many.map((id) => ({ id, email: `${id.toLowerCase()}@many.test`, display_name: id })))
      .execute();
    // Organization admins read every base of the organization.
    await db.kysely
      .insertInto('meta.org_members')
      .values(many.map((id) => ({ organization_id: ORG_A, user_id: id, role: 'admin' as const })))
      .execute();
    const write = vi.spyOn(NotificationWriter.prototype, 'write');
    const group = r2;
    await db.withTx((tx) =>
      buffer().append(tx, {
        organizationId: ORG_A,
        kind: 'followed',
        groupKey: group,
        rows: [row(null, r2, [(f[0] as FieldRow).id])],
      }),
    );
    const outcome = await new NotificationFlusher(db, fanout, [followedGrouper(() => many)]).flush(
      { organization_id: ORG_A, kind: 'followed', group_key: group },
      { jobId: '1500' },
    );
    expect(outcome).toMatchObject({ status: 'flushed', recorded: 1500, skipped: {} });
    expect(write.mock.calls.map((call) => call[2].length)).toEqual([
      MAX_NOTIFICATION_RECIPIENTS,
      500,
    ]);
    const { rows } = await sql<{ n: number }>`
      SELECT count(DISTINCT user_id)::int AS n FROM meta.notifications
       WHERE group_key = ${`${r2}:1500`}
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe(1500);
    await db.kysely
      .deleteFrom('meta.org_members')
      .where('organization_id', '=', ORG_A)
      .where('user_id', 'in', many)
      .execute();
  }, 300_000);

  it('stale groups: listed across organizations by age only, ids and keys, paged', async () => {
    await db.kysely.deleteFrom('meta.notification_buffer').execute();
    const groupA = nextGroup('job');
    const groupB = nextGroup('job');
    const fresh = nextGroup('job');
    await db.withTx(async (tx) => {
      await buffer().append(tx, {
        organizationId: ORG_A,
        kind: 'assigned',
        groupKey: groupA,
        rows: [row(users.reader, r1), row(users.reader, r2)],
      });
      await buffer().append(tx, {
        organizationId: ORG_B,
        kind: 'followed',
        groupKey: groupB,
        rows: [{ userId: null, tableId: tableB.id, recordId: r1, fieldIds: [], actor: null }],
      });
      await buffer().append(tx, {
        organizationId: ORG_A,
        kind: 'assigned',
        groupKey: fresh,
        rows: [row(users.reader, r3)],
      });
    });
    await sql`
      UPDATE meta.notification_buffer SET created_at = now() - interval '11 minutes'
       WHERE group_key IN (${groupA}, ${groupB})
    `.execute(db.kysely);
    const before = new Date(Date.now() - 10 * 60_000);
    const all = await listStaleNotificationBuffers(db.kysely, { before, after: null, limit: 10 });
    expect(all).toEqual(
      [
        { organizationId: ORG_A, kind: 'assigned', groupKey: groupA },
        { organizationId: ORG_B, kind: 'followed', groupKey: groupB },
      ].sort((x, y) => x.organizationId.localeCompare(y.organizationId)),
    );
    const first = await listStaleNotificationBuffers(db.kysely, { before, after: null, limit: 1 });
    expect(first).toEqual([all[0]]);
    expect(
      await listStaleNotificationBuffers(db.kysely, { before, after: first[0] ?? null, limit: 1 }),
    ).toEqual([all[1]]);
    await db.kysely.deleteFrom('meta.notification_buffer').execute();
  });

  it('isolates the buffer repository by organization', async () => {
    const repository = new NotificationBufferRepository(db);
    const group = nextGroup('job');
    await repository.append(scopeA, 'assigned', group, [row(users.reader, r1)]);
    expect(await repository.countRecords(scopeA, 'assigned', group)).toBe(1);
    expect(await repository.countRecords(scopeB, 'assigned', group)).toBe(0);
    const lockedB = await db.withTx((tx) =>
      repository.lockGroup(orgScope(ORG_B, tx), 'assigned', group),
    );
    expect(lockedB).toEqual([]);
    const lockedA = await db.withTx((tx) =>
      repository.lockGroup(orgScope(ORG_A, tx), 'assigned', group),
    );
    expect(lockedA.map((r) => [r.user_id, r.record_id, r.table_id])).toEqual([
      [users.reader, r1, table.id],
    ]);
    // Deleting from another organization touches nothing.
    expect(
      await repository.delete(
        scopeB,
        lockedA.map((r) => r.id),
      ),
    ).toBe(0);
    expect(await bufferRows(group)).toHaveLength(1);
    // A table or recipient of another organization cannot be referenced (composite FKs).
    await expect(
      repository.append(scopeB, 'assigned', group, [row(null, r1)]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      repository.append(scopeA, 'assigned', group, [row(users.outsider, r1)]),
    ).rejects.toMatchObject({ code: '23503' });
    // Locking needs the flush transaction.
    await expect(repository.lockGroup(scopeA, 'assigned', group)).rejects.toThrow(TypeError);
    expect(
      await repository.delete(
        scopeA,
        lockedA.map((r) => r.id),
      ),
    ).toBe(1);

    // Leaving the organization deletes the person's rows; deleting the table too.
    await repository.append(scopeA, 'assigned', group, [row(users.partial, r2)]);
    await db.kysely
      .deleteFrom('meta.org_members')
      .where('organization_id', '=', ORG_A)
      .where('user_id', '=', users.partial)
      .execute();
    expect(await bufferRows(group)).toEqual([]);
    await db.kysely
      .insertInto('meta.org_members')
      .values({ organization_id: ORG_A, user_id: users.partial, role: 'member' })
      .execute();
  });
});
