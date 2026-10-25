/**
 * BACKLOG T547 (ADR-29 §1, ADR-34 §1; CONTRACTS §22.6) against PostgreSQL:
 * `datetime.options.reminder` saved through `SchemaService` (references
 * checked, the cursor armed / re-armed / removed in the transaction of the
 * field change: on/off, offset, delete/restore, conversion, table purge),
 * and `DateReminderScanner` with an injected clock — date-only values at
 * `time_of_day` in the field's zone (Asia/Ho_Chi_Minh while the
 * organization is in UTC; the organization's zone otherwise), offsets,
 * DST gaps and repeats (America/New_York), a stopped worker catching up
 * once per record, a new value reminded again, a value already reminded
 * never twice (`group_key`), no catch-up when turned on, the trash, the
 * recipient field read when the reminder fires (`user`, `created_by`,
 * several users), the per-scan cap with many records due at one moment —
 * then `notifications.fanout` checking each recipient (P41: record, then
 * date field) and tenant isolation of the cursors and the cross-tenant
 * lookup.
 */
import { newId, type Id } from '@cellhive/contracts';
import { roleConfigSchema, systemRoleConfig, type RoleConfigInput } from '@cellhive/permissions';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  listDateReminderFields,
  orgScope,
  withTxScope,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import { resolveMemberBaseAccess } from '../../src/import/member-access.js';
import { JobsRepository } from '../../src/jobs/index.js';
import {
  DateReminderCursorsRepository,
  DateReminderScanner,
  NotificationFanout,
  type DateReminderResult,
  type FanoutResult,
  type NotificationsFanoutPayload,
} from '../../src/notifications/index.js';
import { RecordMutationService, RecordQueryService } from '../../src/records/index.js';
import { SchemaService, type StartConversionInput } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { FieldRow, JsonObject, TableRow } from '../../src/db/schema.js';
import type { RecordAccessContext } from '../../src/records/types.js';

const ORG_A: Id<'org'> = 'org_T547ReminderOrgA';
const ORG_B: Id<'org'> = 'org_T547ReminderOrgB';
const DEFAULTS = { timeZone: 'UTC', locale: 'en' };
const MINUTE = 60_000;
const at = (iso: string) => new Date(iso);

type UserKey = 'u_reader' | 'u_sales1' | 'u_sales2';
type FieldName =
  | 'title'
  | 'owner'
  | 'watchers'
  | 'creator'
  | 'due_vn'
  | 'deadline'
  | 'day_org'
  | 'ny_spring'
  | 'ny_fall'
  | 'cap_day'
  | 'late'
  | 'owner_due'
  | 'life'
  | 'p41';

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('date reminders (T547)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  const scopeA: OrgScope = orgScope(ORG_A);
  const scopeB: OrgScope = orgScope(ORG_B);
  let schema: SchemaService;
  let query: RecordQueryService;
  let mutation: RecordMutationService;
  let scanner: DateReminderScanner;
  let fanout: NotificationFanout;
  let cursors: DateReminderCursorsRepository;
  let orders: TableRow;
  let customers: TableRow;
  let manager: FieldRow;
  let fld: Record<FieldName, FieldRow>;
  let tableB: TableRow;
  let dueB: FieldRow;
  const users = {} as Record<UserKey, Id<'usr'>>;
  let salesRole: Id<'rol'>;
  let salesConfig: RoleConfigInput;
  const context = systemAuditContext();

  function auditOf(userId: Id<'usr'>): AuditContext {
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

  /** Creates orders as the owner of the organization (admin); returns their ids in order. */
  async function create(rows: readonly Record<string, unknown>[]): Promise<Id<'rec'>[]> {
    const result = await mutation.create(
      scopeA,
      orders.id,
      await accessFor(a.userId),
      { records: rows.map((fields) => ({ fields })) },
      auditOf(a.userId),
    );
    return result.records.map((record) => record.id);
  }

  async function update(id: Id<'rec'>, fields: Record<string, unknown>): Promise<void> {
    await mutation.update(
      scopeA,
      orders.id,
      await accessFor(a.userId),
      { records: [{ id, fields }] },
      auditOf(a.userId),
      { readBack: false },
    );
  }

  async function setReminder(field: FieldRow, reminder: unknown): Promise<FieldRow> {
    const updated = await schema.updateFieldOptions(
      scopeA,
      field.id,
      { options: { ...(field.options as JsonObject), reminder: reminder as JsonObject } },
      context,
    );
    fld[updated.name as FieldName] = updated;
    return updated;
  }

  const scan = (field: FieldRow, now: Date, with_: DateReminderScanner = scanner) =>
    with_.scanField({ organizationId: ORG_A, fieldId: field.id }, now);

  /** Queued `date.reminder` fan-out requests (taken off the queue). */
  async function takeReminders(): Promise<NotificationsFanoutPayload[]> {
    const { rows } = await sql<{ id: string; payload: NotificationsFanoutPayload }>`
      SELECT jobs.id::text AS id, p.payload
        FROM graphile_worker.jobs JOIN graphile_worker._private_jobs p USING (id)
       WHERE jobs.task_identifier = 'notifications.fanout'
         AND p.payload->>'type' = 'date.reminder'
       ORDER BY jobs.id
    `.execute(db.kysely);
    if (rows.length > 0) {
      await sql`DELETE FROM graphile_worker._private_jobs WHERE id = ANY(${rows.map((row) => row.id)}::bigint[])`.execute(
        db.kysely,
      );
    }
    return rows.map((row) => row.payload);
  }

  /** What `notifications.fanout` does with each queued reminder, in order. */
  async function deliver(): Promise<
    { payload: NotificationsFanoutPayload; result: FanoutResult }[]
  > {
    const out: { payload: NotificationsFanoutPayload; result: FanoutResult }[] = [];
    for (const payload of await takeReminders()) {
      out.push({ payload, result: await fanout.run(payload) });
    }
    return out;
  }

  async function notificationsOf(recordId: Id<'rec'>) {
    return db.kysely
      .selectFrom('meta.notifications')
      .select(['user_id', 'type', 'entity_id', 'group_key', 'payload', 'actor_type'])
      .where('type', '=', 'date.reminder')
      .where('entity_id', '=', recordId)
      .orderBy('created_at')
      .orderBy('user_id')
      .execute();
  }

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
    for (const key of ['u_reader', 'u_sales1', 'u_sales2'] as const) users[key] = newId('usr');
    await db.kysely
      .insertInto('meta.users')
      .values(
        Object.entries(users).map(([key, id]) => ({
          id,
          email: `${key}.${id.slice(4, 10).toLowerCase()}@t547.test`,
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
    query = new RecordQueryService(db);
    mutation = new RecordMutationService(db, { schema, query });
    scanner = new DateReminderScanner(db, { defaults: DEFAULTS, records: query, schema });
    fanout = new NotificationFanout(db, query, { emailEnabled: false, defaults: DEFAULTS });
    cursors = new DateReminderCursorsRepository(db);

    const created = await schema.createTable(
      scopeA,
      { baseId: a.baseId, name: 'Orders', primaryFieldName: 'title' },
      context,
    );
    orders = created.table;
    customers = (
      await schema.createTable(
        scopeA,
        { baseId: a.baseId, name: 'Customers', primaryFieldName: 'name' },
        context,
      )
    ).table;
    manager = await schema.addField(
      scopeA,
      customers.id,
      { name: 'manager', type: 'user', options: {} },
      context,
    );
    const add = (name: string, type: string, options: unknown = {}) =>
      schema.addField(scopeA, orders.id, { name, type, options }, context);
    const day = (timezone?: string) => ({
      style: { format: 'yyyy-MM-dd' },
      ...(timezone === undefined ? {} : { timezone }),
    });
    const withTime = { style: { format: 'yyyy-MM-dd HH:mm' } };
    fld = {
      title: created.primaryField,
      owner: await add('owner', 'user', { multiple: false }),
      watchers: await add('watchers', 'user', { multiple: true }),
      creator: await add('creator', 'created_by'),
      due_vn: await add('due_vn', 'datetime', day('Asia/Ho_Chi_Minh')),
      deadline: await add('deadline', 'datetime', withTime),
      day_org: await add('day_org', 'datetime', day()),
      ny_spring: await add('ny_spring', 'datetime', day('America/New_York')),
      ny_fall: await add('ny_fall', 'datetime', day('America/New_York')),
      cap_day: await add('cap_day', 'datetime', day('UTC')),
      late: await add('late', 'datetime', withTime),
      owner_due: await add('owner_due', 'datetime', withTime),
      life: await add('life', 'datetime', withTime),
      p41: await add('p41', 'datetime', day('Asia/Ho_Chi_Minh')),
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
    // CONTRACTS §5 Sales: reads/edits the orders it owns.
    salesConfig = {
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
                { field: fld.owner.id, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
              ],
            },
            read_scope: 'editable',
            read_filter: null,
          },
          field_rule: {
            mode: 'specify',
            fields: {},
            option_edit_fields: [],
            file_download_fields: [],
          },
        },
      },
      dashboards: {},
    };
    salesRole = await role('Sales', salesConfig, [users.u_sales1, users.u_sales2]);

    tableB = (
      await schema.createTable(
        scopeB,
        { baseId: b.baseId, name: 'Elsewhere', primaryFieldName: 'title' },
        context,
      )
    ).table;
    dueB = await schema.addField(
      scopeB,
      tableB.id,
      {
        name: 'due',
        type: 'datetime',
        options: { reminder: { recipients: 'users', user_ids: [b.userId] } },
      },
      context,
    );
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  beforeEach(async () => {
    await takeReminders();
  });

  describe('saving options.reminder (SchemaService)', () => {
    it('refuses references outside the table or the organization (422, nothing armed)', async () => {
      const cases: [unknown, string, string][] = [
        [
          { recipients: 'field_user', user_field_id: newId('fld') },
          'options.reminder.user_field_id',
          'UNKNOWN_FIELD',
        ],
        [
          // A user field of another table of the organization.
          { recipients: 'field_user', user_field_id: manager.id },
          'options.reminder.user_field_id',
          'UNKNOWN_FIELD',
        ],
        [
          // A field of another organization.
          { recipients: 'field_user', user_field_id: dueB.id },
          'options.reminder.user_field_id',
          'UNKNOWN_FIELD',
        ],
        [
          { recipients: 'field_user', user_field_id: fld.title.id },
          'options.reminder.user_field_id',
          'INVALID_FIELD_TYPE',
        ],
        [
          { recipients: 'users', user_ids: [users.u_reader, b.userId] },
          'options.reminder.user_ids[1]',
          'USER_NOT_FOUND',
        ],
        [
          { recipients: 'users', user_ids: [users.u_reader], time_of_day: '09:00' },
          'options.reminder.time_of_day',
          '',
        ],
        [
          { recipients: 'users', user_ids: [users.u_reader], offset_minutes: 43_201 },
          'options.reminder.offset_minutes',
          '',
        ],
      ];
      for (const [reminder, path, code] of cases) {
        const error = await appError(setReminder(fld.life, reminder));
        expect(error.code, path).toBe('VALIDATION_FAILED');
        expect(error.errors?.map((item) => item.path)).toEqual([path]);
        if (code !== '') expect(error.errors?.map((item) => item.code)).toEqual([code]);
      }
      expect(await cursors.get(scopeA, fld.life.id)).toBeUndefined();
      // A new field is checked the same way.
      const error = await appError(
        schema.addField(
          scopeA,
          orders.id,
          {
            name: 'refused',
            type: 'datetime',
            options: { reminder: { recipients: 'field_user', user_field_id: fld.title.id } },
          },
          context,
        ),
      );
      expect(error.errors?.map((item) => item.code)).toEqual(['INVALID_FIELD_TYPE']);
    });

    it('arms on, re-arms on a change of what decides it, removes off / trash, re-arms on restore', async () => {
      const before = Date.now();
      let field = await setReminder(fld.life, { recipients: 'users', user_ids: [users.u_reader] });
      const armed = await cursors.get(scopeA, field.id);
      expect(armed?.armedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(armed?.scannedUntil.getTime()).toBe(armed?.armedAt.getTime());

      // Name only: unchanged.
      field = await schema.updateField(scopeA, field.id, { name: 'life cycle' }, context);
      expect((await cursors.get(scopeA, field.id))?.armedAt).toEqual(armed?.armedAt);
      field = await schema.updateField(scopeA, field.id, { name: 'life' }, context);

      // The offset, the recipients, the zone: re-armed.
      for (const options of [
        { reminder: { recipients: 'users', user_ids: [users.u_reader], offset_minutes: -15 } },
        { reminder: { recipients: 'users', user_ids: [users.u_sales1], offset_minutes: -15 } },
        {
          timezone: 'Asia/Ho_Chi_Minh',
          reminder: { recipients: 'users', user_ids: [users.u_sales1], offset_minutes: -15 },
        },
      ]) {
        const previous = (await cursors.get(scopeA, field.id))?.armedAt.getTime() ?? 0;
        await new Promise((resolve) => setTimeout(resolve, 5));
        field = await schema.updateFieldOptions(
          scopeA,
          field.id,
          { options: { ...(field.options as JsonObject), ...options } },
          context,
        );
        expect((await cursors.get(scopeA, field.id))?.armedAt.getTime()).toBeGreaterThan(previous);
      }

      // Off: removed; the scan finds nothing to do.
      field = await setReminder(field, null);
      expect(await cursors.get(scopeA, field.id)).toBeUndefined();
      expect(await scan(field, at('2030-01-01T00:00:00Z'))).toMatchObject({
        outcome: 'turned_off',
      });

      // Trash and back: removed, then armed at the restore.
      field = await setReminder(field, { recipients: 'users', user_ids: [users.u_reader] });
      await schema.deleteField(scopeA, field.id, context);
      expect(await cursors.get(scopeA, field.id)).toBeUndefined();
      const restoredAt = Date.now();
      field = await schema.restoreField(scopeA, field.id, context);
      expect((await cursors.get(scopeA, field.id))?.armedAt.getTime()).toBeGreaterThanOrEqual(
        restoredAt - 1000,
      );
      fld.life = field;
    });

    it('ends with a conversion to another type and comes back with its revert', async () => {
      const jobs = new JobsRepository(db);
      const field = fld.life;
      expect(await cursors.get(scopeA, field.id)).toBeDefined();
      const input: StartConversionInput = {
        expectedFrom: { type: field.type, options: field.options },
        toType: 'text',
        toOptions: {},
        settings: {},
        locale: 'en',
        timeZone: 'UTC',
      };
      const started = await schema.startConversion(scopeA, field.id, input, context);
      await jobs.markRunning(scopeA, started.jobId);
      for (;;) {
        const batch = await mutation.convertFieldBatch(scopeA, started.jobId, 500);
        if (batch === undefined) throw new Error('conversion not running');
        if (!batch.done) continue;
        const end = await schema.finishConversion(scopeA, started.jobId, {
          status: 'succeeded',
          counts: { ...batch.counts },
        });
        if (end === 'finished') break;
      }
      expect(await cursors.get(scopeA, field.id)).toBeUndefined();
      const revertedAt = Date.now();
      const reverted = await schema.revertConversion(scopeA, field.id, context);
      expect(reverted.type).toBe('datetime');
      expect((await cursors.get(scopeA, field.id))?.armedAt.getTime()).toBeGreaterThanOrEqual(
        revertedAt - 1000,
      );
      fld.life = reverted;
    });

    it('lets a table in the trash pass and removes the cursors of a purged table', async () => {
      const { table } = await schema.createTable(
        scopeA,
        { baseId: a.baseId, name: 'Scratch', primaryFieldName: 'title' },
        context,
      );
      const due = await schema.addField(
        scopeA,
        table.id,
        {
          name: 'due',
          type: 'datetime',
          options: { reminder: { recipients: 'users', user_ids: [users.u_reader] } },
        },
        context,
      );
      expect(await cursors.get(scopeA, due.id)).toBeDefined();
      await schema.deleteTable(scopeA, table.id, context);
      // Nothing reminds of the time spent in the trash.
      expect(await scan(due, at('2030-01-01T00:00:00Z'))).toMatchObject({
        outcome: 'field_unavailable',
      });
      expect((await cursors.get(scopeA, due.id))?.scannedUntil.toISOString()).toBe(
        '2030-01-01T00:00:00.000Z',
      );
      await schema.purgeTable(
        scopeA,
        table.id,
        { reason: 'manual', confirmName: 'Scratch' },
        context,
      );
      expect(await cursors.get(scopeA, due.id)).toBeUndefined();
    });
  });

  describe('when reminders fire (DateReminderScanner, injected clock)', () => {
    it('a date-only field in Asia/Ho_Chi_Minh, 09:00 a day before, while the organization is in UTC', async () => {
      const field = await setReminder(fld.due_vn, {
        recipients: 'users',
        user_ids: [users.u_reader],
        offset_minutes: -1440,
      });
      const [record] = (await create([{ title: 'vn', due_vn: '2027-03-10' }])) as [Id<'rec'>];
      // 2027-03-09 09:00 in Ho Chi Minh City = 02:00 UTC.
      expect(await scan(field, at('2027-03-09T01:59:59.999Z'))).toMatchObject({
        outcome: 'idle',
        reminders: 0,
      });
      expect(await takeReminders()).toEqual([]);
      expect(await scan(field, at('2027-03-09T02:00:00.000Z'))).toEqual<DateReminderResult>({
        organizationId: ORG_A,
        fieldId: field.id,
        outcome: 'reminded',
        reminders: 1,
      });
      const [payload] = (await takeReminders()) as [NotificationsFanoutPayload];
      expect(payload).toEqual({
        organization_id: ORG_A,
        type: 'date.reminder',
        base_id: a.baseId,
        table_id: orders.id,
        entity_type: 'record',
        entity_id: record,
        actor: null,
        group_key: `${field.id}:${record}:2027-03-10`,
        recipients: { user_ids: [users.u_reader], base_admins: false },
        requires: { record_id: record, field_ids: [field.id] },
        skip_actor: true,
        data: { field_id: field.id, due_at: '2027-03-09T02:00:00.000Z', value: '2027-03-10' },
      });
      // Once only.
      expect(await scan(field, at('2027-03-09T02:30:00.000Z'))).toMatchObject({
        outcome: 'idle',
      });
      // The recipient gets it (record and date field readable when sent).
      expect((await fanout.run(payload)).skipped).toEqual([]);
      expect(await notificationsOf(record)).toEqual([
        {
          user_id: users.u_reader,
          type: 'date.reminder',
          entity_id: record,
          group_key: `${field.id}:${record}:2027-03-10`,
          payload: {
            field_id: field.id,
            due_at: '2027-03-09T02:00:00.000Z',
            value: '2027-03-10',
          },
          actor_type: null,
        },
      ]);
    });

    it("a date-only field without a zone uses the organization's zone", async () => {
      await sql`UPDATE meta.organizations SET settings = settings || '{"timezone":"Asia/Tokyo"}'::jsonb
                 WHERE id = ${ORG_A}`.execute(db.kysely);
      try {
        const field = await setReminder(fld.day_org, {
          recipients: 'users',
          user_ids: [users.u_reader],
          time_of_day: '08:30',
        });
        await create([{ title: 'tokyo', day_org: '2027-04-01' }]);
        // 2027-04-01 08:30 in Tokyo = 2027-03-31 23:30 UTC.
        expect(await scan(field, at('2027-03-31T23:29:00Z'))).toMatchObject({ outcome: 'idle' });
        expect(await scan(field, at('2027-03-31T23:30:00Z'))).toMatchObject({
          outcome: 'reminded',
          reminders: 1,
        });
        expect((await takeReminders())[0]?.data).toMatchObject({
          due_at: '2027-03-31T23:30:00.000Z',
        });
      } finally {
        await sql`UPDATE meta.organizations SET settings = settings - 'timezone'
                   WHERE id = ${ORG_A}`.execute(db.kysely);
      }
    });

    it('a field with a time, 15 minutes before; a stopped worker catches up once per record; new values', async () => {
      const field = await setReminder(fld.deadline, {
        recipients: 'users',
        user_ids: [users.u_reader],
        offset_minutes: -15,
      });
      const [first] = (await create([
        { title: 'first', deadline: '2027-05-01T10:00:00.000Z' },
      ])) as [Id<'rec'>];
      expect(await scan(field, at('2027-05-01T09:44:59.999Z'))).toMatchObject({
        outcome: 'idle',
      });
      expect(await scan(field, at('2027-05-01T09:45:00.000Z'))).toMatchObject({
        outcome: 'reminded',
        reminders: 1,
      });
      expect((await takeReminders()).map((payload) => payload.data)).toEqual([
        {
          field_id: field.id,
          due_at: '2027-05-01T09:45:00.000Z',
          value: '2027-05-01T10:00:00.000Z',
        },
      ]);

      // Five records due 09:46 … 09:50 the next day; the worker stops 10 minutes.
      const later = await create(
        [1, 2, 3, 4, 5].map((n) => ({
          title: `later ${String(n)}`,
          deadline: `2027-05-02T10:0${String(n)}:00.000Z`,
        })),
      );
      expect(await scan(field, at('2027-05-02T09:40:00Z'))).toMatchObject({ outcome: 'idle' });
      expect(await scan(field, at('2027-05-02T09:55:00Z'))).toMatchObject({
        outcome: 'reminded',
        reminders: 5,
      });
      const caught = await takeReminders();
      expect(caught.map((payload) => payload.entity_id)).toEqual(later);
      expect(caught.map((payload) => payload.data['due_at'])).toEqual([
        '2027-05-02T09:46:00.000Z',
        '2027-05-02T09:47:00.000Z',
        '2027-05-02T09:48:00.000Z',
        '2027-05-02T09:49:00.000Z',
        '2027-05-02T09:50:00.000Z',
      ]);
      // A scan run twice, or the next one, queues nothing again.
      expect(await scan(field, at('2027-05-02T09:55:00Z'))).toMatchObject({ outcome: 'idle' });
      expect(await scan(field, at('2027-05-02T09:56:00Z'))).toMatchObject({ outcome: 'idle' });
      expect(await takeReminders()).toEqual([]);

      // A new value after the reminder: reminded again for it, with its own key.
      await update(first, { deadline: '2027-05-02T12:00:00.000Z' });
      expect(await scan(field, at('2027-05-02T11:45:00Z'))).toMatchObject({
        outcome: 'reminded',
        reminders: 1,
      });
      const [again] = (await takeReminders()) as [NotificationsFanoutPayload];
      expect(again).toMatchObject({
        entity_id: first,
        group_key: `${field.id}:${first}:2027-05-02T12:00:00.000Z`,
        data: { due_at: '2027-05-02T11:45:00.000Z', value: '2027-05-02T12:00:00.000Z' },
      });
      await fanout.run(again);
      expect(await notificationsOf(first)).toHaveLength(1);

      // Back to the old value: its moment is behind the cursor — nothing.
      await update(first, { deadline: '2027-05-01T10:00:00.000Z' });
      expect(await scan(field, at('2027-05-02T13:00:00Z'))).toMatchObject({ outcome: 'idle' });

      // A value already reminded of that comes due again (the offset changed:
      // re-armed, no catch-up) is queued again but never notified twice.
      await update(first, { deadline: '2027-05-02T12:00:00.000Z' });
      const moved = await setReminder(field, {
        recipients: 'users',
        user_ids: [users.u_reader],
        offset_minutes: 120,
      });
      expect(await scan(moved, at('2027-05-02T14:00:00Z'))).toMatchObject({
        outcome: 'reminded',
        reminders: 1,
      });
      const [repeat] = (await takeReminders()) as [NotificationsFanoutPayload];
      expect(repeat.group_key).toBe(`${field.id}:${first}:2027-05-02T12:00:00.000Z`);
      const result = await fanout.run(repeat);
      expect(result.written).toEqual([
        {
          userId: users.u_reader,
          id: null,
          inApp: false,
          emailQueued: false,
          telegramQueued: false,
        },
      ]);
      expect(await notificationsOf(first)).toHaveLength(1);
    });

    it('DST in America/New_York: a skipped wall time fires shifted, a repeated one at the earlier instant', async () => {
      const spring = await setReminder(fld.ny_spring, {
        recipients: 'users',
        user_ids: [users.u_reader],
        time_of_day: '02:30',
      });
      const fall = await setReminder(fld.ny_fall, {
        recipients: 'users',
        user_ids: [users.u_reader],
        time_of_day: '01:30',
      });
      const [before, gap] = await create([
        { title: 'EST day', ny_spring: '2027-03-13' },
        { title: 'gap day', ny_spring: '2027-03-14' },
      ]);
      const [repeated] = await create([{ title: 'repeat day', ny_fall: '2027-11-07' }]);
      const dues = async () =>
        (await takeReminders()).map((payload) => [payload.entity_id, payload.data['due_at']]);
      // 2027-03-13 02:30 EST = 07:30 UTC.
      expect(await scan(spring, at('2027-03-13T07:29:00Z'))).toMatchObject({ outcome: 'idle' });
      expect(await scan(spring, at('2027-03-13T07:30:00Z'))).toMatchObject({ reminders: 1 });
      expect(await dues()).toEqual([[before, '2027-03-13T07:30:00.000Z']]);
      // 2027-03-14 02:30 does not exist (02:00 → 03:00): 03:30 EDT = 07:30 UTC.
      expect(await scan(spring, at('2027-03-14T07:29:00Z'))).toMatchObject({ outcome: 'idle' });
      expect(await scan(spring, at('2027-03-14T07:30:00Z'))).toMatchObject({ reminders: 1 });
      expect(await dues()).toEqual([[gap, '2027-03-14T07:30:00.000Z']]);
      // 2027-11-07 01:30 happens twice (EDT, then EST): the earlier, 05:30 UTC, once.
      expect(await scan(fall, at('2027-11-07T05:29:00Z'))).toMatchObject({ outcome: 'idle' });
      expect(await scan(fall, at('2027-11-07T05:30:00Z'))).toMatchObject({ reminders: 1 });
      expect(await dues()).toEqual([[repeated, '2027-11-07T05:30:00.000Z']]);
      expect(await scan(fall, at('2027-11-07T07:00:00Z'))).toMatchObject({ outcome: 'idle' });
    });

    it('never reminds of moments passed before it was turned on, nor of records in the trash', async () => {
      const now = Date.now();
      const [past, soon, trashed] = await create([
        { title: 'past', late: new Date(now - 60 * MINUTE).toISOString() },
        { title: 'soon', late: new Date(now + 30 * MINUTE).toISOString() },
        { title: 'trashed', late: new Date(now + 40 * MINUTE).toISOString() },
      ]);
      const field = await setReminder(fld.late, {
        recipients: 'users',
        user_ids: [users.u_reader],
      });
      await mutation.delete(
        scopeA,
        orders.id,
        await accessFor(a.userId),
        { ids: [trashed as string] },
        auditOf(a.userId),
      );
      expect(await scan(field, new Date(now + 2 * 60 * MINUTE))).toMatchObject({
        outcome: 'reminded',
        reminders: 1,
      });
      const queued = (await takeReminders()).map((payload) => payload.entity_id);
      expect(queued).toEqual([soon]);
      expect(queued).not.toContain(past);
    });

    it('field_user: the users of the field when it fires (user, created_by, several users)', async () => {
      const field = await setReminder(fld.owner_due, {
        recipients: 'field_user',
        user_field_id: fld.owner.id,
      });
      const [reassigned] = (await create([
        { title: 'reassigned', owner: [{ id: users.u_sales1 }], owner_due: '2027-07-01T10:00:00Z' },
        { title: 'nobody', owner_due: '2027-07-01T10:00:00Z' },
      ])) as [Id<'rec'>, Id<'rec'>];
      await update(reassigned, { owner: [{ id: users.u_sales2 }] });
      expect(await scan(field, at('2027-07-01T10:00:00Z'))).toMatchObject({
        outcome: 'reminded',
        reminders: 1,
      });
      const [payload] = (await takeReminders()) as [NotificationsFanoutPayload];
      expect(payload).toMatchObject({
        entity_id: reassigned,
        recipients: { user_ids: [users.u_sales2], base_admins: false },
      });
      const delivered = await fanout.run(payload);
      expect(delivered.written.map((item) => item.userId)).toEqual([users.u_sales2]);

      // `created_by`, then a multiple user field.
      const byCreator = await setReminder(field, {
        recipients: 'field_user',
        user_field_id: fld.creator.id,
      });
      const [mine] = await create([{ title: 'created', owner_due: '2027-07-02T10:00:00Z' }]);
      expect(await scan(byCreator, at('2027-07-02T10:00:00Z'))).toMatchObject({ reminders: 1 });
      expect(await takeReminders()).toEqual([
        expect.objectContaining({
          entity_id: mine,
          recipients: { user_ids: [a.userId], base_admins: false },
        }),
      ]);
      const byWatchers = await setReminder(byCreator, {
        recipients: 'field_user',
        user_field_id: fld.watchers.id,
      });
      const [watched] = await create([
        {
          title: 'watched',
          watchers: [{ id: users.u_reader }, { id: users.u_sales1 }],
          owner_due: '2027-07-03T10:00:00Z',
        },
      ]);
      expect(await scan(byWatchers, at('2027-07-03T10:00:00Z'))).toMatchObject({
        reminders: 1,
      });
      expect(await takeReminders()).toEqual([
        expect.objectContaining({
          entity_id: watched,
          recipients: { user_ids: [users.u_reader, users.u_sales1], base_admins: false },
        }),
      ]);

      // The recipient field gone: the window passes, nothing is queued.
      await schema.deleteField(scopeA, fld.watchers.id, context);
      try {
        await create([{ title: 'orphan', owner_due: '2027-07-04T10:00:00Z' }]);
        expect(await scan(byWatchers, at('2027-07-04T10:00:00Z'))).toMatchObject({
          outcome: 'recipient_field_unavailable',
          reminders: 0,
        });
        expect(await takeReminders()).toEqual([]);
        // Another option of the field still saves (the stale reminder is left as it is)…
        const restyled = await schema.updateFieldOptions(
          scopeA,
          byWatchers.id,
          {
            options: {
              ...(byWatchers.options as JsonObject),
              style: { format: 'dd/MM/yyyy HH:mm' },
            },
          },
          context,
        );
        expect(restyled.options).toMatchObject({
          reminder: { recipients: 'field_user', user_field_id: fld.watchers.id },
        });
        // …but naming the gone field in a new reminder does not.
        const error = await appError(
          setReminder(restyled, {
            recipients: 'field_user',
            user_field_id: fld.watchers.id,
            offset_minutes: -5,
          }),
        );
        expect(error.errors?.map((item) => item.code)).toEqual(['UNKNOWN_FIELD']);
      } finally {
        fld.watchers = await schema.restoreField(scopeA, fld.watchers.id, context);
      }
    });

    it('caps reminders per field and scan; many records due at one moment all get one', async () => {
      const field = await setReminder(fld.cap_day, {
        recipients: 'users',
        user_ids: [users.u_reader],
      });
      const sameDay = await create(
        Array.from({ length: 7 }, (_, n) => ({ title: `cap ${String(n)}`, cap_day: '2027-08-01' })),
      );
      const [nextDay] = await create([{ title: 'cap next', cap_day: '2027-08-02' }]);
      const capped = new DateReminderScanner(db, {
        defaults: DEFAULTS,
        records: query,
        maxPerScan: 3,
        pageSize: 2,
      });
      const now = at('2027-08-01T09:00:00Z');
      const seen: string[] = [];
      const outcomes: DateReminderResult[] = [];
      for (let n = 0; n < 4; n += 1) {
        outcomes.push(await scan(field, now, capped));
        seen.push(...(await takeReminders()).map((payload) => payload.entity_id));
        if (n === 0) {
          // Stopped just before that moment, remembering the last record reminded
          // of (a keyset: every record of that moment up to it is done — QA S5b M7).
          const cursor = await cursors.get(scopeA, field.id);
          expect(cursor?.scannedUntil.toISOString()).toBe('2027-08-01T08:59:59.999Z');
          expect(cursor?.boundaryDueAt?.toISOString()).toBe(now.toISOString());
          expect(cursor?.boundaryRecordIds).toHaveLength(1);
          expect(seen).toContain(cursor?.boundaryRecordIds[0]);
        }
      }
      expect(outcomes.map((item) => [item.outcome, item.reminders])).toEqual([
        ['capped', 3],
        ['capped', 3],
        ['reminded', 1],
        ['idle', 0],
      ]);
      expect(seen).toHaveLength(7);
      expect([...seen].sort()).toEqual([...sameDay].sort());
      const cursor = await cursors.get(scopeA, field.id);
      expect(cursor).toMatchObject({ boundaryDueAt: null, boundaryRecordIds: [] });
      expect(cursor?.scannedUntil.toISOString()).toBe(now.toISOString());
      // The next day is untouched by the cap.
      expect(await scan(field, at('2027-08-02T09:00:00Z'), capped)).toMatchObject({
        reminders: 1,
      });
      expect((await takeReminders()).map((payload) => payload.entity_id)).toEqual([nextDay]);
    });

    it('P41: each recipient must read the record, then the date field, when it is sent', async () => {
      const field = await setReminder(fld.p41, {
        recipients: 'users',
        user_ids: [users.u_sales1, users.u_reader],
      });
      const [r1, r2] = (await create([
        { title: 'r1', owner: [{ id: users.u_sales1 }], p41: '2027-09-10' },
        { title: 'r2', owner: [{ id: users.u_sales2 }], p41: '2027-09-10' },
      ])) as [Id<'rec'>, Id<'rec'>];
      // 2027-09-10 09:00 in Ho Chi Minh City = 02:00 UTC.
      expect(await scan(field, at('2027-09-10T02:00:00Z'))).toMatchObject({ reminders: 2 });
      const byRecord = new Map(
        (await deliver()).map(({ payload, result }) => [payload.entity_id, result]),
      );
      expect(byRecord.get(r2)?.skipped).toEqual([
        { userId: users.u_sales1, reason: 'cannot_read_record' },
      ]);
      expect(byRecord.get(r2)?.written.map((item) => item.userId)).toEqual([users.u_reader]);
      expect(byRecord.get(r1)?.skipped).toEqual([]);

      // Sales loses the date field: skipped on its own record.
      const config = structuredClone(salesConfig);
      const rule = config.tables?.[orders.id];
      if (rule === undefined) throw new Error('no rule');
      rule.field_rule = { ...rule.field_rule, fields: { [field.id]: 'no_perm' } };
      await new BaseRolesRepository(db).update(scopeA, a.baseId, salesRole, {
        config: roleConfigSchema.parse(config) as unknown as JsonObject,
      });
      try {
        const [r1b] = await create([
          { title: 'r1b', owner: [{ id: users.u_sales1 }], p41: '2027-09-11' },
        ]);
        expect(await scan(field, at('2027-09-11T02:00:00Z'))).toMatchObject({ reminders: 1 });
        const [variant] = await deliver();
        expect(variant?.payload.entity_id).toBe(r1b);
        expect(variant?.result.skipped).toEqual([
          { userId: users.u_sales1, reason: 'cannot_read_field' },
        ]);
        expect(variant?.result.written.map((item) => item.userId)).toEqual([users.u_reader]);
      } finally {
        await new BaseRolesRepository(db).update(scopeA, a.baseId, salesRole, {
          config: roleConfigSchema.parse(salesConfig) as unknown as JsonObject,
        });
      }
    });
  });

  describe('tenant isolation (AGENTS.md rule 5)', () => {
    it('keeps cursors inside their organization', async () => {
      const field = fld.due_vn;
      const mine = await cursors.get(scopeA, field.id);
      expect(mine).toBeDefined();
      expect(await cursors.get(scopeB, field.id)).toBeUndefined();
      await db.withTx(async (tx) => {
        expect(await cursors.lock(withTxScope(scopeB, tx), field.id)).toBeUndefined();
      });
      await cursors.advance(scopeB, field.id, at('2031-01-01T00:00:00Z'), null);
      expect(await cursors.remove(scopeB, [field.id])).toBe(0);
      expect(await cursors.get(scopeA, field.id)).toEqual(mine);
      // The composite foreign key refuses a cursor naming another organization's field.
      await expect(cursors.arm(scopeB, field.id, new Date())).rejects.toThrow(/foreign key/u);
      await expect(cursors.lock(scopeA, field.id)).rejects.toThrow(/transaction/u);
    });

    it('scans a field only in its own organization', async () => {
      // Another organization's field named with this one: nothing to lock, nothing queued.
      expect(
        await scanner.scanField({ organizationId: ORG_B, fieldId: fld.due_vn.id }, new Date()),
      ).toMatchObject({ outcome: 'turned_off', reminders: 0 });
      expect(await cursors.get(scopeA, fld.due_vn.id)).toBeDefined();
      const accessB = await resolveMemberBaseAccess(
        db,
        scopeB,
        { userId: b.userId, baseId: b.baseId },
        DEFAULTS,
      );
      if (accessB === undefined) throw new Error('no access in B');
      const created = await mutation.create(
        scopeB,
        tableB.id,
        accessB.record,
        { records: [{ fields: { title: 'b', due: '2027-10-01' } }] },
        auditOf(b.userId),
      );
      const result = await scanner.scanField(
        { organizationId: ORG_B, fieldId: dueB.id },
        at('2027-10-01T09:00:00Z'),
      );
      expect(result).toMatchObject({ outcome: 'reminded', reminders: 1 });
      expect(await takeReminders()).toEqual([
        expect.objectContaining({
          organization_id: ORG_B,
          entity_id: created.records[0]?.id,
          recipients: { user_ids: [b.userId], base_admins: false },
        }),
      ]);
    });

    it('lists fields with a reminder across organizations by ids only, keyset-paged', async () => {
      const all = await listDateReminderFields(db.kysely, { after: null, limit: 1000 });
      for (const item of all) {
        expect(Object.keys(item).sort()).toEqual(['fieldId', 'organizationId']);
      }
      expect(all).toContainEqual({ organizationId: ORG_B, fieldId: dueB.id });
      expect(all).toContainEqual({ organizationId: ORG_A, fieldId: fld.due_vn.id });
      expect(all.map((item) => item.fieldId)).not.toContain(fld.title.id);
      const paged: typeof all = [];
      let after: (typeof all)[number] | null = null;
      for (;;) {
        const page = await listDateReminderFields(db.kysely, { after, limit: 2 });
        paged.push(...page);
        after = page.at(-1) ?? null;
        if (page.length < 2) break;
      }
      expect(paged).toEqual(all);
      // Organizations in order (ids within one follow the database collation).
      const orgs = all.map((item) => item.organizationId);
      expect(orgs).toEqual([...orgs].sort());
    });

    it('scanAll handles every field of every organization once', async () => {
      const listed = await listDateReminderFields(db.kysely, { after: null, limit: 1000 });
      const tick = await scanner.scanAll(at('2027-10-02T09:00:00Z'));
      expect(tick.fields).toBe(listed.length);
      expect(tick.results.map((item) => item.fieldId).sort()).toEqual(
        listed.map((item) => item.fieldId).sort(),
      );
      await takeReminders();
    });
  });
});
