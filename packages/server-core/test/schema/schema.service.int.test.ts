import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgScope, type Db, type OrgScope } from '../../src/db/index.js';
import {
  checkSchemaConsistency,
  reserveAutoValues,
  SchemaService,
  usedColumnSlots,
  type CreatedTable,
} from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { expectConsistent, physicalColumns, queuedJobs, userContext } from '../support/schema.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_SchemaSvcOrgA001';
const ORG_B = 'org_SchemaSvcOrgB001';

describe('SchemaService (PostgreSQL 18, real migrator)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  let scopeA: OrgScope;
  let scopeB: OrgScope;
  const statements: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url, { onQuery: (text) => statements.push(text) });
    await migrateAll(database.url, db);
    tenantA = await seedTenant(db, ORG_A, { collation: 'vi-VN-x-icu' });
    tenantB = await seedTenant(db, ORG_B);
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  const ctxA = () => userContext(tenantA.userId);

  async function newTable(name: string, scope = scopeA, tenant = tenantA): Promise<CreatedTable> {
    return schema.createTable(
      scope,
      { baseId: tenant.baseId, name, primaryFieldName: 'Name' },
      userContext(tenant.userId),
    );
  }

  async function count(
    table: 'meta.events' | 'meta.audit_logs',
    where: { type?: string; action?: string; entity?: string },
  ): Promise<number> {
    let query = db.kysely.selectFrom(table).select((eb) => eb.fn.countAll<bigint>().as('n'));
    if (table === 'meta.events' && where.type !== undefined) {
      query = query.where('type' as never, '=', where.type as never);
    }
    if (table === 'meta.audit_logs' && where.action !== undefined) {
      query = query.where('action' as never, '=', where.action as never);
    }
    if (where.entity !== undefined) {
      query = query.where('entity_id' as never, '=', where.entity as never);
    }
    const row = await query.executeTakeFirstOrThrow();
    return Number(row.n);
  }

  describe('createTable', () => {
    it('creates data.t_<shortId> with system columns, the primary field and its trigram index', async () => {
      const { table, primaryField } = await newTable('Customers');
      expect(table.db_table_name).toMatch(/^t_[0-9a-z]{12}$/);
      expect(table.collation).toBe('vi-VN-x-icu');
      expect(table.primary_field_id).toBe(primaryField.id);
      expect(table.schema_state).toBe('ready');
      expect(primaryField).toMatchObject({ type: 'text', is_primary: true, name: 'Name' });
      expect(primaryField.db_column_name).toMatch(/^f_[0-9a-z]{12}$/);
      expect(await physicalColumns(db, table.db_table_name)).toEqual([
        '__id',
        '__auto',
        '__created_at',
        '__updated_at',
        '__created_by',
        '__updated_by',
        '__version',
        '__deleted_at',
        '__deleted_by',
        primaryField.db_column_name,
      ]);
      const { rows } = await sql<{ indexname: string; indexdef: string }>`
        SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'data' AND tablename = ${table.db_table_name}
        ORDER BY indexname
      `.execute(db.kysely);
      const names = rows.map((row) => row.indexname);
      expect(names).toEqual(
        [
          `${table.db_table_name}_created_at_idx`,
          `${table.db_table_name}_deleted_at_idx`,
          `${table.db_table_name}_${String(primaryField.db_column_name)}_trgm`,
          `${table.db_table_name}_pkey`,
        ].sort(),
      );
      expect(rows.find((row) => row.indexname.endsWith('_trgm'))?.indexdef).toContain(
        `meta.f_unaccent(lower(${String(primaryField.db_column_name)}))`,
      );
      expect(rows.find((row) => row.indexname.endsWith('_deleted_at_idx'))?.indexdef).toContain(
        'WHERE (__deleted_at IS NOT NULL)',
      );
      await expectConsistent(schema, scopeA, table.id);
      expect(await count('meta.events', { type: 'table.created', entity: table.id })).toBe(1);
      expect(await count('meta.audit_logs', { action: 'table.created', entity: table.id })).toBe(1);
    });

    it('uses und-x-icu when the base has no collation', async () => {
      const { table, primaryField } = await newTable('Default collation', scopeB, tenantB);
      expect(table.collation).toBe('und-x-icu');
      const { rows } = await sql<{ collation_name: string }>`
        SELECT collation_name FROM information_schema.columns
         WHERE table_schema = 'data' AND table_name = ${table.db_table_name}
           AND column_name = ${primaryField.db_column_name}
      `.execute(db.kysely);
      expect(rows[0]?.collation_name).toBe('und-x-icu');
    });

    it('refuses an unknown base collation before any DDL', async () => {
      const bad = await seedTenant(db, 'org_SchemaSvcBadColl', { collation: 'xx-nope-x-icu' });
      const tablesBefore = await db.kysely
        .selectFrom('meta.tables')
        .select((eb) => eb.fn.countAll<bigint>().as('n'))
        .executeTakeFirstOrThrow();
      await expect(
        schema.createTable(
          orgScope(bad.orgId),
          { baseId: bad.baseId, name: 'X', primaryFieldName: 'Name' },
          userContext(bad.userId),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const tablesAfter = await db.kysely
        .selectFrom('meta.tables')
        .select((eb) => eb.fn.countAll<bigint>().as('n'))
        .executeTakeFirstOrThrow();
      expect(tablesAfter.n).toBe(tablesBefore.n);
    });

    it('answers NAME_CONFLICT for a duplicate table name and NOT_FOUND for another org base', async () => {
      await newTable('Orders');
      await expect(newTable('Orders')).rejects.toMatchObject({
        code: 'NAME_CONFLICT',
        status: 409,
      });
      await expect(
        schema.createTable(
          scopeB,
          { baseId: tenantA.baseId, name: 'Stolen', primaryFieldName: 'Name' },
          userContext(tenantB.userId),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });
  });

  describe('addField', () => {
    it('adds every S1 type with the right column, constraint and indexes', async () => {
      const { table } = await newTable('All types');
      const specs = [
        { name: 'Title', type: 'text', options: { style: { type: 'email' } } },
        {
          name: 'Amount',
          type: 'number',
          options: { style: { type: 'currency', currency_code: 'VND' } },
        },
        {
          name: 'Status',
          type: 'select',
          options: { options: [{ id: 'opt_AAAAAAAAAAAAAAAA', name: 'New' }] },
        },
        { name: 'Tags', type: 'select', options: { multiple: true } },
        { name: 'Due', type: 'datetime', options: { style: { format: 'dd/MM/yyyy' } } },
        { name: 'Meet', type: 'datetime', options: { style: { format: 'dd/MM/yyyy HH:mm' } } },
        { name: 'Done', type: 'checkbox' },
        { name: 'Owners', type: 'user' },
        { name: 'Assignee', type: 'user', options: { multiple: false } },
        { name: 'Created', type: 'created_at' },
        { name: 'Updated by', type: 'updated_by' },
        { name: 'Code', type: 'auto_number' },
        { name: 'Email', type: 'text', uniqueValues: true },
      ];
      const added = [];
      for (const spec of specs) {
        added.push(await schema.addField(scopeA, table.id, spec, ctxA()));
        await expectConsistent(schema, scopeA, table.id);
      }
      const byName = new Map(added.map((field) => [field.name, field]));
      expect(byName.get('Created')?.db_column_name).toBeNull();
      expect(byName.get('Updated by')?.db_column_name).toBeNull();

      const column = (name: string) => sql.id(byName.get(name)?.db_column_name ?? '');
      const target = sql.id('data', table.db_table_name);
      // checkbox: NOT NULL DEFAULT false.
      await sql`INSERT INTO ${target} (__id) VALUES ('rec_AAAAAAAAAAAAAAA1')`.execute(db.kysely);
      const { rows } = await sql<{
        done: boolean;
      }>`SELECT ${column('Done')} AS done FROM ${target}`.execute(db.kysely);
      expect(rows[0]?.done).toBe(false);
      // select multiple=false and user multiple=false keep ≤ 1 element.
      for (const name of ['Status', 'Assignee']) {
        await expect(
          sql`UPDATE ${target} SET ${column(name)} = ARRAY['a', 'b']`.execute(db.kysely),
        ).rejects.toMatchObject({ code: '23514' });
      }
      await sql`UPDATE ${target} SET ${column('Tags')} = ARRAY['a', 'b']`.execute(db.kysely);
      // unique_values: partial unique index ignoring the trash.
      await sql`UPDATE ${target} SET ${column('Email')} = 'x@example.test'`.execute(db.kysely);
      await expect(
        sql`INSERT INTO ${target} (__id, ${column('Email')}) VALUES ('rec_AAAAAAAAAAAAAAA2', 'x@example.test')`.execute(
          db.kysely,
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await sql`UPDATE ${target} SET __deleted_at = now()`.execute(db.kysely);
      await sql`INSERT INTO ${target} (__id, ${column('Email')}) VALUES ('rec_AAAAAAAAAAAAAAA2', 'x@example.test')`.execute(
        db.kysely,
      );

      // auto_number: existing records are numbered by a job on the table's queue.
      const recompute = await queuedJobs(db, 'schema.recompute_auto_number');
      expect(recompute).toContainEqual(
        expect.objectContaining({
          queue_name: `schema:${table.id}`,
          payload: {
            organization_id: ORG_A,
            table_id: table.id,
            field_id: byName.get('Code')?.id,
          },
        }),
      );
      // One event and one audit row per field, in the same transaction.
      for (const field of added) {
        expect(await count('meta.events', { type: 'field.created', entity: field.id })).toBe(1);
        expect(await count('meta.audit_logs', { action: 'field.created', entity: field.id })).toBe(
          1,
        );
      }
    });

    it('validates type, options, unique support and names', async () => {
      const { table } = await newTable('Validation');
      const cases = [
        { name: 'L', type: 'lookup' },
        { name: 'M', type: 'link', options: {} },
        { name: 'X', type: 'nope' },
        { name: 'N', type: 'number', options: { style: { type: 'rating', max: 99 } } },
        { name: 'C', type: 'checkbox', uniqueValues: true },
        { name: '   ', type: 'text' },
      ];
      for (const input of cases) {
        await expect(schema.addField(scopeA, table.id, input, ctxA())).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
          status: 422,
        });
      }
      await schema.addField(scopeA, table.id, { name: 'Dup', type: 'text' }, ctxA());
      await expect(
        schema.addField(scopeA, table.id, { name: ' Dup ', type: 'number' }, ctxA()),
      ).rejects.toMatchObject({ code: 'NAME_CONFLICT' });
      await expectConsistent(schema, scopeA, table.id);
    });

    it('answers FIELD_LIMIT_EXCEEDED at MAX_FIELDS_PER_TABLE active fields', async () => {
      const small = new SchemaService(db, { maxFieldsPerTable: 3 });
      const { table } = await small.createTable(
        scopeA,
        { baseId: tenantA.baseId, name: 'Small', primaryFieldName: 'Name' },
        ctxA(),
      );
      const second = await small.addField(scopeA, table.id, { name: 'B', type: 'text' }, ctxA());
      await small.addField(scopeA, table.id, { name: 'C', type: 'created_at' }, ctxA());
      const error = await small
        .addField(scopeA, table.id, { name: 'D', type: 'number' }, ctxA())
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: 'FIELD_LIMIT_EXCEEDED',
        status: 422,
        errors: [expect.objectContaining({ params: { limit: 3 } })],
      });
      // Deleting frees a place; restoring then counts again.
      await small.deleteField(scopeA, second.id, ctxA());
      await small.addField(scopeA, table.id, { name: 'D', type: 'number' }, ctxA());
      await expect(small.restoreField(scopeA, second.id, ctxA())).rejects.toMatchObject({
        code: 'FIELD_LIMIT_EXCEEDED',
      });
      await expectConsistent(small, scopeA, table.id);
    });

    it('rolls back the column when the transaction fails after the DDL', async () => {
      const { table } = await newTable('Rollback');
      // The meta insert fails after ALTER TABLE ran in the same transaction.
      await sql`
        CREATE FUNCTION meta.test_fail_field_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.name = 'boom' THEN RAISE EXCEPTION 'injected failure'; END IF;
          RETURN NEW;
        END $$
      `.execute(db.kysely);
      await sql`
        CREATE TRIGGER test_fail_field_insert BEFORE INSERT ON meta.fields
        FOR EACH ROW EXECUTE FUNCTION meta.test_fail_field_insert()
      `.execute(db.kysely);
      try {
        const columnsBefore = await physicalColumns(db, table.db_table_name);
        const slotsBefore = await usedColumnSlots(db.kysely, table.db_table_name);
        const eventsBefore = await count('meta.events', { type: 'field.created' });
        await expect(
          schema.addField(scopeA, table.id, { name: 'boom', type: 'select' }, ctxA()),
        ).rejects.toThrow(/injected failure/);
        expect(await physicalColumns(db, table.db_table_name)).toEqual(columnsBefore);
        // Transactional DDL: the rolled-back column does not even use a slot.
        expect(await usedColumnSlots(db.kysely, table.db_table_name)).toBe(slotsBefore);
        expect(await count('meta.events', { type: 'field.created' })).toBe(eventsBefore);
        const { rows } = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'data' AND tablename = ${table.db_table_name} AND indexname LIKE '%_gin'
        `.execute(db.kysely);
        expect(rows[0]?.n).toBe(0);
        await expectConsistent(schema, scopeA, table.id);
      } finally {
        await sql`DROP TRIGGER test_fail_field_insert ON meta.fields`.execute(db.kysely);
        await sql`DROP FUNCTION meta.test_fail_field_insert()`.execute(db.kysely);
      }
    });

    it('refuses DDL on a table being compacted with 409 SCHEMA_LOCKED', async () => {
      const { table } = await newTable('Compacting');
      await db.kysely
        .updateTable('meta.tables')
        .set({ schema_state: 'compacting' })
        .where('id', '=', table.id)
        .execute();
      await expect(
        schema.addField(scopeA, table.id, { name: 'X', type: 'text' }, ctxA()),
      ).rejects.toMatchObject({ code: 'SCHEMA_LOCKED', status: 409 });
      await db.kysely
        .updateTable('meta.tables')
        .set({ schema_state: 'ready' })
        .where('id', '=', table.id)
        .execute();
    });
  });

  describe('rename, options, delete, restore', () => {
    it('renames fields and tables in meta only', async () => {
      const { table, primaryField } = await newTable('Renames');
      const field = await schema.addField(scopeA, table.id, { name: 'Old', type: 'text' }, ctxA());
      const columns = await physicalColumns(db, table.db_table_name);
      const renamed = await schema.renameField(scopeA, field.id, 'New', ctxA());
      expect(renamed.name).toBe('New');
      await expect(
        schema.renameField(scopeA, field.id, primaryField.name, ctxA()),
      ).rejects.toMatchObject({
        code: 'NAME_CONFLICT',
      });
      const renamedTable = await schema.renameTable(scopeA, table.id, 'Renamed table', ctxA());
      expect(renamedTable.name).toBe('Renamed table');
      await expect(schema.renameTable(scopeA, table.id, 'Customers', ctxA())).rejects.toMatchObject(
        {
          code: 'NAME_CONFLICT',
        },
      );
      expect(await physicalColumns(db, table.db_table_name)).toEqual(columns);
      expect(await count('meta.events', { type: 'field.updated', entity: field.id })).toBe(1);
      expect(await count('meta.events', { type: 'table.updated', entity: table.id })).toBe(1);
      await expectConsistent(schema, scopeA, table.id);
    });

    it('refuses datetime format changes between date-only and date-time (CONVERSION_NOT_ALLOWED)', async () => {
      const { table } = await newTable('Dates');
      const due = await schema.addField(
        scopeA,
        table.id,
        { name: 'Due', type: 'datetime', options: { style: { format: 'yyyy-MM-dd' } } },
        ctxA(),
      );
      await expect(
        schema.updateFieldOptions(
          scopeA,
          due.id,
          { options: { style: { format: 'yyyy-MM-dd HH:mm' } } },
          ctxA(),
        ),
      ).rejects.toMatchObject({
        code: 'CONVERSION_NOT_ALLOWED',
        status: 422,
        errors: [expect.objectContaining({ path: 'options.style.format' })],
      });
      const meet = await schema.addField(
        scopeA,
        table.id,
        { name: 'Meet', type: 'datetime', options: { style: { format: 'dd/MM/yyyy HH:mm' } } },
        ctxA(),
      );
      await expect(
        schema.updateFieldOptions(
          scopeA,
          meet.id,
          { options: { style: { format: 'dd/MM/yyyy' } } },
          ctxA(),
        ),
      ).rejects.toMatchObject({ code: 'CONVERSION_NOT_ALLOWED' });
      // Same kind: style only, no DDL.
      const updated = await schema.updateFieldOptions(
        scopeA,
        due.id,
        { options: { style: { format: 'dd/MM/yyyy' }, timezone: 'Asia/Ho_Chi_Minh' } },
        ctxA(),
      );
      expect(updated.options).toMatchObject({ style: { format: 'dd/MM/yyyy' } });
      await expectConsistent(schema, scopeA, table.id);
    });

    it('switches select to multiple, refuses multiple → single, toggles unique values', async () => {
      const { table } = await newTable('Options');
      const status = await schema.addField(
        scopeA,
        table.id,
        { name: 'Status', type: 'select' },
        ctxA(),
      );
      const multi = await schema.updateFieldOptions(
        scopeA,
        status.id,
        { options: { multiple: true } },
        ctxA(),
      );
      await expectConsistent(schema, scopeA, table.id);
      await expect(
        schema.updateFieldOptions(scopeA, multi.id, { options: { multiple: false } }, ctxA()),
      ).rejects.toMatchObject({ code: 'CONVERSION_NOT_ALLOWED' });

      const code = await schema.addField(scopeA, table.id, { name: 'Ref', type: 'text' }, ctxA());
      const target = sql.id('data', table.db_table_name);
      const column = sql.id(code.db_column_name ?? '');
      await sql`INSERT INTO ${target} (__id, ${column}) VALUES ('rec_BBBBBBBBBBBBBBB1', 'same'), ('rec_BBBBBBBBBBBBBBB2', 'same')`.execute(
        db.kysely,
      );
      await expect(
        schema.updateFieldOptions(scopeA, code.id, { uniqueValues: true }, ctxA()),
      ).rejects.toMatchObject({ code: 'UNIQUE_VIOLATION', status: 422 });
      await sql`UPDATE ${target} SET ${column} = 'other' WHERE __id = 'rec_BBBBBBBBBBBBBBB2'`.execute(
        db.kysely,
      );
      const unique = await schema.updateFieldOptions(
        scopeA,
        code.id,
        { uniqueValues: true },
        ctxA(),
      );
      expect(unique.unique_values).toBe(true);
      await expectConsistent(schema, scopeA, table.id);
      await schema.updateFieldOptions(scopeA, code.id, { uniqueValues: false }, ctxA());
      // An incompressible value past the B-tree entry limit (~2.7 KB): 422, not 500.
      await sql`UPDATE ${target} SET ${column} = (SELECT string_agg(md5(i::text), '') FROM generate_series(1, 300) AS i) WHERE __id = 'rec_BBBBBBBBBBBBBBB2'`.execute(
        db.kysely,
      );
      await expect(
        schema.updateFieldOptions(scopeA, code.id, { uniqueValues: true }, ctxA()),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 422,
        errors: [{ path: 'unique_values', code: 'UNIQUE_VALUE_TOO_LONG' }],
      });
      await sql`UPDATE ${target} SET ${column} = 'other' WHERE __id = 'rec_BBBBBBBBBBBBBBB2'`.execute(
        db.kysely,
      );
      await schema.updateFieldOptions(scopeA, code.id, { uniqueValues: true }, ctxA());
      await expectConsistent(schema, scopeA, table.id);
      await schema.updateFieldOptions(
        scopeA,
        code.id,
        { uniqueValues: false, required: true },
        ctxA(),
      );
      await expectConsistent(schema, scopeA, table.id);
    });

    it('queues a renumbering job when auto_number rules change', async () => {
      const { table } = await newTable('Auto');
      const field = await schema.addField(
        scopeA,
        table.id,
        { name: 'No', type: 'auto_number' },
        ctxA(),
      );
      await schema.updateFieldOptions(
        scopeA,
        field.id,
        {
          options: {
            style: {
              rules: [
                { type: 'text', text: 'TK-' },
                { type: 'incremental_number', length: 5 },
              ],
            },
          },
        },
        ctxA(),
      );
      const jobs = (await queuedJobs(db, 'schema.recompute_auto_number')).filter(
        (job) => job.payload.field_id === field.id,
      );
      // job_key replace: one pending job per field.
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.key).toBe(`schema.recompute_auto_number:${field.id}`);
    });

    it('soft-deletes by renaming the column and restores within 30 days', async () => {
      const { table, primaryField } = await newTable('Trash');
      const field = await schema.addField(scopeA, table.id, { name: 'Note', type: 'text' }, ctxA());
      const target = sql.id('data', table.db_table_name);
      await sql`INSERT INTO ${target} (__id, ${sql.id(field.db_column_name ?? '')}) VALUES ('rec_CCCCCCCCCCCCCCC1', 'kept')`.execute(
        db.kysely,
      );
      const slots = await usedColumnSlots(db.kysely, table.db_table_name);

      const deleted = await schema.deleteField(scopeA, field.id, ctxA());
      expect(deleted.deleted_at).not.toBeNull();
      expect(deleted.deleted_column_name).toMatch(
        new RegExp(`^${String(field.db_column_name)}__deleted_\\d+$`),
      );
      expect(await physicalColumns(db, table.db_table_name)).toContain(deleted.deleted_column_name);
      expect(await usedColumnSlots(db.kysely, table.db_table_name)).toBe(slots);
      await expectConsistent(schema, scopeA, table.id);
      await expect(schema.deleteField(scopeA, primaryField.id, ctxA())).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });

      // The name is free while the field is in the trash; restoring then conflicts.
      const other = await schema.addField(
        scopeA,
        table.id,
        { name: 'Note', type: 'number' },
        ctxA(),
      );
      await expect(schema.restoreField(scopeA, field.id, ctxA())).rejects.toMatchObject({
        code: 'NAME_CONFLICT',
      });
      await schema.renameField(scopeA, other.id, 'Other', ctxA());
      const restored = await schema.restoreField(scopeA, field.id, ctxA());
      expect(restored).toMatchObject({ deleted_at: null, deleted_column_name: null });
      const { rows } = await sql<{
        v: string;
      }>`SELECT ${sql.id(field.db_column_name ?? '')} AS v FROM ${target}`.execute(db.kysely);
      expect(rows[0]?.v).toBe('kept');
      await expectConsistent(schema, scopeA, table.id);
      expect(await count('meta.events', { type: 'field.deleted', entity: field.id })).toBe(1);
      expect(await count('meta.events', { type: 'field.restored', entity: field.id })).toBe(1);

      // Past 30 days the field is gone.
      await schema.deleteField(scopeA, field.id, ctxA());
      await db.kysely
        .updateTable('meta.fields')
        .set({ deleted_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
        .where('id', '=', field.id)
        .execute();
      await expect(schema.restoreField(scopeA, field.id, ctxA())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('soft-deletes a table in meta only', async () => {
      const { table } = await newTable('Gone');
      await schema.deleteTable(scopeA, table.id, ctxA());
      await expect(
        schema.addField(scopeA, table.id, { name: 'X', type: 'text' }, ctxA()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await physicalColumns(db, table.db_table_name)).toContain('__id');
      expect(await count('meta.events', { type: 'table.deleted', entity: table.id })).toBe(1);
    });
  });

  describe('tenant isolation', () => {
    it("org B cannot see or change org A's tables and fields", async () => {
      const { table, primaryField } = await newTable('Private');
      const field = await schema.addField(
        scopeA,
        table.id,
        { name: 'Secret', type: 'text' },
        ctxA(),
      );
      const ctxB = userContext(tenantB.userId);
      const attempts: (() => Promise<unknown>)[] = [
        () => schema.addField(scopeB, table.id, { name: 'Injected', type: 'text' }, ctxB),
        () => schema.renameField(scopeB, field.id, 'Mine', ctxB),
        () => schema.updateFieldOptions(scopeB, field.id, { uniqueValues: true }, ctxB),
        () => schema.deleteField(scopeB, field.id, ctxB),
        () => schema.restoreField(scopeB, field.id, ctxB),
        () => schema.renameTable(scopeB, table.id, 'Mine', ctxB),
        () => schema.deleteTable(scopeB, table.id, ctxB),
        () => schema.compactTable(scopeB, table.id),
        () => schema.checkConsistency(scopeB, table.id),
        () => schema.usedSlots(scopeB, table.id),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      }
      const fields = await db.kysely
        .selectFrom('meta.fields')
        .select(['id', 'name', 'deleted_at'])
        .where('table_id', '=', table.id)
        .orderBy('position')
        .execute();
      expect(fields).toEqual([
        { id: primaryField.id, name: 'Name', deleted_at: null },
        { id: field.id, name: 'Secret', deleted_at: null },
      ]);
      await expectConsistent(schema, scopeA, table.id);
    });
  });

  it('never puts user-chosen names into SQL text', async () => {
    const hostile = [
      'Robert"); DROP TABLE data.x; --',
      "O'Brien'; DELETE FROM meta.fields; --",
      'f_aaaaaaaaaaaa',
      '__id"; --',
      'Tên có dấu — Đặng Thị Đào',
      '名前 😀',
      '"quoted"',
      '$1 $$ \\x27',
    ];
    statements.length = 0;
    const { table } = await schema.createTable(
      scopeA,
      { baseId: tenantA.baseId, name: hostile[0] ?? '', primaryFieldName: hostile[1] ?? '' },
      ctxA(),
    );
    const created: { id: Id<'fld'>; name: string }[] = [];
    for (const [index, name] of hostile.slice(2).entries()) {
      created.push(
        await schema.addField(
          scopeA,
          table.id,
          { name, type: index % 2 === 0 ? 'text' : 'select' },
          ctxA(),
        ),
      );
    }
    for (const field of created) {
      await schema.renameField(scopeA, field.id, `${field.name} (2) ;--`, ctxA());
    }
    expect(statements.length).toBeGreaterThan(20);
    for (const name of hostile) {
      const offending = statements.filter((text) => text.includes(name));
      expect(offending, name).toEqual([]);
    }
    const names = await db.kysely
      .selectFrom('meta.fields')
      .select('name')
      .where('table_id', '=', table.id)
      .orderBy('position')
      .execute();
    expect(names.map((row) => row.name)).toEqual([
      hostile[1],
      ...hostile.slice(2).map((name) => `${name.normalize('NFC').trim()} (2) ;--`),
    ]);
    await expectConsistent(schema, scopeA, table.id);
  });

  it('reserves __auto values for inserts with OVERRIDING SYSTEM VALUE (T107 contract)', async () => {
    const { table } = await newTable('Auto values');
    const values = await db.withTx((tx) => reserveAutoValues(tx, table.db_table_name, 3));
    expect(values).toHaveLength(3);
    expect(values[1]).toBe((values[0] ?? 0n) + 1n);
    const target = sql.id('data', table.db_table_name);
    await sql`INSERT INTO ${target} (__id, __auto) OVERRIDING SYSTEM VALUE VALUES ('rec_DDDDDDDDDDDDDDD1', ${values[0]})`.execute(
      db.kysely,
    );
    await sql`INSERT INTO ${target} (__id) VALUES ('rec_DDDDDDDDDDDDDDD2')`.execute(db.kysely);
    const { rows } = await sql<{
      auto: bigint;
    }>`SELECT __auto AS auto FROM ${target} ORDER BY __auto`.execute(db.kysely);
    expect(rows.map((row) => row.auto)).toEqual([values[0], (values[2] ?? 0n) + 1n]);
    const fields = await db.kysely
      .selectFrom('meta.fields')
      .selectAll()
      .where('table_id', '=', table.id)
      .execute();
    expect(await checkSchemaConsistency(db.kysely, table, fields)).toEqual([]);
  });
});
