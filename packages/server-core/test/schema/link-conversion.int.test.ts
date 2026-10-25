/**
 * Link conversions (BACKLOG T404, ADR-28, CONTRACTS §4) on PostgreSQL 18:
 * `SchemaService.startLinkConversion` / `finishConversion` /
 * `revertLinkConversion`, the `to_single` batches through
 * `RecordMutationService.convertFieldBatch`, the counts of
 * `RecordQueryService.scanLinkCells`, the schema lock of both sides and
 * tenant isolation of the repository methods added for it. The HTTP API
 * and the worker are tested in their own packages.
 */
import { newId, type Id } from '@cellhive/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLogsRepository, type AuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  RecordMutationService,
  RecordQueryService,
  type RecordAccessContext,
} from '../../src/records/index.js';
import {
  FieldConversionsRepository,
  FieldsRepository,
  SchemaService,
  type StartLinkConversionInput,
} from '../../src/schema/index.js';
import { accessOf, buildOrdersFixture, NOW, type OrdersFixture } from '../records/fixtures.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { expectConsistent, userContext } from '../support/schema.js';

import type { FieldRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T404LinkConvOrgA';
const ORG_B: Id<'org'> = 'org_T404LinkConvOrgB';

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('link conversions (T404, PostgreSQL 18)', () => {
  let database: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let schema: SchemaService;
  let records: RecordMutationService;
  let query: RecordQueryService;
  let conversions: FieldConversionsRepository;
  let fields: FieldsRepository;
  let fx: OrdersFixture;
  const scope = orgScope(ORG_A);
  let c1: Id<'rec'>, c2: Id<'rec'>, c3: Id<'rec'>;

  const as = (): RecordAccessContext => accessOf(fx, 'u_admin');
  const ctx = (): AuditContext => userContext(fx.users.u_admin.id);

  function register(field: FieldRow): void {
    const table = fx.schema.tables.find((candidate) => candidate.id === field.table_id);
    if (table === undefined) throw new Error('unknown table');
    table.fields = [
      ...table.fields.filter((f) => f.id !== field.id),
      { id: field.id, type: field.type },
    ];
  }

  async function field(id: Id<'fld'>): Promise<FieldRow> {
    const row = await fields.getById(scope, id, { includeDeleted: true });
    if (row === undefined) throw new Error('no field');
    return row;
  }

  async function newLink(name: string, options: Record<string, unknown> = {}): Promise<FieldRow> {
    const created = await schema.addField(
      scope,
      fx.orders.id,
      { name, type: 'link', options: { link_table: fx.customers.id, ...options } },
      ctx(),
    );
    register(created);
    return created;
  }

  async function orders(fieldName: string, cells: readonly (readonly Id<'rec'>[])[]) {
    const out = await records.create(
      scope,
      fx.orders.id,
      as(),
      {
        records: cells.map((cell, index) => ({
          fields: { title: `o${String(index)}`, [fieldName]: [...cell] },
        })),
      },
      ctx(),
    );
    return out.records.map((record) => record.id);
  }

  async function cell(tableId: Id<'tbl'>, id: Id<'rec'>, fieldId: Id<'fld'>) {
    const record = await query.getRecord(scope, tableId, id, as(), {
      fields: [fieldId],
      field_key_type: 'id',
    });
    const value = record.fields[fieldId];
    return Array.isArray(value) ? value.map((ref) => (ref as { id: string }).id) : null;
  }

  /** Runs the `field.convert` job the way the worker does. */
  async function runJob(jobId: Id<'job'>, batchSize = 2): Promise<string> {
    for (;;) {
      const result = await records.convertFieldBatch(scope, jobId, batchSize);
      if (result === undefined) return 'not_running';
      if (!result.done) continue;
      const end = await schema.finishConversion(scope, jobId, {
        status: 'succeeded',
        counts: { ...result.counts },
      });
      if (end !== 'pending') return end;
    }
  }

  async function start(
    fieldId: Id<'fld'>,
    input: Omit<StartLinkConversionInput, 'expectedOptions'>,
  ) {
    const current = await field(fieldId);
    return schema.startLinkConversion(
      scope,
      fieldId,
      { expectedOptions: current.options, ...input },
      ctx(),
    );
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    admin = new pg.Pool({ connectionString: database.adminUrl, max: 4 });
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    records = new RecordMutationService(db, { schema, query, now: () => NOW });
    conversions = new FieldConversionsRepository(db);
    fields = new FieldsRepository(db);
    fx = await buildOrdersFixture(db, schema, ORG_A);
    await buildOrdersFixture(db, new SchemaService(db, { maxFieldsPerTable: 500 }), ORG_B);
    const created = await records.create(
      scope,
      fx.customers.id,
      as(),
      {
        records: [
          { fields: { name: 'An' } },
          { fields: { name: 'Bình' } },
          { fields: { name: 'Cát' } },
        ],
      },
      ctx(),
    );
    [c1, c2, c3] = created.records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
  });

  afterAll(async () => {
    await admin.end();
    await db.destroy();
    await database.drop();
  });

  it('one-way → two-way: the reverse field reads the same junction; revert trashes it', async () => {
    const link = await newLink('buyer');
    const [o1, o2] = (await orders('buyer', [[c1], [c1, c2]])) as [Id<'rec'>, Id<'rec'>];
    const events = async () =>
      Number(
        (
          await admin.query<{ n: string }>(
            `SELECT count(*) AS n FROM meta.events
              WHERE organization_id = $1 AND type = 'record.updated' AND entity_id = ANY($2)`,
            [ORG_A, [c1, c2, c3]],
          )
        ).rows[0]?.n,
      );
    const before = await events();
    const started = await start(link.id, { change: 'to_two_way', reverseName: 'Đơn mua' });
    // While running: both sides locked for schema changes, record writes go on.
    const locked = await appError(schema.updateField(scope, link.id, { name: 'x' }, ctx()));
    expect(locked.code).toBe('SCHEMA_LOCKED');
    await records.update(
      scope,
      fx.orders.id,
      as(),
      { records: [{ id: o2, fields: { buyer: [c1, c2, c3] } }] },
      ctx(),
    );
    expect(await runJob(started.jobId)).toBe('finished');

    const converted = await field(link.id);
    const reverseId = (converted.options as { symmetric_field_id: Id<'fld'> }).symmetric_field_id;
    expect(converted.options).toMatchObject({
      bidirectional: true,
      bidirectional_link_field_name: 'Đơn mua',
    });
    const reverse = await field(reverseId);
    register(reverse);
    expect(reverse).toMatchObject({
      table_id: fx.customers.id,
      name: 'Đơn mua',
      link_junction: link.link_junction,
      link_side: 'b',
      options: { link_table: fx.orders.id, symmetric_field_id: link.id, allow_multiple: true },
    });
    expect(await cell(fx.customers.id, c1, reverseId)).toEqual([o1, o2]);
    expect(await cell(fx.customers.id, c3, reverseId)).toEqual([o2]);
    // No record event on the Customers side: the data did not change.
    expect(await events()).toBe(before);
    await expectConsistent(schema, scope, fx.customers.id);

    // Revert (≤ 7 days): the reverse field goes to the trash, the link is one-way again.
    await schema.revertLinkConversion(scope, link.id, ctx());
    expect((await field(reverseId)).deleted_at).not.toBeNull();
    expect((await field(link.id)).options).toMatchObject({
      bidirectional: false,
      symmetric_field_id: null,
    });
    const latest = await conversions.latestForField(scope, link.id);
    expect(latest?.status).toBe('reverted');

    // Two-way again: the junction side in the trash comes back with the new name.
    const again = await start(link.id, { change: 'to_two_way', reverseName: 'Orders again' });
    await runJob(again.jobId);
    const back = await field(reverseId);
    expect(back.deleted_at).toBeNull();
    expect(back.name).toBe('Orders again');
    expect((await field(link.id)).options).toMatchObject({ symmetric_field_id: reverseId });
  });

  it('two-way → one-way keeps the chosen side; revert restores the other with its id', async () => {
    const link = await newLink('seller', {
      bidirectional: true,
      bidirectional_link_field_name: 'Sold',
    });
    const reverseId = (link.options as { symmetric_field_id: Id<'fld'> }).symmetric_field_id;
    register(await field(reverseId));
    const [o1] = (await orders('seller', [[c2]])) as [Id<'rec'>];
    // Keep the Customers side: convert the reverse field.
    const started = await start(reverseId, { change: 'to_one_way' });
    const partnerLocked = await appError(schema.deleteField(scope, link.id, ctx()));
    expect(partnerLocked.code).toBe('SCHEMA_LOCKED');
    await runJob(started.jobId);
    expect((await field(link.id)).deleted_at).not.toBeNull();
    expect((await field(reverseId)).options).toMatchObject({
      bidirectional: false,
      symmetric_field_id: null,
    });
    expect(await cell(fx.customers.id, c2, reverseId)).toEqual([o1]);

    await schema.revertLinkConversion(scope, reverseId, ctx());
    const restored = await field(link.id);
    expect(restored.deleted_at).toBeNull();
    expect(restored.options).toMatchObject({ bidirectional: true, symmetric_field_id: reverseId });
    expect((await field(reverseId)).options).toMatchObject({
      bidirectional: true,
      symmetric_field_id: link.id,
    });
    expect(await cell(fx.orders.id, o1, link.id)).toEqual([c2]);
  });

  it('allow_multiple true → false keeps the first link, audits cut records, reverts', async () => {
    const link = await newLink('pick');
    const [o1, o2, o3, o4] = (await orders('pick', [[c2, c1], [c3], [c1, c3, c2], []])) as [
      Id<'rec'>,
      Id<'rec'>,
      Id<'rec'>,
      Id<'rec'>,
    ];
    // Counts of the preview scan.
    const scanned = await query.scanLinkCells(scope, link.id, as(), {
      side: 'own',
      after: null,
      limit: 100,
    });
    expect(
      scanned
        .filter((row) => row.links > 1)
        .map((row) => row.id)
        .sort(),
    ).toEqual([o1, o3].sort());
    const started = await start(link.id, {
      change: 'to_single',
      counts: { total: 2, affected: 3 },
    });
    // The job runs cell batches of 1: the end sees every cell cut.
    expect(await runJob(started.jobId, 1)).toBe('finished');
    expect(await cell(fx.orders.id, o1, link.id)).toEqual([c2]);
    expect(await cell(fx.orders.id, o2, link.id)).toEqual([c3]);
    expect(await cell(fx.orders.id, o3, link.id)).toEqual([c1]);
    expect(await cell(fx.orders.id, o4, link.id)).toBeNull();
    expect((await field(link.id)).options).toMatchObject({ allow_multiple: false });
    const index = await admin.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [
      `${link.link_junction as string}_a_uniq`,
    ]);
    expect(index.rowCount).toBe(1);
    const audits = await admin.query<{ entity_id: string; before: unknown; after: unknown }>(
      `SELECT entity_id, before, after FROM meta.audit_logs
        WHERE organization_id = $1 AND action = 'record.updated' AND batch_id = $2 ORDER BY entity_id`,
      [ORG_A, started.jobId],
    );
    // Sorted in JS on both sides: `ORDER BY entity_id` follows the collation (mixed case ids).
    const byEntity = (a: { entity_id: string }, b: { entity_id: string }) =>
      a.entity_id < b.entity_id ? -1 : 1;
    expect([...audits.rows].sort(byEntity)).toEqual(
      [
        { entity_id: o1, before: { [link.id]: [c2, c1] }, after: { [link.id]: [c2] } },
        { entity_id: o3, before: { [link.id]: [c1, c3, c2] }, after: { [link.id]: [c1] } },
      ].sort(byEntity),
    );
    const conversion = await conversions.latestForField(scope, link.id);
    expect(conversion).toMatchObject({ kind: 'to_single', status: 'succeeded' });
    expect(conversion?.backup_table_name).toMatch(/^l_[0-9a-z]{12}__old_[0-9]+$/);

    // A second link is refused now; o1 is then edited (kept by the default revert).
    const refused = await appError(
      records.update(
        scope,
        fx.orders.id,
        as(),
        { records: [{ id: o2, fields: { pick: [c3, c1] } }] },
        ctx(),
      ),
    );
    expect(refused.code).toBe('INVALID_CELL_VALUE');
    await records.update(
      scope,
      fx.orders.id,
      as(),
      { records: [{ id: o1, fields: { pick: [c3] } }] },
      ctx(),
    );

    await schema.revertLinkConversion(scope, link.id, ctx());
    expect(await cell(fx.orders.id, o1, link.id)).toEqual([c3]);
    expect(await cell(fx.orders.id, o3, link.id)).toEqual([c1, c3, c2]);
    expect((await field(link.id)).options).toMatchObject({ allow_multiple: true });
    const gone = await admin.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [
      `${link.link_junction as string}_a_uniq`,
    ]);
    expect(gone.rowCount).toBe(0);
    const backup = await admin.query(
      `SELECT 1 FROM pg_tables WHERE schemaname = 'data' AND tablename = $1`,
      [conversion?.backup_table_name],
    );
    expect(backup.rowCount).toBe(0);
    await expectConsistent(schema, scope, fx.orders.id);
  });

  it('overwrite_later_edits gives every cut cell its links back; a failed job restores them', async () => {
    const link = await newLink('many');
    const [o1] = (await orders('many', [[c1, c2]])) as [Id<'rec'>];
    const first = await start(link.id, { change: 'to_single' });
    await runJob(first.jobId);
    await records.update(
      scope,
      fx.orders.id,
      as(),
      { records: [{ id: o1, fields: { many: [c3] } }] },
      ctx(),
    );
    await schema.revertLinkConversion(scope, link.id, ctx(), 'overwrite_later_edits');
    expect(await cell(fx.orders.id, o1, link.id)).toEqual([c1, c2]);

    const second = await start(link.id, { change: 'to_single' });
    const batch = await records.convertFieldBatch(scope, second.jobId, 10);
    expect(batch?.counts.truncated).toBe(1);
    expect(await cell(fx.orders.id, o1, link.id)).toEqual([c1]);
    await schema.finishConversion(scope, second.jobId, {
      status: 'failed',
      counts: {},
      error: { code: 'INTERNAL' },
    });
    expect(await cell(fx.orders.id, o1, link.id)).toEqual([c1, c2]);
    expect((await field(link.id)).options).toMatchObject({ allow_multiple: true });
  });

  it('a reverse field made single gets the unique index of its side', async () => {
    const link = await newLink('two', {
      bidirectional: true,
      bidirectional_link_field_name: 'Two',
    });
    const reverseId = (link.options as { symmetric_field_id: Id<'fld'> }).symmetric_field_id;
    register(await field(reverseId));
    const [o1, o2] = (await orders('two', [[c1], [c1]])) as [Id<'rec'>, Id<'rec'>];
    const started = await start(reverseId, { change: 'to_single' });
    await runJob(started.jobId);
    expect(await cell(fx.customers.id, c1, reverseId)).toEqual([o1]);
    expect(await cell(fx.orders.id, o2, link.id)).toBeNull();
    const index = await admin.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [
      `${link.link_junction as string}_b_uniq`,
    ]);
    expect(index.rowCount).toBe(1);
    // Linking c1 from another order would give c1 two links on its single side.
    const refused = await appError(
      records.update(
        scope,
        fx.orders.id,
        as(),
        { records: [{ id: o2, fields: { two: [c1] } }] },
        ctx(),
      ),
    );
    expect(refused.code).toBe('INVALID_CELL_VALUE');
  });

  it('refuses stale plans and parent/other types with CONVERSION_NOT_ALLOWED', async () => {
    const link = await newLink('stale');
    const stale = await appError(
      schema.startLinkConversion(
        scope,
        link.id,
        { expectedOptions: {}, change: 'to_single' },
        ctx(),
      ),
    );
    expect(stale.code).toBe('SCHEMA_LOCKED');
    const parent = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'Parent', type: 'parent' },
      ctx(),
    );
    const refused = await appError(
      schema.startConversion(
        scope,
        parent.id,
        {
          expectedFrom: { type: 'parent', options: parent.options },
          toType: 'text',
          toOptions: {},
          settings: {},
          locale: 'vi',
          timeZone: 'UTC',
        },
        ctx(),
      ),
    );
    expect(refused.code).toBe('CONVERSION_NOT_ALLOWED');
  });

  it('keeps tenants apart (partner locks, write locks, audit trail)', async () => {
    const link = await newLink('iso', {
      bidirectional: true,
      bidirectional_link_field_name: 'Iso',
    });
    const reverseId = (link.options as { symmetric_field_id: Id<'fld'> }).symmetric_field_id;
    register(await field(reverseId));
    const started = await start(link.id, { change: 'to_one_way' });
    expect([...(await conversions.runningFieldIds(scope, fx.customers.id))]).toContain(reverseId);
    expect(await conversions.runningFieldIds(orgScope(ORG_B), fx.customers.id)).toEqual(new Set());
    // Link conversions never lock record writes.
    expect(await conversions.writeLockedFieldIds(scope, fx.orders.id)).toEqual(new Set());
    await runJob(started.jobId);
    const audits = new AuditLogsRepository(db);
    const ids = [newId('rec')];
    expect(
      await audits.recordsWithFieldChangesSince(orgScope(ORG_B), {
        tableId: fx.orders.id,
        fieldId: link.id,
        recordIds: ids,
        since: new Date(0),
      }),
    ).toEqual(new Set());
  });
});
