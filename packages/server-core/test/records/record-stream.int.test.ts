/**
 * `RecordQueryService.openStream` (BACKLOG T307, CONTRACTS §18): keyset
 * batches return exactly the rows and order of `query` (group → view sort →
 * `__auto`, empty cells last, keys of every type round-tripping, including
 * microsecond timestamps), view columns, the row cap, the checks before
 * reading, and cancellation of the statement in flight.
 */
import { newId, type Id, type StoredViewConfig } from '@cellhive/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../../src/errors/index.js';
import { orgScope, systemAuditContext, type Db } from '../../src/index.js';
import {
  RecordQueryService,
  type RecordAccessContext,
  type RecordOutput,
  type RecordStream,
} from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { configJson, defaultViewConfig, ViewsRepository } from '../../src/views/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, insertRows, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow } from '../../src/db/schema.js';

const ORG: Id<'org'> = 'org_T307RecordStream';

async function collect(stream: RecordStream): Promise<RecordOutput[]> {
  const out: RecordOutput[] = [];
  for await (const chunk of stream.records()) out.push(...chunk);
  return out;
}

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('RecordQueryService.openStream (T307)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let service: RecordQueryService;
  let views: ViewsRepository;
  let fx: OrdersFixture;
  let due: FieldRow;
  let tags: FieldRow;
  const tagIds = { a: newId('opt'), b: newId('opt') };
  const scope = orgScope(ORG);
  let admin: RecordAccessContext;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 4 });
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    service = new RecordQueryService(db, { now: () => NOW });
    views = new ViewsRepository(db);
    fx = await buildOrdersFixture(db, schema, ORG);
    const context = systemAuditContext();
    due = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'due', type: 'datetime', options: { style: { format: 'dd/MM/yyyy HH:mm' } } },
      context,
    );
    tags = await schema.addField(
      scope,
      fx.orders.id,
      {
        name: 'tags',
        type: 'select',
        options: {
          multiple: true,
          options: [
            { id: tagIds.a, name: 'A' },
            { id: tagIds.b, name: 'B' },
          ],
        },
      },
      context,
    );
    // TEST FIXTURE: the resolved access knows the two new fields.
    const orders = fx.schema.tables[0] as unknown as { fields: { id: Id<'fld'>; type: string }[] };
    orders.fields.push({ id: due.id, type: due.type }, { id: tags.id, type: tags.type });
    admin = accessOf(fx, 'u_admin');

    const col = (field: FieldRow) => field.db_column_name as string;
    const { title, amount, cost, status, owner } = fx.fld;
    const statuses = [[fx.opt.new], [fx.opt.done], null];
    const owners = [[fx.users.u_sales1.id], [fx.users.u_sales2.id], null];
    const tagSets = [[tagIds.a], [tagIds.b], [tagIds.a, tagIds.b], null];
    // Few distinct values (many ties), empty cells, and instants that differ
    // only below the millisecond.
    const rows = Array.from({ length: 53 }, (_, i) => ({
      [col(title)]: `r${String(i).padStart(2, '0')}`,
      [col(amount)]: i % 5 === 0 ? null : String((i * 7) % 4),
      [col(cost)]: String(i),
      [col(status)]: statuses[i % 3],
      [col(owner)]: owners[i % 4 === 3 ? 2 : i % 2],
      [col(due)]:
        i % 6 === 0 ? null : `2026-09-2${String(i % 3)} 01:02:03.${String(100000 + (i % 4))}+00`,
      [col(tags)]: tagSets[i % 4],
    }));
    await insertRows(pool, fx.orders, rows);
  });

  afterAll(async () => {
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  async function view(config: Partial<StoredViewConfig>): Promise<Id<'viw'>> {
    const row = await views.insert(scope, {
      id: newId('viw'),
      tableId: fx.orders.id,
      type: 'grid',
      name: `v ${newId('viw')}`,
      config: configJson({ ...defaultViewConfig('grid'), ...config }),
      position: 9,
      ownerId: null,
    });
    return row.id;
  }

  async function expectSameAsQuery(
    access: RecordAccessContext,
    viewId: Id<'viw'> | null,
    batchSize: number,
  ): Promise<RecordOutput[]> {
    const stream = await service.openStream(
      scope,
      fx.orders.id,
      access,
      { view_id: viewId },
      { maxRows: 1000, batchSize },
    );
    const streamed = await collect(stream);
    const listed = await service.query(scope, fx.orders.id, access, {
      view_id: viewId,
      field_key_type: 'id',
      cell_format: 'text',
      limit: 1000,
    });
    expect(streamed.map((record) => record.id)).toEqual(listed.records.map((record) => record.id));
    expect(streamed).toEqual(listed.records);
    expect(stream.rowCount).toBe(listed.records.length);
    return streamed;
  }

  it('without a view: every readable record by __auto, over many small batches', async () => {
    const records = await expectSameAsQuery(admin, null, 7);
    expect(records).toHaveLength(53);
  });

  it('through a view: group → sort (mixed directions, empty cells, µs instants) as query', async () => {
    const viewId = await view({
      group: [{ field: tags.id, direction: 'desc' }],
      sort: [
        { field: fx.fld.status.id, direction: 'desc' },
        { field: due.id, direction: 'asc' },
        { field: fx.fld.owner.id, direction: 'asc' },
        { field: fx.fld.amount.id, direction: 'desc' },
      ],
    });
    for (const batchSize of [1, 4, 13, 1000]) {
      await expectSameAsQuery(admin, viewId, batchSize);
    }
  });

  it('through a filtered view with the read rule of u_sales1', async () => {
    const viewId = await view({
      filter: { op: 'and', items: [{ field: fx.fld.amount.id, operator: 'is_not_empty' }] },
      sort: [{ field: due.id, direction: 'desc' }],
    });
    const sales1 = accessOf(fx, 'u_sales1');
    const records = await expectSameAsQuery(sales1, viewId, 3);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) expect(record.fields).not.toHaveProperty(fx.fld.cost.id);
  });

  it('columns: readable fields without hidden ones, field_order first, then display order', async () => {
    const viewId = await view({
      hidden_fields: [fx.fld.amount.id],
      field_order: [due.id, fx.fld.cost.id, fx.fld.title.id],
    });
    const asAdmin = await service.openStream(
      scope,
      fx.orders.id,
      admin,
      { view_id: viewId },
      { maxRows: 10 },
    );
    expect(asAdmin.fields.map((field) => field.id)).toEqual([
      due.id,
      fx.fld.cost.id,
      fx.fld.title.id,
      fx.fld.status.id,
      fx.fld.owner.id,
      fx.fld.createdBy.id,
      tags.id,
    ]);
    expect(asAdmin.view?.id).toBe(viewId);
    expect(asAdmin.table.name).toBe('Orders');
    const [first] = await collect(asAdmin);
    expect(Object.keys(first?.fields ?? {})).not.toContain(fx.fld.amount.id);

    const asSales = await service.openStream(
      scope,
      fx.orders.id,
      accessOf(fx, 'u_sales1'),
      { view_id: viewId },
      { maxRows: 10 },
    );
    expect(asSales.fields.map((field) => field.id)).not.toContain(fx.fld.cost.id);
  });

  it('counts up to maxRows + 1 and never yields more than maxRows', async () => {
    const stream = await service.openStream(
      scope,
      fx.orders.id,
      admin,
      {},
      { maxRows: 10, batchSize: 4 },
    );
    expect(stream.rowCount).toBe(11);
    expect(stream.exceedsMaxRows).toBe(true);
    expect(await collect(stream)).toHaveLength(10);

    const exact = await service.openStream(scope, fx.orders.id, admin, {}, { maxRows: 53 });
    expect([exact.rowCount, exact.exceedsMaxRows]).toEqual([53, false]);
  });

  it('checks the view before beforeRead, and beforeRead before counting', async () => {
    const hidden = await view({});
    const sales1 = accessOf(fx, 'u_sales1');
    const orders = sales1.resolved.access.tables[fx.orders.id];
    if (orders === undefined) throw new Error('no Orders access');
    const restricted: RecordAccessContext = {
      ...sales1,
      resolved: {
        ...sales1.resolved,
        access: {
          ...sales1.resolved.access,
          tables: {
            ...sales1.resolved.access.tables,
            [fx.orders.id]: { ...orders, view_rule: { ...orders.view_rule, visible_views: [] } },
          },
        },
      },
    };
    const calls: string[] = [];
    const error = await appError(
      service.openStream(
        scope,
        fx.orders.id,
        restricted,
        { view_id: hidden },
        { maxRows: 10, beforeRead: () => void calls.push('called') },
      ),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect(calls).toEqual([]);

    const denied = await appError(
      service.openStream(
        scope,
        fx.orders.id,
        admin,
        { view_id: hidden },
        {
          maxRows: 10,
          beforeRead: (target) => {
            calls.push(target.view?.id ?? 'none');
            throw new AppError('PERMISSION_DENIED');
          },
        },
      ),
    );
    expect(denied.code).toBe('PERMISSION_DENIED');
    expect(calls).toEqual([hidden]);
  });

  it('an abort cancels the statement in flight (here: waiting for the table lock)', async () => {
    const abort = new AbortController();
    const stream = await service.openStream(
      scope,
      fx.orders.id,
      admin,
      {},
      { maxRows: 1000, batchSize: 5, signal: abort.signal },
    );
    const records = stream.records();
    await records.next();
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `LOCK TABLE data.${pg.escapeIdentifier(fx.orders.db_table_name)} IN ACCESS EXCLUSIVE MODE`,
      );
      const next = records.next();
      const settled = next.then(
        () => 'resolved',
        () => 'rejected',
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = Date.now();
      abort.abort();
      expect(await settled).toBe('rejected');
      // Cancelled while the lock is still held, not after it was released.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(await records.next()).toEqual({ done: true, value: undefined });
  });
});
