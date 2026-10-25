/**
 * RecordMutationService (BACKLOG T107) on PostgreSQL 18: tables created by
 * `SchemaService`, access resolved by `@cellhive/permissions` as the api
 * access service does (CONTRACTS §5 fixture of T106).
 */
import { newId, type Id } from '@cellhive/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { BaseRolesRepository, BasesRepository, orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  MemberDirectoryRepository,
  RecordMutationService,
  RecordQueryService,
  type RecordAccessContext,
  type RecordChange,
} from '../../src/records/index.js';
import { SchemaService, TablesRepository, type SchemaChange } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow, JsonObject, TableRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T107MutationOrgA';
const ORG_B: Id<'org'> = 'org_T107MutationOrgB';

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

function auditOf(fx: OrdersFixture, user: keyof OrdersFixture['users']): AuditContext {
  const requestId = newId('req');
  return {
    actor: { type: 'user', id: fx.users[user].id },
    via: null,
    batch_id: requestId,
    request_id: requestId,
    ip: '192.0.2.10',
    user_agent: 'vitest',
  };
}

describe('RecordMutationService (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let schema: SchemaService;
  let service: RecordMutationService;
  let query: RecordQueryService;
  let fx: OrdersFixture;
  const published: RecordChange[][] = [];
  const scope = orgScope(ORG_A);
  let r1: Id<'rec'>, r2: Id<'rec'>, r3: Id<'rec'>;

  // `Items`: every S1 writable type, for values/unique/auto-number/upsert tests.
  let items: TableRow;
  const itf = {} as Record<
    'name' | 'code' | 'qty' | 'tags' | 'kind' | 'assignee' | 'due' | 'done' | 'ticket',
    FieldRow
  >;

  const as = (user: keyof OrdersFixture['users']): RecordAccessContext => accessOf(fx, user);
  const col = (field: FieldRow) => field.db_column_name as string;

  async function rows(table: TableRow, where = 'true'): Promise<Record<string, unknown>[]> {
    const result = await admin.query(
      `SELECT * FROM data.${pg.escapeIdentifier(table.db_table_name)} WHERE ${where} ORDER BY __auto`,
    );
    return result.rows as Record<string, unknown>[];
  }

  async function count(text: string, values: unknown[] = []): Promise<number> {
    const result = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${text}`,
      values,
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    admin = new pg.Pool({ connectionString: database.adminUrl, max: 4 });
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    service = new RecordMutationService(db, {
      schema,
      query,
      now: () => NOW,
      publisher: { publish: (changes) => void published.push([...changes]) },
    });
    fx = await buildOrdersFixture(db, schema, ORG_A);

    const context = systemAuditContext();
    const created = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Items', primaryFieldName: 'name' },
      context,
    );
    items = created.table;
    itf.name = created.primaryField;
    const add = (name: string, type: string, options: unknown = {}, uniqueValues = false) =>
      schema.addField(scope, items.id, { name, type, options, uniqueValues }, context);
    itf.code = await add('code', 'text', {}, true);
    itf.qty = await add('qty', 'number');
    itf.tags = await add('tags', 'select', {
      multiple: true,
      options: [
        { id: newId('opt'), name: 'A' },
        { id: newId('opt'), name: 'B' },
      ],
    });
    itf.kind = await add('kind', 'select', { options: [{ id: newId('opt'), name: 'Hàng' }] });
    itf.assignee = await add('assignee', 'user', {
      multiple: false,
      default_value: [{ $slot: 'current_user' }],
    });
    itf.due = await add('due', 'datetime', {
      style: { format: 'dd/MM/yyyy HH:mm' },
      default_value: { $slot: 'record_created_time' },
    });
    itf.done = await add('done', 'checkbox');
    itf.ticket = await add('ticket', 'auto_number', {
      style: {
        rules: [
          { type: 'text', text: 'IT-' },
          { type: 'incremental_number', length: 4 },
        ],
      },
    });
    fx.schema.tables.push({
      id: items.id,
      fields: Object.values(itf).map((field) => ({ id: field.id, type: field.type })),
    });

    // CONTRACTS §5 records, written by the admin through the service.
    const seeded = await service.create(
      scope,
      fx.orders.id,
      as('u_admin'),
      {
        field_key_type: 'id',
        records: [
          {
            fields: {
              [fx.fld.title.id]: 'r1',
              [fx.fld.amount.id]: 100,
              [fx.fld.cost.id]: 60,
              [fx.fld.status.id]: 'Mới',
              [fx.fld.owner.id]: [{ id: fx.users.u_sales1.id }],
            },
          },
          {
            fields: {
              [fx.fld.title.id]: 'r2',
              [fx.fld.owner.id]: [{ id: fx.users.u_sales2.id }],
            },
          },
          { fields: { [fx.fld.title.id]: 'r3' } },
        ],
      },
      auditOf(fx, 'u_admin'),
    );
    [r1, r2, r3] = seeded.records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
  });

  afterAll(async () => {
    await admin.end();
    await db.destroy();
    await database.drop();
  });

  describe('permissions (CONTRACTS §5)', () => {
    it('P09: u_sales1 updates r1.amount', async () => {
      const out = await service.update(
        scope,
        fx.orders.id,
        as('u_sales1'),
        { records: [{ id: r1, fields: { amount: 150 } }] },
        auditOf(fx, 'u_sales1'),
      );
      expect(out.records).toHaveLength(1);
      expect(out.records[0]?.fields).toMatchObject({ amount: 150 });
      // Hidden fields stay absent from the response.
      expect(out.records[0]?.fields).not.toHaveProperty('cost');
      expect(out.records[0]?.version).toBe(2);
    });

    it('P10: u_sales1 cannot write status (field `read`) → 403 FIELD_READ_ONLY', async () => {
      const error = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_sales1'),
          { records: [{ id: r1, fields: { status: 'Xong' } }] },
          auditOf(fx, 'u_sales1'),
        ),
      );
      expect(error.status).toBe(403);
      expect(error.code).toBe('FIELD_READ_ONLY');
      expect(error.errors?.[0]?.path).toBe('records[0].fields.status');
    });

    it('P11: u_sales1 updating r2 (outside the read scope) → 404', async () => {
      const error = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_sales1'),
          { records: [{ id: r2, fields: { amount: 1 } }] },
          auditOf(fx, 'u_sales1'),
        ),
      );
      expect(error.code).toBe('NOT_FOUND');
      expect(error.status).toBe(404);
    });

    it('P12: u_sales1 moving r1 to u_sales2 → 403 RECORD_RULE_VIOLATION, nothing written', async () => {
      const before = await rows(fx.orders, `__id = '${r1}'`);
      const error = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_sales1'),
          { records: [{ id: r1, fields: { owner: [{ id: fx.users.u_sales2.id }] } }] },
          auditOf(fx, 'u_sales1'),
        ),
      );
      expect(error.code).toBe('RECORD_RULE_VIOLATION');
      expect(error.status).toBe(403);
      expect(await rows(fx.orders, `__id = '${r1}'`)).toEqual(before);
    });

    it('P13: u_sales1 creates a record owned by u_sales1 → created', async () => {
      const out = await service.create(
        scope,
        fx.orders.id,
        as('u_sales1'),
        { records: [{ fields: { title: 'mine', owner: [{ id: fx.users.u_sales1.id }] } }] },
        auditOf(fx, 'u_sales1'),
      );
      expect(out.records[0]?.fields).toMatchObject({
        title: 'mine',
        owner: [{ id: fx.users.u_sales1.id, name: fx.users.u_sales1.name }],
        'created by': { id: fx.users.u_sales1.id },
      });
      expect(out.records[0]?.version).toBe(1);
    });

    it('P14: u_sales1 creating a record owned by u_sales2 → 403 RECORD_RULE_VIOLATION', async () => {
      const error = await appError(
        service.create(
          scope,
          fx.orders.id,
          as('u_sales1'),
          { records: [{ fields: { title: 'theirs', owner: [{ id: fx.users.u_sales2.id }] } }] },
          auditOf(fx, 'u_sales1'),
        ),
      );
      expect(error.code).toBe('RECORD_RULE_VIOLATION');
      expect(
        await count(
          `data.${pg.escapeIdentifier(fx.orders.db_table_name)} WHERE ${pg.escapeIdentifier(col(fx.fld.title))} = 'theirs'`,
        ),
      ).toBe(0);
    });

    it('P15: u_sales1 cannot delete r1 (no `delete` operation) → 403', async () => {
      const error = await appError(
        service.delete(scope, fx.orders.id, as('u_sales1'), { ids: [r1] }, auditOf(fx, 'u_sales1')),
      );
      expect(error.code).toBe('PERMISSION_DENIED');
    });

    it('P03: u_reader cannot update (read_only table) → 403; P19: unreadable table → 404', async () => {
      const denied = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_reader'),
          { records: [{ id: r1, fields: { amount: 1 } }] },
          auditOf(fx, 'u_reader'),
        ),
      );
      expect(denied.code).toBe('PERMISSION_DENIED');
      const hidden = await appError(
        service.create(
          scope,
          fx.customers.id,
          as('u_sales1'),
          { records: [{ fields: { name: 'x' } }] },
          auditOf(fx, 'u_sales1'),
        ),
      );
      expect(hidden.code).toBe('NOT_FOUND');
    });

    it('a no_perm field is reported like a missing one (422 UNKNOWN_FIELD)', async () => {
      for (const key of ['cost', 'does not exist']) {
        const error = await appError(
          service.update(
            scope,
            fx.orders.id,
            as('u_sales1'),
            { records: [{ id: r1, fields: { [key]: 1 } }] },
            auditOf(fx, 'u_sales1'),
          ),
        );
        expect(error.code).toBe('VALIDATION_FAILED');
        expect(error.errors).toEqual([
          {
            path: `records[0].fields.${key}`,
            code: 'UNKNOWN_FIELD',
            message: 'Field does not exist',
          },
        ]);
      }
    });

    it('system fields are read-only (403 FIELD_READ_ONLY)', async () => {
      const error = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_admin'),
          { records: [{ id: r3, fields: { 'created by': null } }] },
          auditOf(fx, 'u_admin'),
        ),
      );
      expect(error.code).toBe('FIELD_READ_ONLY');
    });

    it('P04: u_editor updates r1.amount; u_editor deletes and restores r3', async () => {
      await service.update(
        scope,
        fx.orders.id,
        as('u_editor'),
        { records: [{ id: r1, fields: { amount: 200 } }] },
        auditOf(fx, 'u_editor'),
      );
      const audit = auditOf(fx, 'u_editor');
      const deleted = await service.delete(
        scope,
        fx.orders.id,
        as('u_editor'),
        { ids: [r3] },
        audit,
      );
      expect(deleted.ids).toEqual([r3]);
      const [row] = await rows(fx.orders, `__id = '${r3}'`);
      expect(row?.__deleted_by).toBe(fx.users.u_editor.id);
      expect(row?.__deleted_at).toBeInstanceOf(Date);
      const log = await admin.query(
        `SELECT action, before, after, batch_id FROM meta.audit_logs WHERE entity_id = $1 AND action = 'record.deleted'`,
        [r3],
      );
      expect(log.rows).toEqual([
        { action: 'record.deleted', before: null, after: null, batch_id: audit.batch_id },
      ]);
      // Deleting again: not found.
      expect(
        (await appError(service.delete(scope, fx.orders.id, as('u_editor'), { ids: [r3] }, audit)))
          .code,
      ).toBe('NOT_FOUND');
      const restored = await service.restore(
        scope,
        fx.orders.id,
        as('u_editor'),
        { ids: [r3] },
        auditOf(fx, 'u_editor'),
      );
      expect(restored.records.map((record) => record.id)).toEqual([r3]);
      const [back] = await rows(fx.orders, `__id = '${r3}'`);
      expect(back?.__deleted_at).toBeNull();
      expect(back?.__deleted_by).toBeNull();
    });
  });

  describe('versions and concurrency', () => {
    it('a stale version → 409 VERSION_CONFLICT with the current version, author and time', async () => {
      await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r2, fields: { amount: 222 } }] },
        auditOf(fx, 'u_admin'),
      );
      const current = await query.getRecord(scope, fx.orders.id, r2, as('u_admin'));
      const error = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_admin'),
          { records: [{ id: r2, version: current.version + 5, fields: { amount: 1 } }] },
          auditOf(fx, 'u_admin'),
        ),
      );
      expect(error.code).toBe('VERSION_CONFLICT');
      expect(error.status).toBe(409);
      expect(error.errors?.[0]).toMatchObject({
        path: 'records[0].version',
        params: {
          current_version: current.version,
          version: current.version + 5,
          updated_at: current.updated_at,
          updated_by: { id: fx.users.u_admin.id, name: fx.users.u_admin.name },
        },
      });
    });

    it('two concurrent updates with the same version: exactly one 409', async () => {
      const current = await query.getRecord(scope, fx.orders.id, r2, as('u_admin'));
      const attempt = (amount: number) =>
        service.update(
          scope,
          fx.orders.id,
          as('u_admin'),
          { records: [{ id: r2, version: current.version, fields: { amount } }] },
          auditOf(fx, 'u_admin'),
        );
      const results = await Promise.allSettled([attempt(11), attempt(22)]);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(((rejected[0] as PromiseRejectedResult).reason as AppError).code).toBe(
        'VERSION_CONFLICT',
      );
      const after = await query.getRecord(scope, fx.orders.id, r2, as('u_admin'));
      expect(after.version).toBe(current.version + 1);
    });

    it('an update that changes nothing keeps the version and writes no event', async () => {
      const current = await query.getRecord(scope, fx.orders.id, r2, as('u_admin'));
      const events = await count(`meta.events WHERE entity_id = $1`, [r2]);
      const out = await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r2, fields: { amount: current.fields.amount } }] },
        auditOf(fx, 'u_admin'),
      );
      expect(out.records[0]?.version).toBe(current.version);
      expect(await count(`meta.events WHERE entity_id = $1`, [r2])).toBe(events);
    });
  });

  describe('events, audit, data_version, realtime', () => {
    it('writes one event and one audit row per record in the same transaction', async () => {
      const tables = new TablesRepository(db);
      const before = (await tables.getById(scope, items.id))?.data_version ?? 0n;
      published.length = 0;
      const audit = auditOf(fx, 'u_admin');
      const created = await service.create(
        scope,
        items.id,
        as('u_admin'),
        { records: [{ fields: { name: 'e1', qty: 1 } }, { fields: { name: 'e2', tags: ['A'] } }] },
        audit,
      );
      const ids = created.records.map((record) => record.id);
      const updated = await service.update(
        scope,
        items.id,
        as('u_admin'),
        {
          records: ids.map((id) => ({ id, fields: { qty: 5, tags: ['B'] } })),
        },
        audit,
      );
      expect(updated.records.map((record) => record.version)).toEqual([2, 2]);

      interface AuditRow {
        action: string;
        entity_id: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
        batch_id: string;
      }
      const logs = await admin.query<AuditRow>(
        `SELECT action, entity_id, before, after, batch_id, via, actor_type, actor_id
           FROM meta.audit_logs WHERE entity_id = ANY($1) ORDER BY created_at, action`,
        [ids],
      );
      expect(logs.rows).toHaveLength(4);
      expect(new Set(logs.rows.map((row: { batch_id: string }) => row.batch_id))).toEqual(
        new Set([audit.batch_id]),
      );
      const optB = (itf.tags.options as { options: { id: string; name: string }[] }).options[1]?.id;
      const optA = (itf.tags.options as { options: { id: string; name: string }[] }).options[0]?.id;
      const e1Update = logs.rows.find(
        (row: { entity_id: string; action: string }) =>
          row.entity_id === ids[0] && row.action === 'record.updated',
      );
      // Only the changed fields, in storage form (option ids); computed fields never audited.
      expect(e1Update).toMatchObject({
        before: { [itf.qty.id]: 1, [itf.tags.id]: null },
        after: { [itf.qty.id]: 5, [itf.tags.id]: [optB] },
        actor_type: 'user',
        actor_id: fx.users.u_admin.id,
      });
      const e2Create = logs.rows.find(
        (row: { entity_id: string; action: string }) =>
          row.entity_id === ids[1] && row.action === 'record.created',
      );
      expect(e2Create?.before).toBeNull();
      expect(e2Create?.after).toMatchObject({ [itf.name.id]: 'e2', [itf.tags.id]: [optA] });
      expect(e2Create?.after).not.toHaveProperty(itf.ticket.id);

      const events = await admin.query<{ type: string; payload: unknown }>(
        `SELECT type, payload FROM meta.events WHERE entity_id = $1 ORDER BY created_at`,
        [ids[1]],
      );
      expect(events.rows.map((row: { type: string }) => row.type)).toEqual([
        'record.created',
        'record.updated',
      ]);
      expect(events.rows[1]?.payload).toMatchObject({
        table_id: items.id,
        record_version: 2,
        changes: {
          [itf.qty.id]: { from: null, to: 5 },
          [itf.tags.id]: { from: [optA], to: [optB] },
        },
      });
      // events.dispatch enqueued for each event.
      expect(
        await count(
          `graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id) WHERE task_identifier = 'events.dispatch' AND payload->>'event_id' = ANY($1)`,
          [
            (
              await admin.query(`SELECT id FROM meta.events WHERE entity_id = ANY($1)`, [ids])
            ).rows.map((row: { id: string }) => row.id),
          ],
        ),
      ).toBe(4);

      const after = (await tables.getById(scope, items.id))?.data_version ?? 0n;
      expect(after).toBe(before + 2n);
      expect(published.map((batch) => batch.map((change) => change.type))).toEqual([
        ['record.created', 'record.created'],
        ['record.updated', 'record.updated'],
      ]);
      expect(published[1]?.[0]).toMatchObject({ recordId: ids[0], version: 2, tableId: items.id });
    });

    it('a failure in the middle of a 1 000-record bulk writes nothing (no rows, events, audit)', async () => {
      const seed = await service.create(
        scope,
        items.id,
        as('u_admin'),
        {
          records: Array.from({ length: 1000 }, (_, index) => ({
            fields: { name: `bulk ${String(index)}` },
          })),
        },
        auditOf(fx, 'u_admin'),
      );
      expect(seed.records).toHaveLength(1000);
      const ids = seed.records.map((record) => record.id);
      const eventsBefore = await count('meta.events');
      const auditBefore = await count('meta.audit_logs');
      const versionBefore = (await new TablesRepository(db).getById(scope, items.id))?.data_version;
      const snapshot = await rows(items, `__id = ANY('{${ids.join(',')}}')`);

      // Invalid value at index 700: rejected before anything is written.
      const invalid = await appError(
        service.update(
          scope,
          items.id,
          as('u_admin'),
          {
            records: ids.map((id, index) => ({
              id,
              fields: { qty: index === 700 ? 'not a number' : index },
            })),
          },
          auditOf(fx, 'u_admin'),
        ),
      );
      expect(invalid.code).toBe('INVALID_CELL_VALUE');
      expect(invalid.errors).toEqual([
        expect.objectContaining({ path: 'records[700].fields.qty', code: 'EXPECTED_NUMBER' }),
      ]);

      // A database failure after the first 700 rows were already updated:
      // records 700+ change another column (second UPDATE), which a test
      // trigger rejects. Everything written before rolls back.
      const trigger = `t107_fail_${items.db_table_name}`;
      await admin.query(`CREATE FUNCTION public.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'boom'; END $$`);
      await admin.query(
        `CREATE TRIGGER ${trigger} BEFORE UPDATE OF ${pg.escapeIdentifier(col(itf.done))}
           ON data.${pg.escapeIdentifier(items.db_table_name)} FOR EACH ROW EXECUTE FUNCTION public.${trigger}()`,
      );
      try {
        await expect(
          service.update(
            scope,
            items.id,
            as('u_admin'),
            {
              records: ids.map((id, index) => ({
                id,
                fields: index < 700 ? { qty: index } : { done: true },
              })),
            },
            auditOf(fx, 'u_admin'),
          ),
        ).rejects.toThrow('boom');
      } finally {
        await admin.query(
          `DROP TRIGGER ${trigger} ON data.${pg.escapeIdentifier(items.db_table_name)}`,
        );
        await admin.query(`DROP FUNCTION public.${trigger}()`);
      }
      expect(await rows(items, `__id = ANY('{${ids.join(',')}}')`)).toEqual(snapshot);
      expect(await count('meta.events')).toBe(eventsBefore);
      expect(await count('meta.audit_logs')).toBe(auditBefore);
      expect((await new TablesRepository(db).getById(scope, items.id))?.data_version).toBe(
        versionBefore,
      );
    });

    it('more than 1 000 records → 413 PAYLOAD_TOO_LARGE', async () => {
      const error = await appError(
        service.create(
          scope,
          items.id,
          as('u_admin'),
          { records: Array.from({ length: 1001 }, () => ({ fields: {} })) },
          auditOf(fx, 'u_admin'),
        ),
      );
      expect(error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(error.status).toBe(413);
    });
  });

  describe('values', () => {
    it('typecast: "1.500.000", select names, user emails, empty text → null', async () => {
      const out = await service.create(
        scope,
        items.id,
        as('u_admin'),
        {
          typecast: true,
          records: [
            {
              fields: {
                name: 'typecast',
                code: '',
                qty: '1.500.000',
                tags: 'A, B',
                kind: 'Hàng',
                assignee: fx.users.u_sales1.email.toUpperCase(),
                done: 'có',
              },
            },
          ],
        },
        auditOf(fx, 'u_admin'),
      );
      expect(out.records[0]?.fields).toMatchObject({
        name: 'typecast',
        code: null,
        qty: 1500000,
        tags: ['A', 'B'],
        kind: 'Hàng',
        assignee: [{ id: fx.users.u_sales1.id }],
        done: true,
      });
    });

    it('defaults: current_user and record_created_time; auto_number assigned', async () => {
      const out = await service.create(
        scope,
        items.id,
        as('u_editor'),
        { records: [{ fields: { name: 'defaults' } }] },
        auditOf(fx, 'u_editor'),
      );
      const [row] = await rows(items, `__id = '${out.records[0]?.id ?? ''}'`);
      expect(row?.[col(itf.assignee)]).toEqual([fx.users.u_editor.id]);
      expect(row?.[col(itf.due)]).toEqual(row?.__created_at);
      expect(row?.[col(itf.ticket)]).toBe(`IT-${String(row?.__auto).padStart(4, '0')}`);
      expect(row?.__created_by).toBe(fx.users.u_editor.id);
    });

    it('a user email or id outside the organization → USER_NOT_FOUND', async () => {
      for (const assignee of [[{ email: 'nobody@example.test' }], [{ id: newId('usr') }]]) {
        const error = await appError(
          service.create(
            scope,
            items.id,
            as('u_admin'),
            { records: [{ fields: { name: 'x', assignee } }] },
            auditOf(fx, 'u_admin'),
          ),
        );
        expect(error.code).toBe('INVALID_CELL_VALUE');
        expect(error.errors?.[0]).toMatchObject({
          path: 'records[0].fields.assignee',
          code: 'USER_NOT_FOUND',
        });
      }
    });

    it('unknown option names: created for an admin with typecast, else INVALID_SELECT_OPTION', async () => {
      const editorError = await appError(
        service.create(
          scope,
          items.id,
          as('u_editor'),
          { typecast: true, records: [{ fields: { name: 'x', tags: ['C'] } }] },
          auditOf(fx, 'u_editor'),
        ),
      );
      expect(editorError.code).toBe('INVALID_SELECT_OPTION');
      expect(editorError.errors?.[0]).toMatchObject({
        path: 'records[0].fields.tags',
        code: 'INVALID_SELECT_OPTION',
      });
      const noTypecast = await appError(
        service.create(
          scope,
          items.id,
          as('u_admin'),
          { records: [{ fields: { name: 'x', tags: ['C'] } }] },
          auditOf(fx, 'u_admin'),
        ),
      );
      expect(noTypecast.code).toBe('INVALID_SELECT_OPTION');

      const out = await service.create(
        scope,
        items.id,
        as('u_admin'),
        { typecast: true, records: [{ fields: { name: 'new option', tags: 'A, C' } }] },
        auditOf(fx, 'u_admin'),
      );
      expect(out.records[0]?.fields.tags).toEqual(['A', 'C']);
      const field = await admin.query<{ options: { options: { name: string }[] } }>(
        'SELECT options FROM meta.fields WHERE id = $1',
        [itf.tags.id],
      );
      expect(field.rows[0]?.options.options.map((option) => option.name)).toEqual(['A', 'B', 'C']);
      expect(
        await count(`meta.audit_logs WHERE action = 'field.updated' AND entity_id = $1`, [
          itf.tags.id,
        ]),
      ).toBe(1);
    });

    it('an option created by a failed mutation is rolled back with it', async () => {
      const error = await appError(
        service.create(
          scope,
          items.id,
          as('u_admin'),
          {
            typecast: true,
            records: [{ fields: { name: 'x', tags: 'D' } }, { fields: { qty: 'nope' } }],
          },
          auditOf(fx, 'u_admin'),
        ),
      );
      expect(error.code).toBe('INVALID_CELL_VALUE');
      const field = await admin.query<{ options: { options: { name: string }[] } }>(
        'SELECT options FROM meta.fields WHERE id = $1',
        [itf.tags.id],
      );
      expect(field.rows[0]?.options.options.map((option) => option.name)).not.toContain('D');
    });

    it('publishes schema.changed for typecast-created options after commit, never on rollback', async () => {
      const seen: { change: SchemaChange; committedNames: string[] }[] = [];
      const spied = new SchemaService(db, {
        maxFieldsPerTable: 500,
        publisher: {
          publish: async (change) => {
            // Read through another connection: only committed options are visible.
            const row = await admin.query<{ options: { options: { name: string }[] } }>(
              'SELECT options FROM meta.fields WHERE id = $1',
              [change.entity_id],
            );
            seen.push({
              change,
              committedNames: row.rows[0]?.options.options.map((option) => option.name) ?? [],
            });
          },
        },
      });
      const spiedService = new RecordMutationService(db, { schema: spied, query, now: () => NOW });

      const failed = await appError(
        spiedService.create(
          scope,
          items.id,
          as('u_admin'),
          {
            typecast: true,
            records: [{ fields: { name: 'x', tags: 'Rolled back' } }, { fields: { qty: 'nope' } }],
          },
          auditOf(fx, 'u_admin'),
        ),
      );
      expect(failed.code).toBe('INVALID_CELL_VALUE');
      expect(seen).toEqual([]);

      await spiedService.create(
        scope,
        items.id,
        as('u_admin'),
        { typecast: true, records: [{ fields: { name: 'published', tags: 'Published' } }] },
        auditOf(fx, 'u_admin'),
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]?.change).toEqual({
        organization_id: ORG_A,
        base_id: fx.baseId,
        table_id: items.id,
        entity: 'field',
        entity_id: itf.tags.id,
        action: 'updated',
      });
      expect(seen[0]?.committedNames).toContain('Published');

      // Nothing new to create: nothing published.
      await spiedService.create(
        scope,
        items.id,
        as('u_admin'),
        { typecast: true, records: [{ fields: { name: 'again', tags: 'Published' } }] },
        auditOf(fx, 'u_admin'),
      );
      expect(seen).toHaveLength(1);
    });

    it('required fields → 422 REQUIRED_FIELD_MISSING', async () => {
      await schema.updateFieldOptions(scope, itf.qty.id, { required: true }, systemAuditContext());
      try {
        const error = await appError(
          service.create(
            scope,
            items.id,
            as('u_admin'),
            { records: [{ fields: { name: 'no qty' } }] },
            auditOf(fx, 'u_admin'),
          ),
        );
        expect(error.code).toBe('REQUIRED_FIELD_MISSING');
        expect(error.errors?.[0]?.path).toBe('records[0].fields.qty');
      } finally {
        await schema.updateFieldOptions(
          scope,
          itf.qty.id,
          { required: false },
          systemAuditContext(),
        );
      }
    });
  });

  describe('unique values', () => {
    it('rejects duplicates (table and request), ignores the trash, re-checks on restore', async () => {
      const audit = () => auditOf(fx, 'u_admin');
      const first = await service.create(
        scope,
        items.id,
        as('u_admin'),
        { records: [{ fields: { name: 'u1', code: 'X-1' } }] },
        audit(),
      );
      const dup = await appError(
        service.create(
          scope,
          items.id,
          as('u_admin'),
          {
            records: [
              { fields: { name: 'ok', code: 'X-2' } },
              { fields: { name: 'u2', code: 'X-1' } },
            ],
          },
          audit(),
        ),
      );
      expect(dup.code).toBe('UNIQUE_VIOLATION');
      expect(dup.errors).toEqual([expect.objectContaining({ path: 'records[1].fields.code' })]);
      const inRequest = await appError(
        service.create(
          scope,
          items.id,
          as('u_admin'),
          { records: [{ fields: { code: 'X-3' } }, { fields: { code: 'X-3' } }] },
          audit(),
        ),
      );
      expect(inRequest.errors).toEqual([
        expect.objectContaining({ path: 'records[1].fields.code' }),
      ]);

      const firstId = first.records[0]?.id as Id<'rec'>;
      await service.delete(scope, items.id, as('u_admin'), { ids: [firstId] }, audit());
      // The trashed record does not block the value.
      const second = await service.create(
        scope,
        items.id,
        as('u_admin'),
        { records: [{ fields: { name: 'u2', code: 'X-1' } }] },
        audit(),
      );
      const restore = await appError(
        service.restore(scope, items.id, as('u_admin'), { ids: [firstId] }, audit()),
      );
      expect(restore.code).toBe('UNIQUE_VIOLATION');
      expect(restore.errors).toEqual([expect.objectContaining({ path: 'ids[0]' })]);
      // Updating the live one away frees the value; restore then succeeds.
      await service.update(
        scope,
        items.id,
        as('u_admin'),
        { records: [{ id: second.records[0]?.id as string, fields: { code: 'X-9' } }] },
        audit(),
      );
      const restored = await service.restore(
        scope,
        items.id,
        as('u_admin'),
        { ids: [firstId] },
        audit(),
      );
      expect(restored.records[0]?.fields.code).toBe('X-1');
    });
  });

  describe('upsert', () => {
    it('creates or updates on merge_on and reports the ids', async () => {
      const audit = auditOf(fx, 'u_admin');
      const first = await service.upsert(
        scope,
        items.id,
        as('u_admin'),
        { merge_on: ['name'], records: [{ fields: { name: 'KH001', qty: 1 } }] },
        audit,
      );
      expect(first.created_ids).toHaveLength(1);
      expect(first.updated_ids).toEqual([]);
      const second = await service.upsert(
        scope,
        items.id,
        as('u_admin'),
        {
          merge_on: ['name'],
          records: [{ fields: { name: 'KH001', qty: 2 } }, { fields: { name: 'KH002', qty: 3 } }],
        },
        audit,
      );
      expect(second.updated_ids).toEqual(first.created_ids);
      expect(second.created_ids).toHaveLength(1);
      expect(second.records.map((record) => record.fields.qty)).toEqual([2, 3]);
      expect(second.records[0]?.version).toBe(2);
    });

    it('two matching records → 422 UPSERT_AMBIGUOUS', async () => {
      await service.create(
        scope,
        items.id,
        as('u_admin'),
        { records: [{ fields: { name: 'twin' } }, { fields: { name: 'twin' } }] },
        auditOf(fx, 'u_admin'),
      );
      const error = await appError(
        service.upsert(
          scope,
          items.id,
          as('u_admin'),
          { merge_on: ['name'], records: [{ fields: { name: 'twin', qty: 1 } }] },
          auditOf(fx, 'u_admin'),
        ),
      );
      expect(error.code).toBe('UPSERT_AMBIGUOUS');
      expect(error.status).toBe(422);
    });

    it('merge_on accepts 1–3 fields of the allowed types only', async () => {
      const error = await appError(
        service.upsert(
          scope,
          items.id,
          as('u_admin'),
          { merge_on: ['tags'], records: [{ fields: { name: 'x' } }] },
          auditOf(fx, 'u_admin'),
        ),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.errors?.[0]).toMatchObject({
        path: 'merge_on[0]',
        code: 'MERGE_FIELD_NOT_ALLOWED',
      });
    });

    it('matches only records the caller can read (u_sales1 does not see r2)', async () => {
      const out = await service.upsert(
        scope,
        fx.orders.id,
        as('u_sales1'),
        {
          merge_on: ['title'],
          records: [{ fields: { title: 'r2', owner: [{ id: fx.users.u_sales1.id }] } }],
        },
        auditOf(fx, 'u_sales1'),
      );
      expect(out.created_ids).toHaveLength(1);
      expect(out.updated_ids).toEqual([]);
    });
  });

  describe('realtime capture (T210)', () => {
    const changesOf = () => published.flat();

    beforeAll(async () => {
      // Store the Sales role so its edit rule (owner) is captured, then bump
      // permission_version as saving a role does.
      await new BaseRolesRepository(db).create(scope, {
        baseId: fx.baseId,
        name: 'Sales',
        kind: 'custom',
        config: fx.roles.sales.config as unknown as JsonObject,
      });
      await new BasesRepository(db).bumpPermissionVersion(scope, { baseIds: [fx.baseId] });
    });

    it('captures rule fields and changed fields before and after an update (P24)', async () => {
      published.length = 0;
      const { owner, amount } = fx.fld;
      const current = await query.getRecord(scope, fx.orders.id, r1, as('u_admin'));
      await service.update(
        scope,
        fx.orders.id,
        as('u_editor'),
        {
          field_key_type: 'id',
          records: [{ id: r1, fields: { [owner.id]: [{ id: fx.users.u_sales2.id }] } }],
        },
        auditOf(fx, 'u_editor'),
      );
      const [moved] = changesOf();
      expect(moved).toMatchObject({
        type: 'record.updated',
        recordId: r1,
        version: current.version + 1,
        changedFieldIds: [owner.id],
        actorUserId: fx.users.u_editor.id,
        actor: { type: 'user', id: fx.users.u_editor.id },
        before: { [owner.id]: [fx.users.u_sales1.id] },
        after: { [owner.id]: [fx.users.u_sales2.id] },
        values: {
          [owner.id]: [
            {
              id: fx.users.u_sales2.id,
              name: fx.users.u_sales2.name,
              email: fx.users.u_sales2.email,
            },
          ],
        },
      });
      expect(moved?.eventId).toMatch(/^evt_/);

      // A field outside the rules: the images still carry the rule field.
      const amountBefore = (
        await query.getRecord(scope, fx.orders.id, r1, as('u_admin'), { field_key_type: 'id' })
      ).fields[amount.id] as number | null;
      published.length = 0;
      await service.update(
        scope,
        fx.orders.id,
        as('u_editor'),
        { field_key_type: 'id', records: [{ id: r1, fields: { [amount.id]: 777 } }] },
        auditOf(fx, 'u_editor'),
      );
      const [patched] = changesOf();
      expect(patched?.before).toEqual({
        [owner.id]: [fx.users.u_sales2.id],
        [amount.id]: amountBefore,
      });
      expect(patched?.after).toEqual({ [owner.id]: [fx.users.u_sales2.id], [amount.id]: 777 });
      expect(patched?.values).toEqual({ [amount.id]: 777 });
      // The rest of the tests expect r1 with its CONTRACTS §5 owner.
      await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        {
          field_key_type: 'id',
          records: [{ id: r1, fields: { [owner.id]: [{ id: fx.users.u_sales1.id }] } }],
        },
        auditOf(fx, 'u_admin'),
      );
    });

    it('carries every field in json form for creates, and rule images for delete/restore', async () => {
      published.length = 0;
      const { title, status, owner, createdBy, cost } = fx.fld;
      const created = await service.create(
        scope,
        fx.orders.id,
        as('u_sales1'),
        {
          field_key_type: 'id',
          records: [
            {
              fields: {
                [title.id]: 'rt',
                [owner.id]: [{ id: fx.users.u_sales1.id }],
              },
            },
          ],
        },
        auditOf(fx, 'u_sales1'),
      );
      const id = created.records[0]?.id as Id<'rec'>;
      const [change] = changesOf();
      const sales1 = {
        id: fx.users.u_sales1.id,
        name: fx.users.u_sales1.name,
        email: fx.users.u_sales1.email,
      };
      expect(change).toMatchObject({
        type: 'record.created',
        recordId: id,
        version: 1,
        before: null,
        after: { [owner.id]: [fx.users.u_sales1.id] },
        values: {
          [title.id]: 'rt',
          [status.id]: null,
          [owner.id]: [sales1],
          [createdBy.id]: sales1,
          [cost.id]: null,
        },
      });

      published.length = 0;
      await service.delete(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [id] },
        auditOf(fx, 'u_admin'),
      );
      await service.restore(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [id] },
        auditOf(fx, 'u_admin'),
      );
      expect(
        changesOf().map((item) => [item.type, item.version, item.before, item.after, item.values]),
      ).toEqual([
        ['record.deleted', 2, { [owner.id]: [fx.users.u_sales1.id] }, null, {}],
        ['record.restored', 3, null, { [owner.id]: [fx.users.u_sales1.id] }, {}],
      ]);
      await service.delete(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [id] },
        auditOf(fx, 'u_admin'),
      );
    });

    it('publishes nothing on rollback, after commit otherwise', async () => {
      const seen: { committed: boolean }[] = [];
      const spied = new RecordMutationService(db, {
        schema,
        query,
        now: () => NOW,
        publisher: {
          publish: async (changes) => {
            // Read through another connection: only committed data is visible.
            const row = await admin.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM data.${pg.escapeIdentifier(fx.orders.db_table_name)}
                WHERE __id = $1 AND __version = $2`,
              [changes[0]?.recordId, changes[0]?.version],
            );
            seen.push({ committed: row.rows[0]?.n === 1 });
          },
        },
      });
      const current = await query.getRecord(scope, fx.orders.id, r3, as('u_admin'));
      const conflict = await appError(
        spied.update(
          scope,
          fx.orders.id,
          as('u_admin'),
          {
            records: [
              { id: r3, fields: { amount: 1 } },
              { id: r2, version: 999, fields: { amount: 2 } },
            ],
          },
          auditOf(fx, 'u_admin'),
        ),
      );
      expect(conflict.code).toBe('VERSION_CONFLICT');
      expect(seen).toEqual([]);
      await spied.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r3, version: current.version, fields: { amount: 3 } }] },
        auditOf(fx, 'u_admin'),
      );
      expect(seen).toEqual([{ committed: true }]);
    });

    it('captures nothing for an inactive publisher', async () => {
      let calls = 0;
      const quiet = new RecordMutationService(db, {
        schema,
        query,
        now: () => NOW,
        publisher: {
          active: false,
          publish: () => {
            calls += 1;
          },
        },
      });
      await quiet.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r3, fields: { amount: 4 } }] },
        auditOf(fx, 'u_admin'),
      );
      expect(calls).toBe(0);
    });
  });

  describe('auto_number recompute (schema.recompute_auto_number)', () => {
    it('renumbers every row after the rules change, in batches', async () => {
      await schema.updateFieldOptions(
        scope,
        itf.ticket.id,
        {
          options: {
            style: {
              rules: [
                { type: 'text', text: 'NEW-' },
                { type: 'incremental_number', length: 6 },
              ],
            },
          },
        },
        systemAuditContext(),
      );
      expect(
        await count(
          `graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id) WHERE task_identifier = 'schema.recompute_auto_number' AND payload->>'field_id' = $1`,
          [itf.ticket.id],
        ),
      ).toBeGreaterThanOrEqual(1);
      const total = await count(`data.${pg.escapeIdentifier(items.db_table_name)}`);
      const events = await count('meta.events');
      published.length = 0;
      const result = await service.recomputeAutoNumber(scope, items.id, itf.ticket.id, {
        batchSize: 300,
      });
      expect(result).toEqual({ rows: total, updated: total, fieldFound: true });
      const all = await rows(items);
      for (const row of all) {
        expect(row[col(itf.ticket)]).toBe(`NEW-${String(row.__auto).padStart(6, '0')}`);
      }
      // Computed field: no events, versions untouched.
      expect(await count('meta.events')).toBe(events);
      // Realtime (T210): live records get their new value at their current version.
      const live = all.filter((row) => row.__deleted_at === null);
      const changes = published.flat();
      expect(changes).toHaveLength(live.length);
      const liveById = new Map(live.map((row) => [row.__id as string, row]));
      for (const change of changes) {
        const row = liveById.get(change.recordId);
        expect(change).toMatchObject({
          type: 'record.updated',
          eventId: null,
          actorUserId: null,
          version: row?.__version,
          changedFieldIds: [itf.ticket.id],
          values: { [itf.ticket.id]: row?.[col(itf.ticket)] },
        });
      }
      const again = await service.recomputeAutoNumber(scope, items.id, itf.ticket.id);
      expect(again.updated).toBe(0);
      expect((await service.recomputeAutoNumber(scope, items.id, itf.qty.id)).fieldFound).toBe(
        false,
      );
    });
  });

  describe('tenant isolation', () => {
    it('another organization cannot write the table, nor see its members or versions', async () => {
      const other = orgScope(ORG_B);
      const error = await appError(
        service.update(
          other,
          fx.orders.id,
          as('u_admin'),
          { records: [{ id: r1, fields: { amount: 1 } }] },
          auditOf(fx, 'u_admin'),
        ),
      );
      expect(error.code).toBe('NOT_FOUND');
      expect(
        await new MemberDirectoryRepository(db).findMembersByEmail(other, [fx.users.u_admin.email]),
      ).toEqual([]);
      expect(
        await new MemberDirectoryRepository(db).findMembersByEmail(scope, [fx.users.u_admin.email]),
      ).toHaveLength(1);
      expect(await new TablesRepository(db).bumpDataVersion(other, fx.orders.id)).toBeUndefined();
      await expect(
        service.recomputeAutoNumber(other, items.id, itf.ticket.id),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('requires a valid audit context (ADR-23)', async () => {
    await expect(
      service.create(
        scope,
        items.id,
        as('u_admin'),
        { records: [{ fields: { name: 'x' } }] },
        undefined as unknown as AuditContext,
      ),
    ).rejects.toThrow(TypeError);
  });
});
