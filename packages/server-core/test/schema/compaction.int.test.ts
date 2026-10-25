import { newShortId } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgScope, type Db, type OrgScope } from '../../src/db/index.js';
import {
  indexNamesOf,
  SchemaService,
  SYSTEM_COLUMN_NAMES,
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

import type { FieldRow } from '../../src/db/schema.js';

const ORG = 'org_SchemaCompactOrg';

describe('column budget and compaction (ADR-20)', () => {
  let database: TestDatabase;
  let db: Db;
  let tenant: SeededTenant;
  let scope: OrgScope;
  let schema: SchemaService;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url, { poolMax: 4 });
    await migrateAll(database.url, db);
    tenant = await seedTenant(db, ORG, { collation: 'vi-VN-x-icu' });
    scope = orgScope(ORG);
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  const ctx = () => userContext(tenant.userId);

  async function newTable(name: string, service = schema): Promise<CreatedTable> {
    return service.createTable(
      scope,
      { baseId: tenant.baseId, name, primaryFieldName: 'Name' },
      ctx(),
    );
  }

  /** Moves the deletion time of trashed fields back by `days` (test setup only). */
  async function backdateDeletion(
    tableId: string,
    days: number,
    only?: readonly string[],
  ): Promise<void> {
    let query = db.kysely
      .updateTable('meta.fields')
      .set({ deleted_at: sql<Date>`now() - make_interval(days => ${days})` })
      .where('table_id', '=', tableId as never)
      .where('deleted_at', 'is not', null);
    if (only !== undefined) query = query.where('id', 'in', only as never[]);
    await query.execute();
  }

  async function snapshot(table: string, columns: readonly string[]) {
    const { rows } = await sql<Record<string, unknown>>`
      SELECT ${sql.join(columns.map((column) => sql.id(column)))}
        FROM ${sql.id('data', table)} ORDER BY __id
    `.execute(db.kysely);
    return rows;
  }

  it('refuses slot-consuming DDL at the lock threshold and queues compaction', async () => {
    // Low thresholds so the test stays fast: 10 slots after createTable.
    const tight = new SchemaService(db, {
      maxFieldsPerTable: 500,
      slotThresholds: { compact: 13, lock: 15 },
    });
    const { table } = await newTable('Tight', tight);
    expect(await usedColumnSlots(db.kysely, table.db_table_name)).toBe(10);
    await tight.addField(scope, table.id, { name: 'A', type: 'text' }, ctx());
    await tight.addField(scope, table.id, { name: 'B', type: 'text' }, ctx());
    expect(
      (await queuedJobs(db, 'schema.compact_table')).filter(
        (job) => job.payload.table_id === table.id,
      ),
    ).toEqual([]);
    const c = await tight.addField(scope, table.id, { name: 'C', type: 'text' }, ctx()); // 13 slots
    const queued = (await queuedJobs(db, 'schema.compact_table')).filter(
      (job) => job.payload.table_id === table.id,
    );
    expect(queued).toEqual([
      {
        task_identifier: 'schema.compact_table',
        payload: { organization_id: ORG, table_id: table.id },
        queue_name: `schema:${table.id}`,
        key: `schema.compact_table:${table.id}`,
      },
    ]);
    await tight.deleteField(scope, c.id, ctx()); // rename: no slot
    await tight.addField(scope, table.id, { name: 'D', type: 'text' }, ctx()); // 14
    await tight.addField(scope, table.id, { name: 'E', type: 'text' }, ctx()); // 15
    await expect(
      tight.addField(scope, table.id, { name: 'F', type: 'number' }, ctx()),
    ).rejects.toMatchObject({ code: 'SCHEMA_LOCKED', status: 409 });
    // Types without a column consume no slot and stay allowed.
    await tight.addField(scope, table.id, { name: 'Created', type: 'created_at' }, ctx());
    // Still exactly one pending compaction job for the table (job_key).
    expect(
      (await queuedJobs(db, 'schema.compact_table')).filter(
        (job) => job.payload.table_id === table.id,
      ),
    ).toHaveLength(1);
    await expectConsistent(tight, scope, table.id);

    // C was deleted just now: its column is kept (30-day restore), so the
    // table stays over budget — accepted, the worker logs a warning.
    const first = await tight.compactTable(scope, table.id);
    expect(first).toMatchObject({
      slotsBefore: 15,
      slotsAfter: SYSTEM_COLUMN_NAMES.length + 6,
      purgedFieldIds: [],
      keptDeletedFieldIds: [c.id],
      stillOverBudget: true,
    });
    await expectConsistent(tight, scope, table.id);
    await expect(
      tight.addField(scope, table.id, { name: 'F', type: 'number' }, ctx()),
    ).rejects.toMatchObject({ code: 'SCHEMA_LOCKED' });

    // Once C is past the restore window, compaction drops its column.
    await backdateDeletion(table.id, 31, [c.id]);
    const result = await tight.compactTable(scope, table.id);
    expect(result.slotsBefore).toBe(15);
    // System columns + Name, A, B, D, E.
    expect(result.slotsAfter).toBe(SYSTEM_COLUMN_NAMES.length + 5);
    expect(result.purgedFieldIds).toEqual([c.id]);
    await expect(tight.restoreField(scope, c.id, ctx())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await tight.addField(scope, table.id, { name: 'F', type: 'number' }, ctx());
    await expectConsistent(tight, scope, table.id);
  });

  it('add/delete loop reaches 1 400 slots → compaction job; compaction gives slots back and keeps data, __auto, indexes and junction FKs', async () => {
    const { table, primaryField } = await newTable('Churn');
    const tableId = table.id;
    const name = table.db_table_name;
    const keep: FieldRow[] = [primaryField];
    for (const spec of [
      { name: 'Email', type: 'text', uniqueValues: true },
      {
        name: 'Status',
        type: 'select',
        options: { options: [{ id: 'opt_AAAAAAAAAAAAAAA1', name: 'New' }] },
      },
      { name: 'Tags', type: 'select', options: { multiple: true } },
      { name: 'Done', type: 'checkbox' },
      { name: 'Amount', type: 'number' },
      { name: 'Due', type: 'datetime', options: { style: { format: 'dd/MM/yyyy' } } },
      { name: 'Meet', type: 'datetime', options: { style: { format: 'dd/MM/yyyy HH:mm' } } },
      { name: 'Code', type: 'auto_number' },
      { name: 'Owner', type: 'user', options: { multiple: false } },
      { name: 'Created', type: 'created_at' },
    ]) {
      keep.push(await schema.addField(scope, tableId, spec, ctx()));
    }
    const column = (fieldName: string) =>
      keep.find((field) => field.name === fieldName)?.db_column_name ?? '';
    const target = sql.id('data', name);
    for (let index = 0; index < 50; index += 1) {
      await sql`
        INSERT INTO ${target} (__id, ${sql.id(column('Name'))}, ${sql.id(column('Email'))}, ${sql.id(column('Status'))},
          ${sql.id(column('Tags'))}, ${sql.id(column('Done'))}, ${sql.id(column('Amount'))}, ${sql.id(column('Due'))},
          ${sql.id(column('Meet'))}, ${sql.id(column('Code'))}, ${sql.id(column('Owner'))}, __deleted_at)
        VALUES (${`rec_Churn${String(index).padStart(11, '0')}`}, ${`Khách ${String(index)}`}, ${`c${String(index)}@example.test`},
          ARRAY['opt_AAAAAAAAAAAAAAA1'], ARRAY['a', 'b'], ${index % 2 === 0}, ${`${String(index)}.125`}::numeric,
          '2026-09-23'::date, now(), ${`NO.${String(index).padStart(3, '0')}`}, ARRAY['usr_x'],
          ${index % 10 === 0 ? sql`now()` : sql`NULL`})
      `.execute(db.kysely);
    }
    // Leave a gap at the end of __auto: compaction must not reuse those values.
    await sql`DELETE FROM ${target} WHERE __id = 'rec_Churn00000000049'`.execute(db.kysely);

    // A junction table (link fields come in S4) pointing at the data table.
    const junction = `l_${newShortId()}`;
    await sql`
      CREATE TABLE ${sql.id('data', junction)} (
        a_id text NOT NULL REFERENCES ${target} (__id) ON DELETE CASCADE,
        b_id text NOT NULL,
        position integer NOT NULL DEFAULT 0,
        PRIMARY KEY (a_id, b_id)
      )
    `.execute(db.kysely);
    await sql`INSERT INTO ${sql.id('data', junction)} (a_id, b_id)
      SELECT __id, 'rec_Other0000000001' FROM ${target}`.execute(db.kysely);

    // Two fields in the trash across the compaction: one deleted a day ago
    // (kept, restorable with its data) and one 31 days ago (purged).
    const recent = await schema.addField(
      scope,
      tableId,
      { name: 'Recent', type: 'select', options: { multiple: false } },
      ctx(),
    );
    const old = await schema.addField(scope, tableId, { name: 'Old', type: 'text' }, ctx());
    await sql`UPDATE ${target} SET ${sql.id(recent.db_column_name ?? '')} = ARRAY['opt_AAAAAAAAAAAAAAA1'],
      ${sql.id(old.db_column_name ?? '')} = 'old value'`.execute(db.kysely);
    const recentDeleted = await schema.deleteField(scope, recent.id, ctx());
    await schema.deleteField(scope, old.id, ctx());

    // Churn: every add + delete uses one more slot for good.
    const started = Date.now();
    let slots = await usedColumnSlots(db.kysely, name);
    let iterations = 0;
    while (slots < 1400) {
      const temp = await schema.addField(scope, tableId, { name: 'Temp', type: 'number' }, ctx());
      await schema.deleteField(scope, temp.id, ctx());
      slots += 1;
      iterations += 1;
    }
    const churnMs = Date.now() - started;
    expect(await usedColumnSlots(db.kysely, name)).toBe(1400);
    expect(iterations).toBeGreaterThan(1300);
    const jobs = (await queuedJobs(db, 'schema.compact_table')).filter(
      (job) => job.payload.table_id === tableId,
    );
    expect(jobs).toEqual([
      expect.objectContaining({
        queue_name: `schema:${tableId}`,
        key: `schema.compact_table:${tableId}`,
      }),
    ]);
    await expectConsistent(schema, scope, tableId);

    // Every trashed field but `recent` is past the 30-day window.
    await backdateDeletion(tableId, 31);
    await backdateDeletion(tableId, 1, [recent.id]);
    const recentColumn = recentDeleted.deleted_column_name ?? '';
    const liveColumns = keep.flatMap((field) =>
      field.db_column_name === null ? [] : [field.db_column_name],
    );
    const dataColumns = [...SYSTEM_COLUMN_NAMES, ...liveColumns];
    const before = await snapshot(name, [...dataColumns, recentColumn]);
    const indexesBefore = await indexNamesOf(db.kysely, name);
    const { rows: seqBefore } = await sql<{ last: bigint }>`
      SELECT pg_sequence_last_value(pg_get_serial_sequence(${`data.${name}`}, '__auto')::regclass) AS last
    `.execute(db.kysely);

    const compactStarted = Date.now();
    const result = await schema.compactTable(scope, tableId);
    const compactMs = Date.now() - compactStarted;

    expect(result).toMatchObject({
      tableId,
      dbTableName: name,
      slotsBefore: 1400,
      slotsAfter: SYSTEM_COLUMN_NAMES.length + liveColumns.length + 1,
      rows: 49,
      keptDeletedFieldIds: [recent.id],
      stillOverBudget: false,
      junctionForeignKeys: [expect.stringContaining('a_id_fkey')],
    });
    expect(result.purgedFieldIds).toContain(old.id);
    expect(result.purgedFieldIds).not.toContain(recent.id);
    expect(result.purgedFieldIds.length).toBe(iterations + 1);
    expect(await usedColumnSlots(db.kysely, name)).toBe(
      SYSTEM_COLUMN_NAMES.length + liveColumns.length + 1,
    );
    expect(await physicalColumns(db, name)).toEqual([...dataColumns, recentColumn]);
    // Same name, same rows, same __auto, same values (the kept trashed column too).
    expect(await snapshot(name, [...dataColumns, recentColumn])).toEqual(before);
    expect(await indexNamesOf(db.kysely, name)).toEqual(indexesBefore);
    const { rows: seqName } = await sql<{ seq: string }>`
      SELECT pg_get_serial_sequence(${`data.${name}`}, '__auto') AS seq
    `.execute(db.kysely);
    expect(seqName[0]?.seq).toBe(`data.${name}___auto_seq`);
    await sql`INSERT INTO ${target} (__id) VALUES ('rec_ChurnAfter000001')`.execute(db.kysely);
    const { rows: fresh } = await sql<{ auto: bigint }>`
      SELECT __auto AS auto FROM ${target} WHERE __id = 'rec_ChurnAfter000001'
    `.execute(db.kysely);
    expect(fresh[0]?.auto).toBe((seqBefore[0]?.last ?? 0n) + 1n);
    // Constraints still enforced.
    await expect(
      sql`UPDATE ${target} SET ${sql.id(column('Status'))} = ARRAY['a', 'b'] WHERE __id = 'rec_ChurnAfter000001'`.execute(
        db.kysely,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`UPDATE ${target} SET ${sql.id(column('Email'))} = 'c1@example.test' WHERE __id = 'rec_ChurnAfter000001'`.execute(
        db.kysely,
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // The junction FK moved to the new table, validated, still cascading.
    const { rows: fks } = await sql<{ conname: string; target: string; validated: boolean }>`
      SELECT conname, confrelid::regclass::text AS target, convalidated AS validated
        FROM pg_constraint WHERE conrelid = ${`data.${junction}`}::regclass AND contype = 'f'
    `.execute(db.kysely);
    expect(fks).toHaveLength(1);
    expect(fks[0]?.conname).toContain('a_id_fkey');
    expect(fks[0]).toMatchObject({ target: `data.${name}`, validated: true });
    await sql`DELETE FROM ${target} WHERE __id = 'rec_Churn00000000001'`.execute(db.kysely);
    const { rows: links } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.id('data', junction)}
    `.execute(db.kysely);
    expect(links[0]?.n).toBe(48);

    // Meta: compacted, ready, purged fields cannot be restored, audit written.
    const meta = await db.kysely
      .selectFrom('meta.tables')
      .selectAll()
      .where('id', '=', tableId)
      .executeTakeFirstOrThrow();
    expect(meta.schema_state).toBe('ready');
    expect(meta.compacted_at).not.toBeNull();
    expect(meta.db_table_name).toBe(name);
    await expect(schema.restoreField(scope, old.id, ctx())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // The field deleted a day ago restores with its data and its CHECK.
    const restored = await schema.restoreField(scope, recent.id, ctx());
    expect(restored.deleted_at).toBeNull();
    const { rows: recentValues } = await sql<{ v: string[] | null }>`
      SELECT ${sql.id(recent.db_column_name ?? '')} AS v FROM ${target} WHERE __id = 'rec_Churn00000000002'
    `.execute(db.kysely);
    expect(recentValues[0]?.v).toEqual(['opt_AAAAAAAAAAAAAAA1']);
    await expect(
      sql`UPDATE ${target} SET ${sql.id(recent.db_column_name ?? '')} = ARRAY['a', 'b'] WHERE __id = 'rec_Churn00000000002'`.execute(
        db.kysely,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const audit = await db.kysely
      .selectFrom('meta.audit_logs')
      .select(['action', 'before', 'after', 'actor_type'])
      .where('action', '=', 'schema.compacted')
      .where('entity_id', '=', tableId)
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({ actor_type: 'system', before: { used_slots: 1400 } }),
    ]);
    await expectConsistent(schema, scope, tableId);
    // The table is usable again.
    await schema.addField(scope, tableId, { name: 'After', type: 'text' }, ctx());
    await expectConsistent(schema, scope, tableId);

    // Reported in T102 (ADR-20 "Hệ quả").
    process.stdout.write(
      `[T102] churn ${String(iterations)} add/delete pairs: ${String(churnMs)} ms; compaction of 1400 slots / 49 rows: ${String(compactMs)} ms\n`,
    );
  }, 600_000);

  // ADR-20 asks for the write-blocking time on a 200k-row table; opt-in
  // (`T102_BENCH=1 pnpm test:int`) because it takes tens of seconds.
  it.skipIf(process.env.T102_BENCH !== '1')(
    'bench: compaction of a 200 000-row, 30-field table',
    async () => {
      const { table } = await newTable('Bench');
      const columns: string[] = [];
      const types = ['text', 'number', 'select', 'datetime', 'checkbox'] as const;
      for (let index = 0; index < 29; index += 1) {
        const field = await schema.addField(
          scope,
          table.id,
          { name: `F${String(index)}`, type: types[index % types.length] ?? 'text' },
          ctx(),
        );
        columns.push(field.db_column_name ?? '');
        if (index % 3 === 0) {
          const temp = await schema.addField(scope, table.id, { name: 'Tmp', type: 'text' }, ctx());
          await schema.deleteField(scope, temp.id, ctx());
        }
      }
      const target = sql.id('data', table.db_table_name);
      const values = columns.map((column, index) => {
        switch (types[index % types.length]) {
          case 'text':
            return sql`'Giá trị ' || g::text`;
          case 'number':
            return sql`(g * 1.5)::numeric`;
          case 'select':
            return sql`ARRAY['opt_' || lpad((g % 7)::text, 16, '0')]`;
          case 'datetime':
            return sql`'2026-01-01'::date + (g % 365)`;
          default:
            return sql`g % 2 = 0`;
        }
      });
      await sql`
        INSERT INTO ${target} (__id, ${sql.join(columns.map((column) => sql.id(column)))})
        SELECT 'rec_' || lpad(g::text, 16, '0'), ${sql.join(values)}
          FROM generate_series(1, 200000) AS g
      `.execute(db.kysely);
      await sql`ANALYZE ${target}`.execute(db.kysely);
      const started = Date.now();
      const result = await schema.compactTable(scope, table.id);
      const elapsed = Date.now() - started;
      expect(result.rows).toBe(200_000);
      await expectConsistent(schema, scope, table.id);
      process.stdout.write(
        `[T102] bench: compaction of 200000 rows / 30 fields (${String(result.slotsBefore)} → ${String(result.slotsAfter)} slots): ${String(elapsed)} ms\n`,
      );
    },
    600_000,
  );

  it('keeps the scan index of a date column (T508) through compaction', async () => {
    const { table } = await newTable('Due');
    const due = await schema.addField(
      scope,
      table.id,
      { name: 'Hạn', type: 'datetime', options: { style: { format: 'dd/MM/yyyy HH:mm' } } },
      ctx(),
    );
    const gone = await schema.addField(scope, table.id, { name: 'Y', type: 'text' }, ctx());
    await schema.deleteField(scope, gone.id, ctx());
    await backdateDeletion(table.id, 31);
    expect(await schema.ensureDueIndex(scope, due.id)).toBe('created');
    const dueIndex = `${table.db_table_name}_${due.db_column_name ?? ''}_due`;
    expect(await indexNamesOf(db.kysely, table.db_table_name)).toContain(dueIndex);

    await schema.compactTable(scope, table.id);
    expect(await indexNamesOf(db.kysely, table.db_table_name)).toContain(dueIndex);
    expect(await schema.ensureDueIndex(scope, due.id)).toBe('exists');
    await expectConsistent(schema, scope, table.id);
  });

  it('rolls back and returns to ready when compaction fails (e.g. a BI view depends on the table)', async () => {
    const { table } = await newTable('Viewed');
    const field = await schema.addField(scope, table.id, { name: 'X', type: 'text' }, ctx());
    await schema.deleteField(scope, field.id, ctx());
    await sql`CREATE VIEW public.bi_view AS SELECT __id FROM ${sql.id('data', table.db_table_name)}`.execute(
      db.kysely,
    );
    try {
      const slots = await usedColumnSlots(db.kysely, table.db_table_name);
      await expect(schema.compactTable(scope, table.id)).rejects.toMatchObject({ code: '2BP01' });
      const meta = await db.kysely
        .selectFrom('meta.tables')
        .selectAll()
        .where('id', '=', table.id)
        .executeTakeFirstOrThrow();
      expect(meta.schema_state).toBe('ready');
      expect(meta.compacted_at).toBeNull();
      expect(await usedColumnSlots(db.kysely, table.db_table_name)).toBe(slots);
      const purged = await db.kysely
        .selectFrom('meta.fields')
        .select('purged_at')
        .where('id', '=', field.id)
        .executeTakeFirstOrThrow();
      expect(purged.purged_at).toBeNull();
      await expectConsistent(schema, scope, table.id);
      // No orphan table left behind by the failed attempt.
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'data' AND tablename LIKE 't\\_%'
      `.execute(db.kysely);
      const metaTables = await db.kysely.selectFrom('meta.tables').select('id').execute();
      expect(rows[0]?.n).toBe(metaTables.length);
    } finally {
      await sql`DROP VIEW public.bi_view`.execute(db.kysely);
    }
  });
});
