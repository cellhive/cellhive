/**
 * Record reads racing schema changes (QA S2: `POST /records/query` answered
 * `500 INTERNAL` with `column t.f_… does not exist` while fields were being
 * deleted). A read must see meta and the physical table of the same moment:
 * either from before a concurrent DDL or from after it, never a mix.
 *
 * Each case parks the DDL on its `ACCESS EXCLUSIVE` request behind a lock
 * held by a third connection, starts the read so it queues behind the DDL,
 * then lets the DDL commit. Deterministic: no timing guesses.
 */
import { type Id } from '@cellhive/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { RecordMutationService, RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, insertRows, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ORG: Id<'org'> = 'org_ReadsDuringDdl01';

describe('record reads during concurrent DDL (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let schema: SchemaService;
  let query: RecordQueryService;
  let mutation: RecordMutationService;
  let fx: OrdersFixture;
  const scope = orgScope(ORG);
  let recordIds: Id<'rec'>[];

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url, { poolMax: 8 });
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 4 });
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    mutation = new RecordMutationService(db, { schema, query, now: () => NOW });
    fx = await buildOrdersFixture(db, schema, ORG);
    const col = (field: FieldRow) => field.db_column_name as string;
    recordIds = await insertRows(
      pool,
      fx.orders,
      Array.from({ length: 5 }, (_, index) => ({
        [col(fx.fld.title)]: `Order ${String(index)}`,
        [col(fx.fld.amount)]: String(100 * (index + 1)),
        [col(fx.fld.cost)]: String(index),
      })),
    );
  });

  afterAll(async () => {
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  /** Sessions of the test database waiting on a heavyweight lock. */
  async function lockWaiters(): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    return rows[0]?.n ?? 0;
  }

  async function waitForLockWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while ((await lockWaiters()) < count) {
      if (Date.now() > deadline) throw new Error(`expected ${String(count)} lock waiters`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Runs `ddl` and `read` so that the read starts while the DDL is waiting
   * for its table lock and completes after the DDL committed.
   */
  async function raceWithDdl<T>(
    table: TableRow,
    ddl: () => Promise<unknown>,
    read: () => Promise<T>,
  ): Promise<{ ddl: PromiseSettledResult<unknown>; read: PromiseSettledResult<T> }> {
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `LOCK TABLE data.${pg.escapeIdentifier(table.db_table_name)} IN ACCESS SHARE MODE`,
      );
      const ddlDone = Promise.allSettled([ddl()]);
      await waitForLockWaiters(1);
      const readDone = Promise.allSettled([read()]);
      await waitForLockWaiters(2);
      await holder.query('ROLLBACK');
      const [[ddlResult], [readResult]] = await Promise.all([ddlDone, readDone]);
      return { ddl: ddlResult, read: readResult };
    } finally {
      await holder.end();
    }
  }

  function valueOf<T>(result: PromiseSettledResult<T>): T {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  }

  it('query and getRecord see the table without a field deleted meanwhile', async () => {
    const reader = accessOf(fx, 'u_reader');
    const before = await query.query(scope, fx.orders.id, reader);
    expect(Object.keys(before.records[0]?.fields ?? {})).toContain('cost');

    const raced = await raceWithDdl(
      fx.orders,
      () => schema.deleteField(scope, fx.fld.cost.id, systemAuditContext()),
      () =>
        Promise.all([
          query.query(scope, fx.orders.id, reader),
          query.query(scope, fx.orders.id, reader, { offset: 2, include_total: false }),
          query.getRecord(scope, fx.orders.id, recordIds[0] as Id<'rec'>, reader),
          query.getRecords(scope, fx.orders.id, recordIds, reader),
        ]),
    );
    valueOf(raced.ddl);
    const [page, later, one, many] = valueOf(raced.read);
    expect(page.records).toHaveLength(5);
    expect(later.records).toHaveLength(3);
    for (const record of [...page.records, ...later.records, one, ...many]) {
      expect(record.fields).not.toHaveProperty('cost');
      expect(record.fields).toHaveProperty('amount');
    }
  });

  it('an update racing a field delete writes against the new schema', async () => {
    const editor = accessOf(fx, 'u_admin');
    const raced = await raceWithDdl(
      fx.orders,
      () => schema.deleteField(scope, fx.fld.status.id, systemAuditContext()),
      () =>
        mutation.update(
          scope,
          fx.orders.id,
          editor,
          { records: [{ id: recordIds[1] as Id<'rec'>, fields: { amount: 42 } }] },
          systemAuditContext(),
        ),
    );
    valueOf(raced.ddl);
    const out = valueOf(raced.read);
    expect(out.records[0]?.fields).toMatchObject({ amount: 42 });
    expect(out.records[0]?.fields).not.toHaveProperty('status');
  });

  it('a query racing compaction sees every record of the rebuilt table', async () => {
    const reader = accessOf(fx, 'u_reader');
    const raced = await raceWithDdl(
      fx.orders,
      () => schema.compactTable(scope, fx.orders.id),
      () => query.query(scope, fx.orders.id, reader),
    );
    valueOf(raced.ddl);
    const page = valueOf(raced.read);
    expect(page.records.map((record) => record.id).sort()).toEqual([...recordIds].sort());
    expect('total' in page && page.total).toBe(5);
  });
});
