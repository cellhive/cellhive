/**
 * Field type conversion (BACKLOG T403) on PostgreSQL 18: `SchemaService`
 * starts, finishes, reverts and cleans conversions; the backfill runs
 * through `RecordMutationService.convertFieldBatch`; previews through
 * `RecordQueryService.scanColumn`. The worker task and the HTTP API are
 * tested in their own packages.
 */
import { newId, type Id } from '@cellhive/contracts';
import {
  FIELD_TYPE_REGISTRY,
  planFieldConversion,
  type ConversionSettings,
  type S1FieldType,
} from '@cellhive/field-types';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLogsRepository } from '../../src/audit/index.js';
import { listExpiredFieldConversions } from '../../src/db/cross-tenant-lookups.js';
import { orgScope, type Db, type OrgScope } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import { JobsRepository } from '../../src/jobs/index.js';
import { attachRealtimePublisher, type RealtimeEnvelope } from '../../src/realtime/index.js';
import {
  countsOf,
  MemberDirectoryRepository,
  previewConversion,
  previewRevert,
  RecordHistoryService,
  RecordMutationService,
  RecordQueryService,
  sourceColumnOf,
  type RecordAccessContext,
} from '../../src/records/index.js';
import {
  ConcurrentFieldEditsError,
  FieldConversionsRepository,
  fieldDependents,
  SchemaService,
  storedDefinitionOf,
  usedColumnSlots,
  type SchemaChange,
  type StartConversionInput,
} from '../../src/schema/index.js';
import { accessOf, buildOrdersFixture, NOW, type OrdersFixture } from '../records/fixtures.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { expectConsistent, physicalColumns, queuedJobs, userContext } from '../support/schema.js';
import { seedTenant } from '../support/tenant.js';

import type { FieldRow, JsonObject } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T403ConvertOrgA1';
const ORG_B: Id<'org'> = 'org_T403ConvertOrgB1';
const LOCALE = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('field type conversion (T403, PostgreSQL 18)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let schema: SchemaService;
  let records: RecordMutationService;
  let query: RecordQueryService;
  let members: MemberDirectoryRepository;
  let conversions: FieldConversionsRepository;
  let jobs: JobsRepository;
  let fx: OrdersFixture;
  const scope: OrgScope = orgScope(ORG_A);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.adminUrl, max: 4 });
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    records = new RecordMutationService(db, { schema, query, now: () => NOW });
    members = new MemberDirectoryRepository(db);
    conversions = new FieldConversionsRepository(db);
    jobs = new JobsRepository(db);
    fx = await buildOrdersFixture(db, schema, ORG_A);
  });

  afterAll(async () => {
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  const admin = (): RecordAccessContext => accessOf(fx, 'u_admin');
  const ctx = () => userContext(fx.users.u_admin.id);

  /** A new field of Orders, visible to the fixture roles. */
  async function addField(name: string, type: string, options: unknown = {}): Promise<FieldRow> {
    const field = await schema.addField(scope, fx.orders.id, { name, type, options }, ctx());
    const orders = fx.schema.tables[0];
    if (orders !== undefined) {
      fx.schema.tables[0] = {
        ...orders,
        fields: [...orders.fields, { id: field.id, type: field.type }],
      };
    }
    return field;
  }

  async function currentField(id: Id<'fld'>): Promise<FieldRow> {
    const row = await db.kysely
      .selectFrom('meta.fields')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return row;
  }

  /** Writes raw storage values into one column (test fixture: `data.*` directly). */
  async function fill(field: FieldRow, values: readonly unknown[]): Promise<Id<'rec'>[]> {
    const ids: Id<'rec'>[] = [];
    for (const value of values) {
      const id = newId('rec');
      await pool.query(
        `INSERT INTO data.${pg.escapeIdentifier(fx.orders.db_table_name)} (__id, ${pg.escapeIdentifier(field.db_column_name as string)}) VALUES ($1, $2)`,
        [id, value],
      );
      ids.push(id);
    }
    return ids;
  }

  async function columnValues(column: string, ids: readonly Id<'rec'>[]): Promise<unknown[]> {
    const result = await pool.query<{ id: string; v: unknown }>(
      `SELECT __id AS id, ${pg.escapeIdentifier(column)} AS v FROM data.${pg.escapeIdentifier(fx.orders.db_table_name)} WHERE __id = ANY($1)`,
      [ids],
    );
    const byId = new Map(result.rows.map((row) => [row.id, row.v]));
    return ids.map((id) => byId.get(id));
  }

  function plannedFrom(
    field: FieldRow,
    toType: S1FieldType,
    toOptions: unknown,
    settings: ConversionSettings = {},
  ) {
    const definition = FIELD_TYPE_REGISTRY[field.type as S1FieldType];
    return planFieldConversion(
      { type: field.type as S1FieldType, options: definition.optionsSchema.parse(field.options) },
      { type: toType, options: FIELD_TYPE_REGISTRY[toType].optionsSchema.parse(toOptions) },
      settings,
    );
  }

  async function preview(
    field: FieldRow,
    toType: S1FieldType,
    toOptions: unknown,
    settings: ConversionSettings = {},
  ) {
    return previewConversion(
      { query, members },
      {
        scope,
        tableId: fx.orders.id,
        access: admin(),
        column: sourceColumnOf(field.type, field.db_column_name) as string,
      },
      plannedFrom(field, toType, toOptions, settings),
      LOCALE,
    );
  }

  function start(
    field: FieldRow,
    toType: string,
    toOptions: unknown,
    settings: ConversionSettings = {},
  ) {
    const input: StartConversionInput = {
      expectedFrom: { type: field.type, options: field.options },
      toType,
      toOptions,
      settings,
      locale: LOCALE.locale,
      timeZone: LOCALE.timeZone,
    };
    return schema.startConversion(scope, field.id, input, ctx());
  }

  /** What the `field.convert` task does, minus the org slot. */
  async function runJob(jobId: Id<'job'>, batch = 500): Promise<JsonObject> {
    await jobs.markRunning(scope, jobId);
    let counts: JsonObject;
    for (;;) {
      const result = await records.convertFieldBatch(scope, jobId, batch);
      if (result === undefined) throw new Error('conversion not running');
      counts = { ...result.counts };
      if (!result.done) continue;
      const end = await schema.finishConversion(scope, jobId, { status: 'succeeded', counts });
      if (end === 'finished') return counts;
      if (end !== 'pending') throw new Error(`unexpected end: ${end}`);
    }
  }

  async function revertPreviewOf(fieldId: Id<'fld'>) {
    const conversion = await schema.revertibleConversion(scope, fieldId);
    if (conversion === undefined) throw new Error('no conversion');
    const current = await currentField(fieldId);
    const plan = planFieldConversion(
      storedDefinitionOf(conversion.from_definition),
      storedDefinitionOf(conversion.to_definition),
    );
    const audit = new AuditLogsRepository(db);
    return previewRevert(
      {
        query,
        members,
        provablyUntouched: (recordIds, since) =>
          audit.recordsProvablyUntouched(scope, {
            tableId: fx.orders.id,
            fieldId,
            recordIds,
            since,
          }),
      },
      {
        scope,
        tableId: fx.orders.id,
        access: admin(),
        column: conversion.old_column_name as string,
        currentColumn: current.db_column_name as string,
        writable: true,
        finishedAt: conversion.finished_at ?? conversion.created_at,
      },
      plan,
      LOCALE,
    );
  }

  /** Database time with microseconds (a JS Date would round it down). */
  async function dbNow(): Promise<string> {
    const { rows } = await sql<{ now: string }>`SELECT now()::text AS now`.execute(db.kysely);
    return rows[0]?.now ?? new Date().toISOString();
  }

  async function eventCount(type: string, entity?: string): Promise<number> {
    let q = db.kysely
      .selectFrom('meta.events')
      .select((eb) => eb.fn.countAll<bigint>().as('n'))
      .where('type', '=', type);
    if (entity !== undefined) q = q.where('entity_id', '=', entity);
    return Number((await q.executeTakeFirstOrThrow()).n);
  }

  describe('text → number (CONTRACTS §4.1)', () => {
    let field: FieldRow;
    let ids: Id<'rec'>[];

    beforeAll(async () => {
      field = await addField('Số tiền (chữ)', 'text');
      ids = await fill(field, ['1.500.000', 'abc', '', null, '12', '1,5']);
      // One record in the trash is converted too.
      await pool.query(
        `UPDATE data.${pg.escapeIdentifier(fx.orders.db_table_name)} SET __deleted_at = now() WHERE __id = $1`,
        [ids[4]],
      );
    });

    it('previews counts equal to what the job writes, then converts every row', async () => {
      const planned = await preview(field, 'number', {});
      expect(planned).toMatchObject({ affected: 4, lost: 1, truncated: 0, newOptions: [] });
      expect(planned.invalid).toBeUndefined();
      expect(planned.samples[0]).toMatchObject({
        record_id: ids[1],
        from: 'abc',
        to: null,
        outcome: 'lost',
      });
      // The trash record never appears in samples (not live).
      expect(planned.samples.map((sample) => sample.record_id)).not.toContain(ids[4]);

      const recordEvents = await eventCount('record.updated');
      const started = await start(field, 'number', {});
      // Design decision #8: until the job ends the field shows its old values.
      expect(started.field).toMatchObject({ type: 'text' });
      expect(
        (await physicalColumns(db, fx.orders.db_table_name)).filter((column) =>
          column.startsWith(`${String(field.db_column_name)}__new_`),
        ),
      ).toHaveLength(1);
      await expectConsistent(schema, scope, fx.orders.id);
      const during = await query.getRecords(scope, fx.orders.id, [ids[0] as Id<'rec'>], admin(), {
        field_key_type: 'id',
        fields: [field.id],
      });
      expect(during[0]?.fields).toEqual({ [field.id]: '1.500.000' });
      const queued = await queuedJobs(db, 'field.convert');
      expect(queued.at(-1)).toMatchObject({
        queue_name: `schema:${fx.orders.id}`,
        payload: { job_id: started.jobId, field_id: field.id },
      });

      // Batches of 2 rows: several transactions.
      const counts = await runJob(started.jobId, 2);
      expect(counts).toMatchObject({ affected: 4, lost: 1, truncated: 0 });
      expect(await currentField(field.id)).toMatchObject({ type: 'number', unique_values: false });
      const columns = await physicalColumns(db, fx.orders.db_table_name);
      const oldColumns = columns.filter((column) =>
        column.startsWith(`${String(field.db_column_name)}__old_`),
      );
      expect(oldColumns).toHaveLength(1);
      expect(columns.some((column) => column.includes('__new_'))).toBe(false);
      expect(await columnValues(field.db_column_name as string, ids)).toEqual([
        '1500000',
        null,
        null,
        null,
        '12',
        '1.5',
      ]);
      // Old values are kept untouched for the revert.
      expect(await columnValues(oldColumns[0] as string, ids)).toEqual([
        '1.500.000',
        'abc',
        '',
        null,
        '12',
        '1,5',
      ]);
      // S4 open question #7: one field.converted, no per-record events.
      expect(await eventCount('record.updated')).toBe(recordEvents);
      expect(await eventCount('field.converted', field.id)).toBe(1);
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .selectAll()
        .where('action', '=', 'field.converted')
        .where('entity_id', '=', field.id)
        .executeTakeFirstOrThrow();
      expect(audit.before).toMatchObject({ type: 'text' });
      expect(audit.after).toMatchObject({ type: 'number', counts: { affected: 4, lost: 1 } });
      expect(audit.batch_id).toBe(started.jobId);
      expect(audit.actor_id).toBe(fx.users.u_admin.id);
      const job = await jobs.getById(scope, started.jobId);
      expect(job).toMatchObject({ status: 'succeeded', progress: 1 });
      await expectConsistent(schema, scope, fx.orders.id);
    });

    it('reads the converted values through the record services', async () => {
      const read = await query.getRecords(scope, fx.orders.id, [ids[0] as Id<'rec'>], admin(), {
        field_key_type: 'id',
        fields: [field.id],
      });
      expect(read[0]?.fields).toEqual({ [field.id]: 1500000 });
    });

    it('reverts within 7 days keeping later edits (design decision #7)', async () => {
      await records.update(
        scope,
        fx.orders.id,
        admin(),
        {
          field_key_type: 'id',
          records: [{ id: ids[1] as Id<'rec'>, fields: { [field.id]: 99 } }],
        },
        ctx(),
      );
      const revertPreview = await revertPreviewOf(field.id);
      expect(revertPreview).toMatchObject({ unchanged: 5, edited: 1, editedUnconvertible: 0 });
      expect(revertPreview.keptEdits).toEqual([{ id: ids[1], value: '99' }]);
      expect(revertPreview.samples).toEqual([
        { record_id: ids[1], from: 99, to: '99', outcome: 'kept' },
      ]);

      const conversion = await schema.revertibleConversion(scope, field.id);
      const since = await dbNow();
      expect(
        await records.mergeRevertEdits(
          scope,
          conversion?.job_id as Id<'job'>,
          revertPreview.keptEdits,
        ),
      ).toBe(1);
      const reverted = await schema.revertConversion(scope, field.id, ctx(), {
        mode: 'keep_later_edits',
        mergedSince: since,
      });
      expect(reverted).toMatchObject({ type: 'text', db_column_name: field.db_column_name });
      expect(await columnValues(field.db_column_name as string, ids)).toEqual([
        '1.500.000',
        '99',
        '',
        null,
        '12',
        '1,5',
      ]);
      await expectConsistent(schema, scope, fx.orders.id);
      expect(await eventCount('field.converted', field.id)).toBe(2);
      // Nothing left to revert.
      expect((await appError(schema.revertConversion(scope, field.id, ctx()))).code).toBe(
        'NOT_FOUND',
      );
    });
  });

  describe('revert modes', () => {
    async function convertedWithEdit(name: string) {
      const field = await addField(name, 'text');
      const ids = await fill(field, ['1', 'x']);
      const started = await start(field, 'number', {});
      await runJob(started.jobId);
      await records.update(
        scope,
        fx.orders.id,
        admin(),
        { field_key_type: 'id', records: [{ id: ids[0] as Id<'rec'>, fields: { [field.id]: 5 } }] },
        ctx(),
      );
      return { field, ids, jobId: started.jobId };
    }

    it('keep_later_edits refuses when the field was written after the merge', async () => {
      const { field, ids } = await convertedWithEdit('Ghi chen');
      const since = await dbNow();
      await records.update(
        scope,
        fx.orders.id,
        admin(),
        { field_key_type: 'id', records: [{ id: ids[1] as Id<'rec'>, fields: { [field.id]: 7 } }] },
        ctx(),
      );
      const error = await schema
        .revertConversion(scope, field.id, ctx(), { mode: 'keep_later_edits', mergedSince: since })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConcurrentFieldEditsError);
      expect((await currentField(field.id)).type).toBe('number');
    });

    it('keeps a cell written after the conversion when a redacted audit cannot prove it untouched', async () => {
      const field = await addField('Kiem toan', 'text');
      const ids = await fill(field, ['1.000', '2.000']);
      const started = await start(field, 'number', {});
      await runJob(started.jobId);
      // Both records are written later on another field; record B's audit is then redacted.
      for (const id of ids) {
        await records.update(
          scope,
          fx.orders.id,
          admin(),
          { field_key_type: 'id', records: [{ id, fields: { [fx.fld.title.id]: 'later' } }] },
          ctx(),
        );
      }
      await new AuditLogsRepository(db).redact(scope, fx.users.u_editor.id, {
        entityType: 'record',
        entityIds: [ids[1] as string],
      });
      const preview = await revertPreviewOf(field.id);
      // A: its trail proves the field untouched → restored; B: uncertain → kept (fail safe).
      expect(preview.keptEdits).toEqual([{ id: ids[1], value: '2000' }]);
      const conversion = await schema.revertibleConversion(scope, field.id);
      const since = await dbNow();
      await records.mergeRevertEdits(scope, conversion?.job_id as Id<'job'>, preview.keptEdits);
      await schema.revertConversion(scope, field.id, ctx(), {
        mode: 'keep_later_edits',
        mergedSince: since,
      });
      expect(await columnValues(field.db_column_name as string, ids)).toEqual(['1.000', '2000']);
    });

    it('overwrite_later_edits restores every old value', async () => {
      const { field, ids } = await convertedWithEdit('Ghi de');
      expect(await revertPreviewOf(field.id)).toMatchObject({ edited: 1, editedUnconvertible: 0 });
      await schema.revertConversion(scope, field.id, ctx(), { mode: 'overwrite_later_edits' });
      expect(await columnValues(field.db_column_name as string, ids)).toEqual(['1', 'x']);
      await expectConsistent(schema, scope, fx.orders.id);
    });

    it('restores the old version as a new field without touching the converted one', async () => {
      const { field, ids, jobId } = await convertedWithEdit('Ban cu');
      const restored = await schema.restoreConversionAsNewField(
        scope,
        field.id,
        'Ban cu (old)',
        ctx(),
      );
      expect(restored).toMatchObject({ type: 'text', name: 'Ban cu (old)' });
      expect(await columnValues(restored.db_column_name as string, ids)).toEqual(['1', 'x']);
      expect(await currentField(field.id)).toMatchObject({ type: 'number' });
      expect(await columnValues(field.db_column_name as string, ids)).toEqual(['5', null]);
      expect((await conversions.getByJob(scope, jobId))?.status).toBe('cleaned');
      expect((await appError(schema.revertConversion(scope, field.id, ctx()))).code).toBe(
        'NOT_FOUND',
      );
      await expectConsistent(schema, scope, fx.orders.id);
    });
  });

  describe('locks while the values are being converted (S4 open question #8)', () => {
    it('refuses writes to the field and schema changes of it, not writes to other fields', async () => {
      const field = await addField('Mã', 'text');
      const [id] = await fill(field, ['7']);
      const started = await start(field, 'number', {});

      const write = await appError(
        records.update(
          scope,
          fx.orders.id,
          admin(),
          { field_key_type: 'id', records: [{ id: id as Id<'rec'>, fields: { [field.id]: 8 } }] },
          ctx(),
        ),
      );
      expect(write.status).toBe(409);
      expect(write.code).toBe('SCHEMA_LOCKED');
      expect(write.errors?.[0]).toMatchObject({
        code: 'FIELD_CONVERTING',
        path: `records[0].fields.${field.id}`,
      });
      await records.update(
        scope,
        fx.orders.id,
        admin(),
        {
          field_key_type: 'id',
          records: [{ id: id as Id<'rec'>, fields: { [fx.fld.title.id]: 'ok' } }],
        },
        ctx(),
      );
      const rename = await appError(schema.updateField(scope, field.id, { name: 'Mã 2' }, ctx()));
      expect(rename.code).toBe('SCHEMA_LOCKED');
      expect(rename.errors?.[0]?.code).toBe('FIELD_CONVERTING');
      expect((await appError(schema.deleteField(scope, field.id, ctx()))).code).toBe(
        'SCHEMA_LOCKED',
      );
      expect((await appError(start(await currentField(field.id), 'text', {}))).code).toBe(
        'SCHEMA_LOCKED',
      );
      expect((await appError(schema.revertConversion(scope, field.id, ctx()))).code).toBe(
        'SCHEMA_LOCKED',
      );

      await runJob(started.jobId);
      await schema.updateField(scope, field.id, { name: 'Mã 2' }, ctx());
      await records.update(
        scope,
        fx.orders.id,
        admin(),
        { field_key_type: 'id', records: [{ id: id as Id<'rec'>, fields: { [field.id]: 8 } }] },
        ctx(),
      );
    });

    it('converts rows created meanwhile (default values) before the swap', async () => {
      const field = await addField('Mặc định', 'text', { default_value: '42' });
      await fill(field, ['1']);
      const started = await start(field, 'number', {});
      await jobs.markRunning(scope, started.jobId);
      const first = await records.convertFieldBatch(scope, started.jobId, 5000);
      expect(first?.done).toBe(true);
      const created = await records.create(
        scope,
        fx.orders.id,
        admin(),
        { field_key_type: 'id', records: [{ fields: { [fx.fld.title.id]: 'new' } }] },
        ctx(),
      );
      const id = created.records[0]?.id as Id<'rec'>;
      expect(
        await schema.finishConversion(scope, started.jobId, {
          status: 'succeeded',
          counts: { ...first?.counts },
        }),
      ).toBe('pending');
      await runJob(started.jobId);
      const read = await query.getRecords(scope, fx.orders.id, [id], admin(), {
        field_key_type: 'id',
        fields: [field.id],
      });
      expect(read[0]?.fields).toEqual({ [field.id]: 42 });
    });

    it('a failed conversion drops its shadow column and leaves the field as it was', async () => {
      const field = await addField('Hỏng', 'text');
      await fill(field, ['1']);
      const started = await start(field, 'number', {});
      await jobs.markRunning(scope, started.jobId);
      expect(
        await schema.finishConversion(scope, started.jobId, {
          status: 'failed',
          counts: {},
          error: { code: 'INTERNAL' },
        }),
      ).toBe('finished');
      expect(await currentField(field.id)).toMatchObject({ type: 'text' });
      expect((await jobs.getById(scope, started.jobId))?.status).toBe('failed');
      expect(
        (await physicalColumns(db, fx.orders.db_table_name)).some((column) =>
          column.startsWith(`${String(field.db_column_name)}__new_`),
        ),
      ).toBe(false);
      await expectConsistent(schema, scope, fx.orders.id);
      // Nothing to revert, and the field is writable again.
      expect((await appError(schema.revertConversion(scope, field.id, ctx()))).code).toBe(
        'NOT_FOUND',
      );
      await schema.updateField(scope, field.id, { name: 'Hỏng 2' }, ctx());
    });

    it('refuses a plan made on an older definition', async () => {
      const field = await addField('Cũ', 'text');
      await schema.updateField(scope, field.id, { options: { style: { type: 'email' } } }, ctx());
      const error = await appError(start(field, 'number', {}));
      expect(error.code).toBe('SCHEMA_LOCKED');
    });
  });

  describe('other pairs', () => {
    it('datetime date-only → date-time keeps each day (start of day in the field zone)', async () => {
      const field = await addField('Ngày', 'datetime', { style: { format: 'dd/MM/yyyy' } });
      const ids = await fill(field, ['2026-09-25', null]);
      const toOptions = { style: { format: 'dd/MM/yyyy HH:mm' }, timezone: 'Asia/Ho_Chi_Minh' };
      expect(await preview(field, 'datetime', toOptions)).toMatchObject({ affected: 1, lost: 0 });
      const started = await start(field, 'datetime', toOptions);
      await runJob(started.jobId);
      const read = await query.getRecords(scope, fx.orders.id, ids, admin(), {
        field_key_type: 'id',
        fields: [field.id],
      });
      expect(read.map((record) => record.fields[field.id])).toEqual([
        '2026-09-24T17:00:00.000Z',
        null,
      ]);
      await expectConsistent(schema, scope, fx.orders.id);
    });

    it('select multiple → single keeps the first option, with its CHECK', async () => {
      const a = newId('opt');
      const b = newId('opt');
      const options = [
        { id: a, name: 'A' },
        { id: b, name: 'B' },
      ];
      const field = await addField('Nhãn', 'select', { multiple: true, options });
      const ids = await fill(field, [[b, a], [a], null]);
      const planned = await preview(field, 'select', { multiple: false, options });
      expect(planned).toMatchObject({ affected: 2, truncated: 1, lost: 0 });
      const started = await start(field, 'select', { multiple: false, options });
      await runJob(started.jobId);
      expect(await columnValues(field.db_column_name as string, ids)).toEqual([[b], [a], null]);
      await expectConsistent(schema, scope, fx.orders.id);
    });

    it('select ← text creates the options the preview named', async () => {
      const field = await addField('Trạng thái chữ', 'text');
      const ids = await fill(field, ['Mới', 'Xong', 'Mới', null]);
      const planned = await preview(field, 'select', {});
      expect(planned.newOptions).toEqual(['Mới', 'Xong']);
      const options = planned.newOptions.map((name) => ({ id: newId('opt'), name }));
      const started = await start(field, 'select', { options });
      await runJob(started.jobId);
      const [first, second] = options;
      expect(await columnValues(field.db_column_name as string, ids)).toEqual([
        [first?.id],
        [second?.id],
        [first?.id],
        null,
      ]);
    });

    it('created_at → text gets a column of its own, and the revert gives it back', async () => {
      const field = await addField('Tạo lúc', 'created_at', { style: { format: 'dd/MM/yyyy' } });
      expect(field.db_column_name).toBeNull();
      const started = await start(field, 'text', {});
      expect(started.field.db_column_name).toBeNull();
      await runJob(started.jobId);
      expect((await currentField(field.id)).db_column_name).toMatch(/^f_[0-9a-z]{12}$/);
      await expectConsistent(schema, scope, fx.orders.id);
      const reverted = await schema.revertConversion(scope, field.id, ctx());
      expect(reverted).toMatchObject({ type: 'created_at', db_column_name: null });
      await expectConsistent(schema, scope, fx.orders.id);
    });

    it('text style email: preview counts invalid cells and never changes them', async () => {
      const field = await addField('Email', 'text');
      const values = Array.from({ length: 1000 }, (_, index) =>
        index % 27 === 0 && index < 27 * 37 ? `sai ${String(index)}` : `u${String(index)}@x.vn`,
      );
      const ids = await fill(field, values);
      const planned = await preview(field, 'text', { style: { type: 'email' } });
      expect(planned).toMatchObject({ affected: 0, lost: 0, invalid: 37 });
      expect(planned.samples).toHaveLength(20);
      expect(planned.samples.every((sample) => sample.outcome === 'invalid')).toBe(true);
      await schema.updateField(scope, field.id, { options: { style: { type: 'email' } } }, ctx());
      expect(await columnValues(field.db_column_name as string, ids.slice(0, 2))).toEqual(
        values.slice(0, 2),
      );
    });
  });

  describe('column budget, compaction and cleanup', () => {
    it('refuses to start at the hard slot threshold (ADR-20)', async () => {
      const field = await addField('Ngân sách', 'text');
      const used = await usedColumnSlots(db.kysely, fx.orders.db_table_name);
      const tight = new SchemaService(db, {
        maxFieldsPerTable: 500,
        slotThresholds: { compact: used - 1, lock: used },
      });
      const error = await appError(
        tight.startConversion(
          scope,
          field.id,
          {
            expectedFrom: { type: field.type, options: field.options },
            toType: 'number',
            toOptions: {},
            settings: {},
            locale: 'vi',
            timeZone: 'UTC',
          },
          ctx(),
        ),
      );
      expect(error).toMatchObject({ status: 409, code: 'SCHEMA_LOCKED' });
      expect((await currentField(field.id)).type).toBe('text');
    });

    it('compaction keeps the old column within 7 days, the revert still works', async () => {
      const field = await addField('Giữ', 'text');
      const ids = await fill(field, ['5']);
      const started = await start(field, 'number', {});
      await runJob(started.jobId);
      const result = await schema.compactTable(scope, fx.orders.id);
      expect(result.rows).toBeGreaterThan(0);
      await expectConsistent(schema, scope, fx.orders.id);
      await schema.revertConversion(scope, field.id, ctx());
      expect(await columnValues(field.db_column_name as string, ids)).toEqual(['5']);
      await expectConsistent(schema, scope, fx.orders.id);
    });

    it('after 7 days: revert is 404, cleanup drops the old column', async () => {
      const field = await addField('Hết hạn', 'text');
      await fill(field, ['1']);
      const started = await start(field, 'number', {});
      await runJob(started.jobId);
      await db.kysely
        .updateTable('meta.field_conversions')
        .set({ expires_at: new Date(Date.now() - 1000) } as never)
        .where('job_id', '=', started.jobId)
        .execute();
      expect((await appError(schema.revertConversion(scope, field.id, ctx()))).code).toBe(
        'NOT_FOUND',
      );
      const expired = await listExpiredFieldConversions(db.kysely, { now: new Date(), limit: 100 });
      expect(expired).toContainEqual({ organizationId: ORG_A, jobId: started.jobId });
      expect(await schema.dropExpiredConversionColumn(scope, started.jobId)).toBe(true);
      expect(await schema.dropExpiredConversionColumn(scope, started.jobId)).toBe(false);
      const columns = await physicalColumns(db, fx.orders.db_table_name);
      expect(
        columns.some((column) => column.startsWith(`${String(field.db_column_name)}__old_`)),
      ).toBe(false);
      expect((await conversions.getByJob(scope, started.jobId))?.status).toBe('cleaned');
      await expectConsistent(schema, scope, fx.orders.id);
    });
  });

  it('record history renders entries older than a conversion with the old definition', async () => {
    const field = await addField('Lịch sử', 'text');
    const created = await records.create(
      scope,
      fx.orders.id,
      admin(),
      { field_key_type: 'id', records: [{ fields: { [field.id]: 'abc' } }] },
      ctx(),
    );
    const id = created.records[0]?.id as Id<'rec'>;
    const started = await start(await currentField(field.id), 'number', {});
    await runJob(started.jobId);
    const history = new RecordHistoryService(db, query, records);
    const page = await history.history(
      scope,
      fx.orders.id,
      id,
      admin(),
      { field_key_type: 'id' },
      { userId: null, isOrgAdmin: true },
    );
    expect(page.items.at(-1)?.changes[field.id]).toEqual({ from: null, to: 'abc' });
  });

  it('lists dependents: views and roles using the field', () => {
    const fieldId = fx.fld.status.id;
    const views = [
      {
        id: 'viw_1',
        config: { filter: { op: 'and', items: [{ field: fieldId, operator: 'is', value: 'x' }] } },
      },
      { id: 'viw_2', config: { sort: [{ field: fieldId, direction: 'asc' }] } },
      { id: 'viw_3', config: { kanban: { group_field: fieldId, card_fields: [] } } },
      { id: 'viw_4', config: { form: { fields: [{ field: fieldId }] } } },
      { id: 'viw_5', config: { hidden_fields: [fieldId] } },
    ];
    const roles = [{ id: fx.roles.sales.id, config: fx.roles.sales.config as never }];
    expect(fieldDependents(fieldId, fx.orders.id, views as never, roles)).toEqual([
      { type: 'view', id: 'viw_1' },
      { type: 'view', id: 'viw_2' },
      { type: 'view', id: 'viw_3' },
      { type: 'view', id: 'viw_4' },
      { type: 'role', id: fx.roles.sales.id },
    ]);
  });

  it('FieldConversionsRepository is isolated by organization', async () => {
    const tenantB = await seedTenant(db, ORG_B);
    const scopeB = orgScope(ORG_B);
    const { table, primaryField } = await schema.createTable(
      scopeB,
      { baseId: tenantB.baseId, name: 'B', primaryFieldName: 'Name' },
      userContext(tenantB.userId),
    );
    const started = await schema.startConversion(
      scopeB,
      primaryField.id,
      {
        expectedFrom: { type: primaryField.type, options: primaryField.options },
        toType: 'number',
        toOptions: {},
        settings: {},
        locale: 'vi',
        timeZone: 'UTC',
      },
      userContext(tenantB.userId),
    );
    // Organization A sees nothing of B's conversion, and cannot change it.
    expect(await conversions.getByJob(scope, started.jobId)).toBeUndefined();
    expect(await conversions.lockByJob(scope, started.jobId)).toBeUndefined();
    expect(await conversions.latestForField(scope, primaryField.id)).toBeUndefined();
    expect(await conversions.listLiveByTable(scope, table.id)).toEqual([]);
    expect(await conversions.runningFieldIds(scope, table.id)).toEqual(new Set());
    expect(await conversions.writeLockedFieldIds(scope, table.id)).toEqual(new Set());
    expect(await conversions.listForFields(scope, [primaryField.id])).toEqual([]);
    expect(
      await conversions.setProgress(scope, started.jobId, { cursorAuto: 5n, counts: {} }),
    ).toBeUndefined();
    expect(await conversions.markFinished(scope, started.jobId, 'failed', {})).toBeUndefined();
    expect(await conversions.markReverted(scope, started.jobId)).toBeUndefined();
    expect(await conversions.markCleaned(scope, started.jobId)).toBeUndefined();
    expect(await records.convertFieldBatch(scope, started.jobId)).toBeUndefined();
    expect(
      await schema.finishConversion(scope, started.jobId, { status: 'failed', counts: {} }),
    ).toBe('not_running');
    const own = await conversions.getByJob(scopeB, started.jobId);
    expect(own).toMatchObject({ status: 'running', table_id: table.id });
    expect(countsOf(own?.counts ?? {})).toMatchObject({ total: 0, processed: 0 });
    // The other organization's own view is unchanged.
    expect((await conversions.runningFieldIds(scopeB, table.id)).has(primaryField.id)).toBe(true);
    expect((await conversions.writeLockedFieldIds(scopeB, table.id)).has(primaryField.id)).toBe(
      true,
    );
  });

  it('publishes schema.changed (updated, converted) and field.converting progress', async () => {
    const envelopes: RealtimeEnvelope[] = [];
    const changes: SchemaChange[] = [];
    attachRealtimePublisher(db, {
      publish: (envelope) => {
        envelopes.push(envelope);
        return Promise.resolve();
      },
    });
    const spied = new SchemaService(db, {
      maxFieldsPerTable: 500,
      publisher: { publish: (change) => void changes.push(change) },
    });
    const spiedRecords = new RecordMutationService(db, { schema: spied, query, now: () => NOW });
    const field = await addField('Realtime', 'text');
    await fill(field, ['1', '2', '3']);
    const started = await spied.startConversion(
      scope,
      field.id,
      {
        expectedFrom: { type: field.type, options: field.options },
        toType: 'number',
        toOptions: {},
        settings: {},
        locale: 'vi',
        timeZone: 'UTC',
      },
      ctx(),
    );
    await jobs.markRunning(scope, started.jobId);
    for (;;) {
      const batch = await spiedRecords.convertFieldBatch(scope, started.jobId, 2);
      if (batch?.done !== true) continue;
      if (
        (await spied.finishConversion(scope, started.jobId, {
          status: 'succeeded',
          counts: { ...batch.counts },
        })) === 'finished'
      )
        break;
    }
    expect(
      changes.filter((change) => change.entity_id === field.id).map((change) => change.action),
    ).toEqual(['updated', 'converted']);
    const progress = envelopes.filter(
      (envelope) => envelope.type === 'field.converting' && envelope.field_id === field.id,
    );
    expect(progress.at(0)).toMatchObject({
      status: 'running',
      progress: 0,
      from_type: 'text',
      to_type: 'number',
      actor_id: fx.users.u_admin.id,
    });
    expect(progress.at(-1)).toMatchObject({ status: 'succeeded', progress: 1 });
    expect(progress.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps the insert of the old column type exact in consistency checks', async () => {
    await expectConsistent(schema, scope, fx.orders.id);
    const { rows } = await sql<{
      n: string;
    }>`SELECT count(*)::text AS n FROM meta.field_conversions`.execute(db.kysely);
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });
});
