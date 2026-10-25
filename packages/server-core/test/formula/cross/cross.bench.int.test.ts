/**
 * Opt-in bench (BACKLOG T455): `FORMULA_BENCH=1 pnpm --filter
 * @cellhive/server-core test:int test/formula/cross/cross.bench`.
 *
 * Customers 20 000 × Orders 200 000 (Orders.Customer ↔ Customers "Orders
 * list", 10 orders per customer; Orders.Items → Products 1 000 →
 * Supplier → Suppliers 50), formulas compiled **virtual** into
 * `SELECT … ORDER BY __auto LIMIT 200 OFFSET x` on Customers, first /
 * middle / last page (the page is cut before the formula is computed), p95
 * of RUNS runs (target < 500 ms each):
 *
 * 1. lookup `sum` of Orders.Amount through the link (`lookupToAst`);
 * 2. `[Orders].FILTER(CurrentValue.[Customer].CONTAIN([Name]) && …).[Amount].SUM()`;
 * 3. FILTER by `field_ref` equality without link (`CurrentValue.[Code] = [Code]`);
 * 4. a 3-link chain `[Orders list].[Items].[Supplier].[Company]`.
 *
 * Reports numbers and the plan (`EXPLAIN ANALYZE` of the first page); it
 * never fails on them (checked by humans, BACKLOG S4b "Hiệu năng"). No index
 * is added (Quyết định S4b #2).
 */
import { analyze } from '@cellhive/formula-engine';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../../src/audit/index.js';
import { orgScope, type Db } from '../../../src/db/index.js';
import {
  compileCrossAnalysis,
  compileLookup,
  loadBaseTables,
  snapshotOfBase,
  type BaseTables,
} from '../../../src/formula/cross/index.js';
import { SchemaService } from '../../../src/schema/index.js';
import { createTestDatabase, migrateAll, type TestDatabase } from '../../support/postgres.js';
import { seedTenant } from '../../support/tenant.js';
import { createTestDb, harnessKysely, type AnyKysely } from '../harness.js';

import type { FieldRow, TableRow } from '../../../src/db/schema.js';
import type { CompiledFormula } from '../../../src/formula/index.js';
import type { Id } from '@cellhive/contracts';

const ORG: Id<'org'> = 'org_T455BenchOrgAAAA';
const CUSTOMERS = 20_000;
const ORDERS = 200_000;
const PRODUCTS = 1_000;
const SUPPLIERS = 50;
const RUNS = Number(process.env['FORMULA_BENCH_RUNS'] ?? '20');
const TZ = 'Asia/Ho_Chi_Minh';

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(process.env['FORMULA_BENCH'] !== '1')('cross-table formula bench (200k)', () => {
  let database: TestDatabase;
  let appDb: Db;
  let db: AnyKysely;
  let models: BaseTables;
  let baseId: Id<'bse'>;
  const tables: Record<string, TableRow> = {};
  const report: string[] = [];
  const scope = orgScope(ORG);

  beforeAll(async () => {
    database = await createTestDatabase();
    appDb = createTestDb(database.url);
    await migrateAll(database.url, appDb);
    ({ db } = harnessKysely(database.url));
    ({ baseId } = await seedTenant(appDb, ORG));
    const schema = new SchemaService(appDb, { maxFieldsPerTable: 500 });
    const context = systemAuditContext();
    const fields: Record<string, FieldRow> = {};
    const table = async (name: string, primary: string) => {
      const created = await schema.createTable(
        scope,
        { baseId, name, primaryFieldName: primary },
        context,
      );
      tables[name] = created.table;
      fields[`${name}.${primary}`] = created.primaryField;
    };
    const add = async (tableName: string, name: string, type: string, options: unknown = {}) => {
      fields[`${tableName}.${name}`] = await schema.addField(
        scope,
        (tables[tableName] as TableRow).id,
        { name, type, options },
        context,
      );
    };
    await table('Suppliers', 'Company');
    await table('Products', 'SKU');
    await table('Customers', 'Name');
    await table('Orders', 'Ref');
    await add('Customers', 'Code', 'text');
    await add('Orders', 'Amount', 'number');
    await add('Orders', 'Code', 'text');
    await add('Orders', 'Status', 'select', {
      options: [
        { id: 'opt_new0000000000000', name: 'New' },
        { id: 'opt_paid000000000000', name: 'Paid' },
      ],
    });
    const link = async (from: string, name: string, to: string, reverse?: string) =>
      add(from, name, 'link', {
        link_table: (tables[to] as TableRow).id,
        ...(reverse === undefined
          ? {}
          : { bidirectional: true, bidirectional_link_field_name: reverse }),
      });
    await link('Products', 'Supplier', 'Suppliers');
    await link('Orders', 'Customer', 'Customers', 'Orders list');
    await link('Orders', 'Items', 'Products');

    const t = (name: string) => sql.id('data', (tables[name] as TableRow).db_table_name);
    const c = (key: string) => sql.id((fields[key] as FieldRow).db_column_name as string);
    const j = (key: string) => sql.id('data', (fields[key] as FieldRow).link_junction as string);
    // TEST FIXTURE: bench data written directly.
    await sql`INSERT INTO ${t('Suppliers')} (__id, ${c('Suppliers.Company')})
      SELECT 'rec_s' || lpad(g::text, 15, '0'), 'Supplier ' || g FROM generate_series(1, ${SUPPLIERS}) g`.execute(
      db,
    );
    await sql`INSERT INTO ${t('Products')} (__id, ${c('Products.SKU')})
      SELECT 'rec_p' || lpad(g::text, 15, '0'), 'SKU ' || g FROM generate_series(1, ${PRODUCTS}) g`.execute(
      db,
    );
    await sql`INSERT INTO ${t('Customers')} (__id, ${c('Customers.Name')}, ${c('Customers.Code')})
      SELECT 'rec_c' || lpad(g::text, 15, '0'), 'Khách ' || g, 'K' || g FROM generate_series(1, ${CUSTOMERS}) g`.execute(
      db,
    );
    await sql`INSERT INTO ${t('Orders')} (__id, ${c('Orders.Ref')}, ${c('Orders.Amount')}, ${c('Orders.Code')}, ${c('Orders.Status')})
      SELECT 'rec_o' || lpad(g::text, 15, '0'), 'Đơn ' || g, (g % 1000)::numeric, 'K' || (g % ${CUSTOMERS} + 1),
             ARRAY[CASE WHEN g % 3 = 0 THEN 'opt_paid000000000000' ELSE 'opt_new0000000000000' END]
        FROM generate_series(1, ${ORDERS}) g`.execute(db);
    await sql`INSERT INTO ${j('Products.Supplier')} (a_id, b_id, position)
      SELECT 'rec_p' || lpad(g::text, 15, '0'), 'rec_s' || lpad((g % ${SUPPLIERS} + 1)::text, 15, '0'), 0
        FROM generate_series(1, ${PRODUCTS}) g`.execute(db);
    await sql`INSERT INTO ${j('Orders.Customer')} (a_id, b_id, position)
      SELECT 'rec_o' || lpad(g::text, 15, '0'), 'rec_c' || lpad((g % ${CUSTOMERS} + 1)::text, 15, '0'), 0
        FROM generate_series(1, ${ORDERS}) g`.execute(db);
    await sql`INSERT INTO ${j('Orders.Items')} (a_id, b_id, position)
      SELECT 'rec_o' || lpad(g::text, 15, '0'), 'rec_p' || lpad((g % ${PRODUCTS} + 1)::text, 15, '0'), 0
        FROM generate_series(1, ${ORDERS}) g`.execute(db);
    for (const name of Object.keys(tables)) await sql`ANALYZE ${t(name)}`.execute(db);
    for (const key of ['Products.Supplier', 'Orders.Customer', 'Orders.Items']) {
      await sql`ANALYZE ${j(key)}`.execute(db);
    }
    models = await loadBaseTables(appDb, scope, baseId);
  }, 900_000);

  afterAll(async () => {
    process.stdout.write(
      `\nT455 cross-table formula bench (p95 of ${String(RUNS)} runs, limit 200, virtual)\n${report.join('\n')}\n`,
    );
    await db.destroy();
    await appDb.destroy();
    await database.drop();
  });

  const customers = () => tables['Customers'] as TableRow;
  const cross = () => ({
    self: models.get(customers().id) as NonNullable<ReturnType<BaseTables['get']>>,
    table: (id: string) => models.get(id) ?? null,
  });
  const formula = (text: string): CompiledFormula => {
    const analysis = analyze(text, snapshotOfBase(models, customers().id), { form: 'display' });
    expect(analysis.errors).toEqual([]);
    return compileCrossAnalysis(analysis, { timeZone: TZ, tableAlias: 'r' }, cross());
  };

  async function measure(label: string, compiled: CompiledFormula): Promise<void> {
    // The page is cut first, then the virtual value computed for its 200 rows only:
    // in `SELECT expr … LIMIT/OFFSET` PostgreSQL would compute it for every skipped row too.
    const page = (offset: number) =>
      sql<{ v: unknown }>`SELECT r.__id, ${compiled.sql} AS v
        FROM (SELECT * FROM ${sql.id('data', customers().db_table_name)} ORDER BY __auto LIMIT 200 OFFSET ${offset}) AS r
        ORDER BY r.__auto`;
    const plan = await sql<{
      'QUERY PLAN': string;
    }>`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON) ${page(0)}`.execute(db);
    const explained = `\n## ${label}\n${plan.rows.map((row) => row['QUERY PLAN']).join('\n')}`;
    report.push(explained);
    process.stdout.write(`${explained}\n`);
    for (const [name, offset] of [
      ['first', 0],
      ['middle', CUSTOMERS / 2],
      ['last', CUSTOMERS - 200],
    ] as const) {
      const samples: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const start = performance.now();
        const { rows } = await page(offset).execute(db);
        samples.push(performance.now() - start);
        expect(rows).toHaveLength(200);
        // Far over target: 3 samples tell enough.
        if (run >= 2 && percentile(samples, 50) > 5_000) break;
      }
      const line = `${label} — ${name} page: p50 ${percentile(samples, 50).toFixed(1)} ms, p95 ${percentile(samples, 95).toFixed(1)} ms (${String(samples.length)} runs)`;
      report.push(line);
      process.stdout.write(`${line}\n`);
    }
  }

  it('1. lookup sum through the link', async () => {
    const orders = models.get((tables['Orders'] as TableRow).id);
    const link = orders?.links.find((item) => item.name === 'Customer');
    const amount = orders?.fields.find((item) => item.name === 'Amount');
    const compiled = compileLookup(
      {
        from: (tables['Orders'] as TableRow).id,
        select: amount?.id as string,
        where: { field: link?.id as string, operator: 'intersects', value: { field_ref: '__id' } },
        aggregate: 'sum',
      },
      snapshotOfBase(models, customers().id),
      { timeZone: TZ, tableAlias: 'r' },
      cross(),
    );
    await measure('lookup sum via link', compiled);
  }, 900_000);

  it('2. FILTER on another table by linked title', async () => {
    await measure(
      '[Orders].FILTER(CurrentValue.[Customer].CONTAIN([Name]) && CurrentValue.[Status] = "Paid").[Amount].SUM()',
      formula(
        '[Orders].FILTER(CurrentValue.[Customer].CONTAIN([Name]) && CurrentValue.[Status] = "Paid").[Amount].SUM()',
      ),
    );
  }, 900_000);

  it('3. FILTER by field_ref equality without link', async () => {
    await measure(
      '[Orders].FILTER(CurrentValue.[Code] = [Code]).[Amount].SUM()',
      formula('[Orders].FILTER(CurrentValue.[Code] = [Code]).[Amount].SUM()'),
    );
  }, 900_000);

  it('4. three-link chain', async () => {
    await measure(
      '[Orders list].[Items].[Supplier].[Company].UNIQUE().ARRAYJOIN()',
      formula('[Orders list].[Items].[Supplier].[Company].UNIQUE().ARRAYJOIN()'),
    );
  }, 900_000);
});
