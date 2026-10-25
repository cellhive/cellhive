/**
 * Opt-in bench (BACKLOG T423): `T423_BENCH=1 pnpm --filter
 * @cellhive/server-core test:int test/records/two-way-links.bench`.
 * `T423_PROFILE=1` also prints the time spent per SQL statement shape.
 *
 * - bulk create of 10 000 order lines linked (two-way) to 5 000 distinct
 *   orders, 1 000 records per call like `pnpm seed:demo` (target < 5 s);
 * - `PATCH` of one cell with 500 two-way links (target < 500 ms);
 * - an import of 10 000 rows with a two-way link column given as titles
 *   (`typecast` + `importCells`, 1 000 rows per call like `runTableImport`;
 *   target < 30 s).
 *
 * The service runs with an active publisher (realtime images and titles are
 * computed, as in the api). Reports numbers; it never fails on them.
 */
import { newId, type Id } from '@cellhive/contracts';
import { LINK_MAX_PER_CELL } from '@cellhive/field-types';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { RecordMutationService, RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, insertBulk, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';
import type { RecordChange } from '../../src/records/index.js';

const ORDERS = 5_000;
const LINES = 10_000;
const BATCH = 1_000;
const ORG: Id<'org'> = 'org_T423BenchOrgAAAA';
const PROFILE = process.env['T423_PROFILE'] === '1';

/** Time per SQL statement shape (pg client level), for `T423_PROFILE=1`. */
const profile = new Map<string, { calls: number; ms: number }>();
let profiling = false;

function installProfiler(): void {
  const proto = pg.Client.prototype as unknown as {
    query: (...args: unknown[]) => unknown;
  };
  const original = proto.query;
  proto.query = function (this: unknown, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : '';
    const start = performance.now();
    const out = original.apply(this, args);
    if (profiling && text !== '' && out instanceof Promise) {
      void out.finally(() => {
        const key = text.replace(/\s+/g, ' ').slice(0, 140);
        const entry = profile.get(key) ?? { calls: 0, ms: 0 };
        entry.calls += 1;
        entry.ms += performance.now() - start;
        profile.set(key, entry);
      });
    }
    return out;
  };
}

function dumpProfile(label: string): string {
  const rows = [...profile.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25);
  const total = [...profile.values()].reduce((sum, entry) => sum + entry.ms, 0);
  const calls = [...profile.values()].reduce((sum, entry) => sum + entry.calls, 0);
  profile.clear();
  return [
    `  profile ${label}: ${String(calls)} statements, ${total.toFixed(0)} ms in SQL`,
    ...rows.map(
      ([key, entry]) =>
        `    ${entry.ms.toFixed(0).padStart(7)} ms ${String(entry.calls).padStart(6)}× ${key}`,
    ),
  ].join('\n');
}

describe.skipIf(process.env['T423_BENCH'] !== '1')('two-way link writes bench (T423)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let fx: OrdersFixture;
  let mutation: RecordMutationService;
  let lines: TableRow;
  let link: FieldRow;
  let orderIds: Id<'rec'>[] = [];
  let published = 0;
  const report: string[] = [];
  const scope = orgScope(ORG);

  const audit = (label: string): AuditContext => {
    const id = newId('req');
    return {
      actor: { type: 'user', id: fx.users.u_admin.id },
      via: null,
      batch_id: id,
      request_id: id,
      ip: null,
      user_agent: label,
    };
  };

  beforeAll(async () => {
    if (PROFILE) installProfiler();
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 2 });
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const query = new RecordQueryService(db, { now: () => NOW });
    mutation = new RecordMutationService(db, {
      schema,
      query,
      now: () => NOW,
      publisher: {
        publish: (changes: readonly RecordChange[]) => {
          published += changes.length;
        },
      },
    });
    fx = await buildOrdersFixture(db, schema, ORG);
    const context = systemAuditContext();
    lines = (
      await schema.createTable(
        scope,
        { baseId: fx.baseId, name: 'Lines', primaryFieldName: 'Sản phẩm' },
        context,
      )
    ).table;
    const quantity = await schema.addField(
      scope,
      lines.id,
      { name: 'qty', type: 'number', options: {} },
      context,
    );
    link = await schema.addField(
      scope,
      lines.id,
      { name: 'order', type: 'link', options: { link_table: fx.orders.id, bidirectional: true } },
      context,
    );
    const lineFields = await pool.query<{ id: Id<'fld'>; type: string }>(
      'SELECT id, type FROM meta.fields WHERE table_id = $1 AND deleted_at IS NULL',
      [lines.id],
    );
    const orderFields = await pool.query<{ id: Id<'fld'>; type: string }>(
      'SELECT id, type FROM meta.fields WHERE table_id = $1 AND deleted_at IS NULL',
      [fx.orders.id],
    );
    const ordersMeta = fx.schema.tables.find((table) => table.id === fx.orders.id);
    if (ordersMeta !== undefined) ordersMeta.fields = orderFields.rows;
    fx.schema.tables.push({ id: lines.id, fields: lineFields.rows });
    expect(quantity.type).toBe('number');

    // TEST FIXTURE: orders written directly (bench data only).
    await insertBulk(pool, fx.orders, [
      {
        name: fx.fld.title.db_column_name as string,
        pgType: 'text',
        values: Array.from({ length: ORDERS }, (_, i) => `ĐH-${String(i + 1).padStart(5, '0')}`),
      },
    ]);
    orderIds = (
      await pool.query<{ __id: Id<'rec'> }>(
        `SELECT __id FROM data.${pg.escapeIdentifier(fx.orders.db_table_name)} ORDER BY __auto`,
      )
    ).rows.map((row) => row.__id);
    await pool.query(`ANALYZE data.${pg.escapeIdentifier(fx.orders.db_table_name)}`);
  }, 600_000);

  afterAll(async () => {
    process.stdout.write(`\nT423 two-way link bench\n${report.join('\n')}\n`);
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  it(`creates ${String(LINES)} lines linked to ${String(ORDERS)} distinct orders`, async () => {
    const access = accessOf(fx, 'u_admin');
    profiling = PROFILE;
    const start = performance.now();
    const perCall: number[] = [];
    for (let from = 0; from < LINES; from += BATCH) {
      const begin = performance.now();
      await mutation.create(
        scope,
        lines.id,
        access,
        {
          field_key_type: 'name',
          records: Array.from({ length: BATCH }, (_, k) => {
            const i = from + k;
            // Two lines per order, spread so every call touches 1 000 distinct orders.
            return {
              fields: {
                'Sản phẩm': `Dòng ${String(i)}`,
                qty: (i % 10) + 1,
                order: [orderIds[i % ORDERS]],
              },
            };
          }),
        },
        audit('bench-create'),
        { readBack: false },
      );
      perCall.push(performance.now() - begin);
    }
    const total = performance.now() - start;
    profiling = false;
    report.push(
      `bulk create ${String(LINES)} lines → ${String(ORDERS)} orders (two-way): ${total.toFixed(0)} ms ` +
        `(per 1 000-record call: min ${Math.min(...perCall).toFixed(0)} ms, max ${Math.max(...perCall).toFixed(0)} ms)`,
    );
    if (PROFILE) report.push(dumpProfile('bulk create'));
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM data.${pg.escapeIdentifier(link.link_junction as string)}`,
    );
    expect(Number(rows[0]?.n)).toBe(LINES);
    expect(published).toBeGreaterThan(0);
  }, 600_000);

  it('PATCH one cell with 500 two-way links', async () => {
    const access = accessOf(fx, 'u_admin');
    const created = await mutation.create(
      scope,
      lines.id,
      access,
      { field_key_type: 'name', records: [{ fields: { 'Sản phẩm': 'Dòng 500' } }] },
      audit('bench-patch'),
    );
    const id = created.records[0]?.id as Id<'rec'>;
    const targets = orderIds.slice(0, LINK_MAX_PER_CELL);
    profiling = PROFILE;
    const start = performance.now();
    await mutation.update(
      scope,
      lines.id,
      access,
      { field_key_type: 'name', records: [{ id, fields: { order: targets } }] },
      audit('bench-patch'),
    );
    const elapsed = performance.now() - start;
    profiling = false;
    report.push(`PATCH 500 links (two-way): ${elapsed.toFixed(1)} ms`);
    if (PROFILE) report.push(dumpProfile('PATCH 500'));
  }, 600_000);

  it(`imports ${String(LINES)} rows with a two-way link column (titles)`, async () => {
    const access = accessOf(fx, 'u_admin');
    const fieldId = link.id;
    const primary = (
      await pool.query<{ id: Id<'fld'> }>(
        'SELECT id FROM meta.fields WHERE table_id = $1 AND is_primary',
        [lines.id],
      )
    ).rows[0]?.id as Id<'fld'>;
    profiling = PROFILE;
    const start = performance.now();
    for (let from = 0; from < LINES; from += BATCH) {
      await mutation.create(
        scope,
        lines.id,
        access,
        {
          field_key_type: 'id',
          typecast: true,
          records: Array.from({ length: BATCH }, (_, k) => {
            const i = from + k;
            return {
              fields: {
                [primary]: `Nhập ${String(i)}`,
                [fieldId]: `ĐH-${String((i % ORDERS) + 1).padStart(5, '0')}`,
              },
            };
          }),
        },
        audit('bench-import'),
        { readBack: false, importCells: true },
      );
    }
    const elapsed = performance.now() - start;
    profiling = false;
    report.push(
      `import ${String(LINES)} rows with a two-way link column: ${elapsed.toFixed(0)} ms`,
    );
    if (PROFILE) report.push(dumpProfile('import'));
  }, 600_000);
});
