/**
 * Opt-in bench (BACKLOG T456): `COMPUTED_BENCH=1 pnpm --filter
 * @cellhive/server-core test:int test/computed/computed.bench`.
 *
 * Orders 200 000 (Amount, Status, Customer → Customers 20 000):
 *
 * 1. backfill of the stored formula `IF([Status] = "Paid", [Amount] * 0.1, 0)`
 *    over 200k rows in batches of 5 000 (target < 60 s), while another
 *    client reads Orders pages (grid query, limit 200, random offset): p95
 *    of those reads during the backfill (target < 300 ms);
 *    Then the planner's row estimate of Orders before and after the
 *    `ANALYZE` the jobs run (T471, S4-review §6 #7);
 * 2. backfill of a cross-table lookup `sum` (Customers ← Orders via link);
 * 3. preview p95 (5 rows): same-row formula (target < 300 ms) and the
 *    lookup `sum` (cross-table, target < 1 s).
 *
 * Reports numbers; never fails on them (checked by humans, BACKLOG S4b
 * "Hiệu năng"). Measured only when the 1-minute load is below 8.
 */
import os from 'node:os';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { loadBaseSchemaRows, prepareComputedDefinition } from '../../src/computed/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { RecordMutationService, RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';
import type { RecordAccessContext } from '../../src/records/index.js';
import type { Id } from '@cellhive/contracts';

const ORG: Id<'org'> = 'org_T456BenchOrgAAAA';
const CUSTOMERS = 20_000;
const ORDERS = 200_000;
const RUNS = Number(process.env['COMPUTED_BENCH_RUNS'] ?? '20');

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(process.env['COMPUTED_BENCH'] !== '1')('computed field bench (200k, T456)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let records: RecordMutationService;
  let query: RecordQueryService;
  let baseId: Id<'bse'>;
  let access: RecordAccessContext;
  const tables: Record<string, TableRow> = {};
  const fields: Record<string, FieldRow> = {};
  const report: string[] = [];
  const scope = orgScope(ORG);
  const context = systemAuditContext();

  const line = (text: string) => {
    report.push(text);
    process.stdout.write(`${text}\n`);
  };

  async function backfill(field: FieldRow): Promise<number> {
    const started = performance.now();
    let cursor = 0n;
    for (;;) {
      const result = await records.backfillComputedBatch(scope, {
        fieldId: field.id,
        afterAuto: cursor,
        limit: 5000,
        statementTimeoutMs: 30_000,
        timeZone: 'UTC',
      });
      if (result.status !== 'more' && result.status !== 'done') break;
      cursor = result.cursor;
      if (result.status === 'done') break;
    }
    return performance.now() - started;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url, { poolMax: 8 });
    await migrateAll(database.url, db);
    ({ baseId } = await seedTenant(db, ORG));
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    records = new RecordMutationService(db, { schema, defaultTimeZone: 'UTC' });
    query = new RecordQueryService(db);
    for (const [name, primary] of [
      ['Customers', 'Name'],
      ['Orders', 'Ref'],
    ] as const) {
      const created = await schema.createTable(
        scope,
        { baseId, name, primaryFieldName: primary },
        context,
      );
      tables[name] = created.table;
      fields[`${name}.${primary}`] = created.primaryField;
    }
    const add = async (table: string, name: string, type: string, options: unknown = {}) => {
      fields[`${table}.${name}`] = await schema.addField(
        scope,
        (tables[table] as TableRow).id,
        { name, type, options },
        context,
      );
    };
    await add('Orders', 'Amount', 'number', { style: { type: 'currency', currency_code: 'VND' } });
    await add('Orders', 'Status', 'select', {
      options: [
        { id: 'opt_new0000000000000', name: 'New' },
        { id: 'opt_paid000000000000', name: 'Paid' },
      ],
    });
    await add('Orders', 'Customer', 'link', { link_table: (tables['Customers'] as TableRow).id });
    const t = (name: string) => sql.id('data', (tables[name] as TableRow).db_table_name);
    const c = (key: string) => sql.id((fields[key] as FieldRow).db_column_name as string);
    // TEST FIXTURE: bench data written directly.
    await sql`INSERT INTO ${t('Customers')} (__id, ${c('Customers.Name')})
      SELECT 'rec_c' || lpad(g::text, 15, '0'), 'Khách ' || g FROM generate_series(1, ${CUSTOMERS}) g`.execute(
      db.kysely,
    );
    await sql`INSERT INTO ${t('Orders')} (__id, ${c('Orders.Ref')}, ${c('Orders.Amount')}, ${c('Orders.Status')})
      SELECT 'rec_o' || lpad(g::text, 15, '0'), 'Đơn ' || g, (g % 1000)::numeric,
             ARRAY[CASE WHEN g % 3 = 0 THEN 'opt_paid000000000000' ELSE 'opt_new0000000000000' END]
        FROM generate_series(1, ${ORDERS}) g`.execute(db.kysely);
    const junction = sql.id(
      'data',
      (fields['Orders.Customer'] as FieldRow).link_junction as string,
    );
    await sql`INSERT INTO ${junction} (a_id, b_id, position)
      SELECT 'rec_o' || lpad(g::text, 15, '0'), 'rec_c' || lpad((g % ${CUSTOMERS} + 1)::text, 15, '0'), 0
        FROM generate_series(1, ${ORDERS}) g`.execute(db.kysely);
    await sql`ANALYZE`.execute(db.kysely);

    const perms = (table: string) =>
      Object.fromEntries(
        Object.entries(fields)
          .filter(([key]) => key.startsWith(`${table}.`))
          .map(([, field]) => [field.id, 'edit']),
      );
    const tableAccess = (table: string) => ({
      perm: 'manage' as const,
      operations: ['add' as const, 'delete' as const],
      view_rule: { allow_edit: true, visible_views: null },
      read_scope: 'all' as const,
      fields: perms(table),
      option_edit_fields: [],
      file_download_fields: [],
    });
    const orders = (tables['Orders'] as TableRow).id;
    const customers = (tables['Customers'] as TableRow).id;
    access = {
      baseId,
      resolved: {
        access: {
          role: null,
          is_admin: true,
          base_rule: { copy: true, download: true, share_link: true },
          tables: { [orders]: tableAccess('Orders'), [customers]: tableAccess('Customers') },
          dashboards: {},
        },
        internal: {
          editFilters: { [orders]: null, [customers]: null },
          readFilters: { [orders]: null, [customers]: null },
        },
      },
      userId: null,
      groupMemberUserIds: [],
      timeZone: 'UTC',
      locale: 'vi',
    } as unknown as RecordAccessContext;
    line(
      `load average at start: ${os
        .loadavg()
        .map((n) => n.toFixed(2))
        .join(' ')}`,
    );
  }, 600_000);

  afterAll(async () => {
    process.stdout.write(`\nT456 computed field bench\n${report.join('\n')}\n`);
    await db.destroy();
    await database.drop();
  });

  it('stored formula backfill of 200k rows while the grid reads Orders', async () => {
    const field = await schema.addField(
      scope,
      (tables['Orders'] as TableRow).id,
      {
        name: 'Commission',
        type: 'formula',
        options: { expression: 'IF([Status] = "Paid", [Amount] * 0.1, 0)' },
      },
      context,
    );
    const latencies: number[] = [];
    const state = { running: true };
    const reader = (async () => {
      while (state.running) {
        const offset = Math.floor(Math.random() * (ORDERS - 200));
        const started = performance.now();
        await query.query(scope, (tables['Orders'] as TableRow).id, access, {
          limit: 200,
          offset,
          include_total: false,
        });
        latencies.push(performance.now() - started);
      }
    })();
    const elapsed = await backfill(field);
    state.running = false;
    await reader;
    line(
      `backfill stored formula 200k: ${(elapsed / 1000).toFixed(1)} s (target < 60 s); ` +
        `grid reads during it: n=${String(latencies.length)}, p95 ${percentile(latencies, 95).toFixed(0)} ms ` +
        `(target < 300 ms), p50 ${percentile(latencies, 50).toFixed(0)} ms`,
    );
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM ${sql.id('data', (tables['Orders'] as TableRow).db_table_name)}
       WHERE ${sql.id(field.db_column_name as string)} IS NOT NULL`.execute(db.kysely);
    expect(Number(rows[0]?.n)).toBe(ORDERS);

    // T471: statistics after the backfill — the planner's row estimate of
    // Orders (what `total_estimate` and plans read) before and after the
    // `ANALYZE` the jobs run past 10 000 rows (S4-review §6 #7).
    const orders = sql.id('data', (tables['Orders'] as TableRow).db_table_name);
    const estimate = async (): Promise<number> => {
      const { rows: plan } = await sql<{
        'QUERY PLAN': [{ Plan: { 'Plan Rows': number } }];
      }>`EXPLAIN (FORMAT JSON) SELECT 1 FROM ${orders}`.execute(db.kysely);
      return plan[0]?.['QUERY PLAN'][0].Plan['Plan Rows'] ?? 0;
    };
    const before = await estimate();
    const analyzeStarted = performance.now();
    await schema.analyzeComputedTable(scope, (tables['Orders'] as TableRow).id);
    const analyzeMs = performance.now() - analyzeStarted;
    const after = await estimate();
    line(
      `statistics after the backfill: estimate ${String(before)} rows before ANALYZE, ` +
        `${String(after)} after (actual ${String(ORDERS)}; ANALYZE ${analyzeMs.toFixed(0)} ms)`,
    );
  }, 600_000);

  it('cross-table lookup sum backfill (Customers 20k ← Orders 200k)', async () => {
    const field = await schema.addField(
      scope,
      (tables['Customers'] as TableRow).id,
      {
        name: 'Total',
        type: 'lookup',
        options: {
          from: (tables['Orders'] as TableRow).id,
          select: (fields['Orders.Amount'] as FieldRow).id,
          where: {
            field: (fields['Orders.Customer'] as FieldRow).id,
            operator: 'intersects',
            value: { field_ref: '__id' },
          },
          aggregate: 'sum',
        },
      },
      context,
    );
    const elapsed = await backfill(field);
    line(`backfill lookup sum 20k (over 200k orders): ${(elapsed / 1000).toFixed(1)} s`);
  }, 600_000);

  it('preview p95: same-row formula and cross-table lookup', async () => {
    const rows = await loadBaseSchemaRows(db, scope, baseId);
    const orders = (tables['Orders'] as TableRow).id;
    const customers = (tables['Customers'] as TableRow).id;
    const cases = [
      {
        name: 'same-row formula',
        tableId: orders,
        input: {
          type: 'formula' as const,
          options: { expression: 'IF([Status] = "Paid", [Amount] * 0.1, 0)' },
        },
        target: 300,
      },
      {
        name: 'cross-table lookup sum',
        tableId: customers,
        input: {
          type: 'lookup' as const,
          options: {
            from: orders,
            select: (fields['Orders.Amount'] as FieldRow).id,
            where: {
              field: (fields['Orders.Customer'] as FieldRow).id,
              operator: 'intersects',
              value: { field_ref: '__id' },
            },
            aggregate: 'sum',
          },
        },
        target: 1000,
      },
    ];
    for (const item of cases) {
      const samples: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const started = performance.now();
        const prepared = prepareComputedDefinition(
          { ...item.input, expressionForm: 'display', style: { mode: 'default' } },
          { rows, tableId: item.tableId, timeZone: 'UTC' },
        );
        const values = await query.previewComputed(scope, item.tableId, access, {
          analysis: prepared.analysis,
          limit: 5,
          timeZone: 'UTC',
          timeoutMs: 2000,
        });
        samples.push(performance.now() - started);
        expect(values).toHaveLength(5);
      }
      line(
        `preview ${item.name}: p95 ${percentile(samples, 95).toFixed(0)} ms ` +
          `(target < ${String(item.target)} ms), p50 ${percentile(samples, 50).toFixed(0)} ms`,
      );
    }
  }, 600_000);
});
