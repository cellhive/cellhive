/**
 * Opt-in bench (BACKLOG T405): `T405_BENCH=1 pnpm --filter
 * @cellhive/server-core test:int test/records/tree.bench`.
 *
 * A tree of 200 000 records: 50 000 roots, 3 levels below each root, and
 * one branch 10 levels deep. Measures `records/tree` (limit 200, as the
 * grid reads it) for the first page of roots and for the expansion of one
 * branch, as an admin and as a member with a record rule, plus a filtered
 * roots page (target: p95 < 500 ms).
 *
 * Reports numbers; it never fails on them (SPEC §21 targets, checked by
 * humans). The deterministic checks are in `tree.int.test.ts`.
 */
import { newId, type Id } from '@cellhive/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, NOW, type OrdersFixture } from './fixtures.js';

const ROWS = 200_000;
const ROOTS = 50_000;
const RUNS = 20;
const ORG: Id<'org'> = 'org_T405BenchOrgAAAA';

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(process.env['T405_BENCH'] !== '1')('sub-record tree bench (200k, depth 10)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let fx: OrdersFixture;
  let query: RecordQueryService;
  const report: string[] = [];
  const scope = orgScope(ORG);
  let firstRoot: Id<'rec'>;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 4 });
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    fx = await buildOrdersFixture(db, schema, ORG);
    const parent = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'parent', type: 'parent' },
      systemAuditContext(),
    );
    const table = fx.schema.tables.find((candidate) => candidate.id === fx.orders.id);
    if (table === undefined) throw new Error('no orders');
    table.fields = [...table.fields, { id: parent.id, type: parent.type }];

    // TEST FIXTURE: rows written directly (bench data only). Record i > ROOTS
    // hangs under record i - ROOTS (levels 1–4); the last 9 records form a
    // chain under the first root (levels 2–10).
    const ids = Array.from({ length: ROWS }, () => newId('rec'));
    const parents = ids.map((_, i) => {
      if (i < ROOTS) return null;
      if (i >= ROWS - 9) return i === ROWS - 9 ? (ids[0] as string) : (ids[i - 1] as string);
      return ids[i - ROOTS] as string;
    });
    const sales = [fx.users.u_sales1.id, fx.users.u_sales2.id];
    const name = pg.escapeIdentifier(fx.fld.title.db_column_name as string);
    const ownerColumn = pg.escapeIdentifier(fx.fld.owner.db_column_name as string);
    const ref = `data.${pg.escapeIdentifier(fx.orders.db_table_name)}`;
    for (let start = 0; start < ROWS; start += 10_000) {
      const end = Math.min(ROWS, start + 10_000);
      await pool.query(
        `INSERT INTO ${ref} (__id, ${name}, ${ownerColumn}, __parent_id)
         SELECT u.id, u.name, ARRAY[u.owner], u.parent
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS u(id, name, owner, parent)`,
        [
          ids.slice(start, end),
          ids.slice(start, end).map((_, i) => `Việc ${String(start + i)}`),
          ids.slice(start, end).map((_, i) => sales[(start + i) % 2] as string),
          parents.slice(start, end),
        ],
      );
    }
    // `BENCH_AUTO_INDEX=1` (T422): compare with an index on `__auto` (S4 carry-over).
    if (process.env['BENCH_AUTO_INDEX'] === '1')
      await pool.query(`CREATE INDEX ON ${ref} (__auto)`);
    await pool.query(`ANALYZE ${ref}`);
    firstRoot = ids[0] as Id<'rec'>;
  }, 600_000);

  afterAll(async () => {
    process.stdout.write(`\nT405 tree bench (p95 of ${String(RUNS)} runs)\n${report.join('\n')}\n`);
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  async function measure(label: string, read: (run: number) => Promise<unknown>): Promise<void> {
    const samples: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const start = performance.now();
      await read(run);
      samples.push(performance.now() - start);
    }
    report.push(
      `${label}: p50 ${percentile(samples, 50).toFixed(1)} ms, p95 ${percentile(samples, 95).toFixed(1)} ms`,
    );
  }

  it('first roots page and one branch, as admin and as a member with a record rule', async () => {
    for (const user of ['u_admin', 'u_sales1'] as const) {
      const access = accessOf(fx, user);
      await measure(`${user} roots page (limit 200, with total)`, async () => {
        const page = await query.tree(scope, fx.orders.id, access, { limit: 200 });
        expect(page.records).toHaveLength(200);
      });
      await measure(`${user} expand one branch`, async () => {
        await query.tree(scope, fx.orders.id, access, { parent_id: firstRoot, limit: 200 });
      });
    }
    const filter = {
      op: 'and',
      items: [{ field: fx.fld.title.id, operator: 'contains', value: 'Việc 19999' }],
    };
    await measure('admin filtered roots page (ancestors shown)', async () => {
      await query.tree(scope, fx.orders.id, accessOf(fx, 'u_admin'), { filter, limit: 200 });
    });
  }, 600_000);
});
