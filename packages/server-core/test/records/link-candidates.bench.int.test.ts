/**
 * Opt-in bench (BACKLOG T402): `T402_BENCH=1 pnpm --filter
 * @cellhive/server-core exec vitest run -c vitest.int.config.ts
 * test/records/link-candidates.bench`.
 *
 * The link picker's candidates on a linked table of 200 000 records with
 * Vietnamese names and 30 % "gold" customers: unaccented search (a common
 * needle, a rare one, a 2-character one), limit 50, with and without
 * `record_filter`, first page and a deep page; p95 of 30 runs (target
 * < 300 ms). Reports numbers; it never fails on them (SPEC §21 targets,
 * checked by humans). The deterministic behaviour is in
 * `link-candidates.int.test.ts`.
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

import { accessOf, buildOrdersFixture, insertBulk, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow } from '../../src/db/schema.js';

const ROWS = 200_000;
const RUNS = 30;
const ORG: Id<'org'> = 'org_T402BenchOrgAAAA';

const FAMILY = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng'];
const MIDDLE = ['Văn', 'Thị', 'Minh', 'Ngọc', 'Hữu', 'Thanh', 'Đức', 'Quốc'];
const GIVEN = ['An', 'Bình', 'Châu', 'Dũng', 'Giang', 'Hạnh', 'Khoa', 'Linh', 'Phúc', 'Tường'];

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(process.env['T402_BENCH'] !== '1')('link candidates bench (200k)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let fx: OrdersFixture;
  let query: RecordQueryService;
  let plain: FieldRow;
  let gold: FieldRow;
  const report: string[] = [];
  const scope = orgScope(ORG);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 4 });
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    fx = await buildOrdersFixture(db, schema, ORG);
    const context = systemAuditContext();
    const tierGold = newId('opt');
    const tier = await schema.addField(
      scope,
      fx.customers.id,
      {
        name: 'Hạng',
        type: 'select',
        options: {
          options: [
            { id: tierGold, name: 'Vàng' },
            { id: newId('opt'), name: 'Bạc' },
          ],
        },
      },
      context,
    );
    plain = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'customer', type: 'link', options: { link_table: fx.customers.id } },
      context,
    );
    gold = await schema.addField(
      scope,
      fx.orders.id,
      {
        name: 'gold',
        type: 'link',
        options: {
          link_table: fx.customers.id,
          record_filter: {
            op: 'and',
            items: [{ field: tier.id, operator: 'is', value: tierGold }],
          },
        },
      },
      context,
    );
    for (const field of [tier, plain, gold]) {
      const table = fx.schema.tables.find((candidate) => candidate.id === field.table_id);
      if (table !== undefined) table.fields = [...table.fields, { id: field.id, type: field.type }];
    }
    // TEST FIXTURE: bench rows written directly.
    await insertBulk(pool, fx.customers, [
      {
        name: fx.fld.name.db_column_name as string,
        pgType: 'text',
        values: Array.from(
          { length: ROWS },
          (_, i) =>
            `${FAMILY[i % FAMILY.length] ?? ''} ${MIDDLE[(i * 7) % MIDDLE.length] ?? ''} ` +
            `${GIVEN[(i * 13) % GIVEN.length] ?? ''} ${String(i)}`,
        ),
      },
      {
        name: tier.db_column_name as string,
        pgType: 'text',
        castTo: 'text[]',
        values: Array.from({ length: ROWS }, (_, i) => (i % 10 < 3 ? `{${tierGold}}` : null)),
      },
    ]);
    // `BENCH_AUTO_INDEX=1` (T422): compare with an index on `__auto` (S4 carry-over).
    if (process.env['BENCH_AUTO_INDEX'] === '1') {
      await pool.query(
        `CREATE INDEX ON data.${pg.escapeIdentifier(fx.customers.db_table_name)} (__auto)`,
      );
    }
    await pool.query(`ANALYZE data.${pg.escapeIdentifier(fx.customers.db_table_name)}`);
  }, 600_000);

  afterAll(async () => {
    process.stdout.write(
      `\nT402 link candidates bench (p95 of ${String(RUNS)} runs, limit 50)\n${report.join('\n')}\n`,
    );
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  it('search without accents, with and without record_filter', async () => {
    const access = accessOf(fx, 'u_admin');
    const cases: [string, FieldRow, { search?: string; offset?: number }][] = [
      ['no search, first page', plain, {}],
      ['no search, offset 100 000', plain, { offset: 100_000 }],
      ['"nguyen van" (common)', plain, { search: 'nguyen van' }],
      ['"tuong 1999" (rare)', plain, { search: 'tuong 1999' }],
      ['"an" (2 chars, no trigram)', plain, { search: 'an' }],
      ['record_filter, no search', gold, {}],
      ['record_filter + "nguyen duc"', gold, { search: 'nguyen duc' }],
    ];
    for (const [label, field, request] of cases) {
      const samples: number[] = [];
      let found = 0;
      for (let run = 0; run < RUNS; run += 1) {
        const started = performance.now();
        const out = await query.linkCandidates(scope, field.id, access, { ...request, limit: 50 });
        samples.push(performance.now() - started);
        found = out.items.length;
      }
      expect(found).toBeGreaterThan(0);
      report.push(
        `  ${label.padEnd(30)} p50 ${percentile(samples, 50).toFixed(1)} ms, p95 ${percentile(samples, 95).toFixed(1)} ms (${String(found)} items)`,
      );
    }
  });
});
