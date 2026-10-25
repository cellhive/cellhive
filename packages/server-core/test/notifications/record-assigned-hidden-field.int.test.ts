/**
 * QA T559 H1: a grouped `record.assigned` (bulk write, import) counts,
 * lists and auto-follows a record only when the assignee reads a `user`
 * field they were added to **on that record** — being in a field they
 * cannot read is not disclosed, as for a single write (P40,
 * `cannot_read_field`). The grouping is linear in the rows of one assignee
 * (it ran in the worker event loop with `Array.includes`). The email and
 * Telegram check drops an assignment whose field the recipient no longer
 * reads (QA T559 M1), and a `field_user` date reminder whose recipient field
 * the recipient no longer reads (T560, the delivery side of QA T559 H3).
 */
import { type Id } from '@cellhive/contracts';
import { roleConfigSchema, type RoleConfigInput } from '@cellhive/permissions';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  orgScope,
  UsersRepository,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import {
  NotificationBuffer,
  NotificationDeliveryChecker,
  NotificationFanout,
  NotificationFlusher,
  RecordAssignedGrouper,
  type PendingDelivery,
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

const ORG: Id<'org'> = 'org_QaT559LeaksOrg01';
const recordIdOf = (i: number): Id<'rec'> => `rec_${String(i).padStart(22, '0')}`;
const DEFAULTS = { timeZone: 'UTC', locale: 'en' };

describe('record.assigned grouped: per-record field access (QA T559 H1)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let a: SeededTenant;
  let scope: OrgScope;
  let table: TableRow;
  let title: FieldRow;
  let owner: FieldRow; // user field the recipient reads
  let reviewers: FieldRow; // user field hidden from the recipient
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;
  let query: RecordQueryService;
  let fanout: NotificationFanout;
  const partial: Id<'usr'> = 'usr_QaT559Partial001';

  async function role(name: string, config: RoleConfigInput, members: readonly Id<'usr'>[]) {
    const created = await new BaseRolesRepository(db).create(scope, {
      baseId: a.baseId,
      name,
      kind: 'custom',
      config: roleConfigSchema.parse(config) as unknown as JsonObject,
    });
    for (const userId of members) {
      await new BaseRoleMembersRepository(db).assign(scope, {
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
    pool = new pg.Pool({ connectionString: database.url, max: 2 });
    a = await seedTenant(db, ORG);
    scope = orgScope(ORG);
    await db.kysely
      .insertInto('meta.users')
      .values({ id: partial, email: 'partial@qa-t559.test', display_name: 'partial' })
      .execute();
    await db.kysely
      .insertInto('meta.org_members')
      .values([
        { organization_id: ORG, user_id: a.userId, role: 'owner' },
        { organization_id: ORG, user_id: partial, role: 'member' },
      ])
      .execute();

    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const created = await schema.createTable(
      scope,
      { baseId: a.baseId, name: 'Orders', primaryFieldName: 'title' },
      systemAuditContext(),
    );
    table = created.table;
    title = created.primaryField;
    owner = await schema.addField(
      scope,
      table.id,
      { name: 'owner', type: 'user', options: { multiple: true, notify_on_assign: true } },
      systemAuditContext(),
    );
    reviewers = await schema.addField(
      scope,
      table.id,
      { name: 'reviewers', type: 'user', options: { multiple: true, notify_on_assign: true } },
      systemAuditContext(),
    );
    [r1, r2] = (await insertRows(pool, table, [
      { [title.db_column_name as string]: 'Order R1' },
      { [title.db_column_name as string]: 'Order R2 (assigned via hidden reviewers)' },
    ])) as [Id<'rec'>, Id<'rec'>];
    // `partial` reads every record and every field except `reviewers`.
    await role(
      'Partial',
      {
        tables: {
          [table.id]: {
            perm: 'read_only',
            field_rule: {
              mode: 'specify',
              fields: { [reviewers.id]: 'no_perm' },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
        },
      },
      [partial],
    );
    query = new RecordQueryService(db);
    fanout = new NotificationFanout(db, query, { emailEnabled: false, defaults: DEFAULTS });
  });

  afterAll(async () => {
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  it('a record assigned only through a field the assignee cannot read is not counted, listed or followed', async () => {
    const batchId = 'req_QaT559Batch000001';
    // One bulk write: partial added to `owner` of r1 (readable) and to `reviewers` of r2 (hidden).
    await db.withTx((tx) =>
      new NotificationBuffer(db).append(tx, {
        organizationId: ORG,
        kind: 'assigned',
        groupKey: batchId,
        rows: [
          { userId: partial, tableId: table.id, recordId: r1, fieldIds: [owner.id], actor: null },
          {
            userId: partial,
            tableId: table.id,
            recordId: r2,
            fieldIds: [reviewers.id],
            actor: null,
          },
        ],
      }),
    );
    const flusher = new NotificationFlusher(db, fanout, [new RecordAssignedGrouper(db)]);
    await flusher.flush({ organization_id: ORG, kind: 'assigned', group_key: batchId });

    const [notice] = await db.kysely
      .selectFrom('meta.notifications')
      .select(['payload'])
      .where('organization_id', '=', ORG)
      .where('user_id', '=', partial)
      .where('type', '=', 'record.assigned')
      .execute();
    const follows = await db.kysely
      .selectFrom('meta.record_follows')
      .select('record_id')
      .where('organization_id', '=', ORG)
      .where('user_id', '=', partial)
      .orderBy('record_id')
      .execute();

    // Expected (same rule as the single-write path, CONTRACTS §22.2 / P40):
    // only r1 counts; r2 (assigned only through hidden `reviewers`) is not
    // disclosed and not followed.
    expect(notice?.payload).toMatchObject({ count: 1, record_ids: [r1], field_ids: [owner.id] });
    expect(follows.map((row) => row.record_id)).toEqual([r1]);
  });

  it('the email/Telegram check drops a record.assigned whose user field the recipient no longer reads', async () => {
    // A single-write notification written while `partial` read `reviewers`;
    // since then, `reviewers` became hidden (role above). Simulated directly.
    const row: PendingDelivery = {
      notification_id: 'ntf_QaT559Single00001',
      attempts: 0,
      queued_at: new Date(),
      type: 'record.assigned',
      base_id: a.baseId,
      table_id: table.id,
      entity_type: 'record',
      entity_id: r2,
      payload: { batch_id: null, count: 1, record_ids: [r2], field_ids: [reviewers.id] },
      created_at: new Date(),
    };
    const user = await new UsersRepository(db).findById(partial);
    const checker = new NotificationDeliveryChecker(db, query, {
      publicUrl: 'https://cellhive.test',
      defaults: DEFAULTS,
    });
    const result = await checker.check(scope, user ?? expect.fail('no user'), [row], 'email');
    // Expected: dropped (`cannot_read_field`), like `date.reminder` / `followed_changed`.
    expect(result.kept).toHaveLength(0);
    expect(result.dropped.get('cannot_read_field')).toHaveLength(1);
  });

  it('the email/Telegram check drops a field_user date.reminder whose recipient field is no longer readable (T560)', async () => {
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const reminderTo = async (name: string, recipient: FieldRow) =>
      schema.addField(
        scope,
        table.id,
        {
          name,
          type: 'datetime',
          options: { reminder: { recipients: 'field_user', user_field_id: recipient.id } },
        },
        systemAuditContext(),
      );
    // Fanned out while `partial` read both fields; since then `reviewers`
    // became hidden (role above). `data` names the date field only.
    const toReviewers = await reminderTo('review due', reviewers);
    const toOwner = await reminderTo('owner due', owner);
    const toUsers = await schema.addField(
      scope,
      table.id,
      {
        name: 'fixed due',
        type: 'datetime',
        options: { reminder: { recipients: 'users', user_ids: [partial] } },
      },
      systemAuditContext(),
    );
    const reminderRow = (n: number, field: FieldRow): PendingDelivery => ({
      notification_id: `ntf_T560Reminder0000${String(n)}`,
      attempts: 0,
      queued_at: new Date(),
      type: 'date.reminder',
      base_id: a.baseId,
      table_id: table.id,
      entity_type: 'record',
      entity_id: r1,
      payload: { field_id: field.id, due_at: '2026-10-18T02:00:00.000Z', value: '2026-10-18' },
      created_at: new Date(),
    });
    const user = await new UsersRepository(db).findById(partial);
    const checker = new NotificationDeliveryChecker(db, query, {
      publicUrl: 'https://cellhive.test',
      defaults: DEFAULTS,
    });
    const rows = [reminderRow(1, toReviewers), reminderRow(2, toOwner), reminderRow(3, toUsers)];
    for (const channel of ['email', 'telegram'] as const) {
      const result = await checker.check(scope, user ?? expect.fail('no user'), rows, channel);
      expect(result.dropped.get('cannot_read_field')?.map((r) => r.notification_id)).toEqual([
        rows[0]?.notification_id,
      ]);
      expect(result.kept.map((kept) => kept.row.notification_id)).toEqual([
        rows[1]?.notification_id,
        rows[2]?.notification_id,
      ]);
    }
  });

  it('groups the rows of one assignee in linear time', async () => {
    const n = 50_000; // IMPORT_MAX_ROWS: one import assigning one person
    const rows = Array.from({ length: n }, (_, i) => ({
      id: String(i + 1),
      kind: 'assigned' as const,
      group_key: 'req_QaT559Perf',
      user_id: partial,
      table_id: table.id,
      record_id: recordIdOf(i),
      field_ids: [owner.id],
      actor_type: null,
      actor_id: null,
      created_at: new Date(),
    }));
    const started = performance.now();
    await db.withTx(async (tx) => {
      await new RecordAssignedGrouper(db).group({
        organizationId: ORG,
        kind: 'assigned',
        groupKey: 'req_QaT559Perf',
        rows,
        jobId: null,
        tx,
      });
    });
    const elapsed = performance.now() - started;
    // Linear: well under 100 ms; with `Array.includes` per row it took
    // ~25 s and blocked every job of the worker (no statement timeout applies).
    expect(elapsed).toBeLessThan(2_000);
  });
});
