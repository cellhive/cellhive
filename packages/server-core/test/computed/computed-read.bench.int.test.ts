/**
 * Opt-in bench (BACKLOG T457): `FORMULA_BENCH=1 pnpm --filter
 * @cellhive/server-core test:int test/computed/computed-read.bench`.
 *
 * Orders 200 000 (Amount, Status, Customer → Customers 20 000), reads of
 * 200 records at the first, middle and last page:
 *
 * 1. sort by a **virtual** same-row formula (`TODAY()`), target p95 < 500 ms;
 * 2. filter by a **stored** formula (no index, S4b decision #2), target
 *    p95 < 500 ms;
 * 3. a virtual formula only selected (computed after the page is cut,
 *    S4b open question #11);
 * 4. a lookup `sum` (Customers ← Orders) read by someone with a read rule
 *    on Orders: computed with the reader's scope instead of the stored
 *    column (S4b open question #1b).
 *
 * Reports numbers; never fails on them (checked by humans, BACKLOG S4b
 * "Hiệu năng"). Measured only when the 1-minute load is below 8.
 */
import os from 'node:os';

import { sql } from 'kysely';
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
import { seedTenant } from '../support/tenant.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';
import type { RecordAccessContext, RecordQueryRequest } from '../../src/records/index.js';
import type { Id } from '@cellhive/contracts';

const ORG: Id<'org'> = 'org_T457BenchOrgAAAA';
const CUSTOMERS = 20_000;
const ORDERS = 200_000;
const RUNS = Number(process.env['FORMULA_BENCH_RUNS'] ?? '20');

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(process.env['FORMULA_BENCH'] !== '1')('computed reads bench (200k, T457)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let records: RecordMutationService;
  let query: RecordQueryService;
  let baseId: Id<'bse'>;
  let admin: RecordAccessContext;
  let scoped: RecordAccessContext;
  const tables: Record<string, TableRow> = {};
  const fields: Record<string, FieldRow> = {};
  const report: string[] = [];
  const scope = orgScope(ORG);
  const context = systemAuditContext();

  const line = (text: string) => {
    report.push(text);
    process.stdout.write(`${text}\n`);
  };

  async function addComputed(
    table: string,
    name: string,
    type: 'formula' | 'lookup',
    options: Record<string, unknown>,
  ): Promise<FieldRow> {
    const field = await schema.addField(
      scope,
      (tables[table] as TableRow).id,
      { name, type, options },
      context,
    );
    if (field.compute_mode === 'stored') {
      let cursor = 0n;
      for (;;) {
        const result = await records.backfillComputedBatch(scope, {
          fieldId: field.id,
          afterAuto: cursor,
          limit: 5000,
          statementTimeoutMs: 60_000,
          timeZone: 'UTC',
        });
        if (result.status !== 'more') break;
        cursor = result.cursor;
      }
      await schema.finishComputedBackfill(scope, field.id, { status: 'ready' });
    }
    fields[`${table}.${name}`] = field;
    return field;
  }

  /** p95/p50 of `request` at the first, middle and last page of `total` rows. */
  async function measure(
    name: string,
    table: string,
    access: RecordAccessContext,
    request: RecordQueryRequest,
    total: number,
    target: number | null,
  ): Promise<void> {
    for (const [where, offset] of [
      ['first', 0],
      ['middle', Math.floor(total / 2)],
      ['last', Math.max(0, total - 200)],
    ] as const) {
      const samples: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const started = performance.now();
        const page = await query.query(scope, (tables[table] as TableRow).id, access, {
          ...request,
          limit: 200,
          offset,
          include_total: false,
        });
        samples.push(performance.now() - started);
        expect(page.records.length).toBeGreaterThan(0);
      }
      line(
        `${name} (${where} page): p95 ${percentile(samples, 95).toFixed(0)} ms, ` +
          `p50 ${percentile(samples, 50).toFixed(0)} ms` +
          (target === null ? '' : ` (target < ${String(target)} ms)`),
      );
    }
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url, { poolMax: 8 });
    await migrateAll(database.url, db);
    ({ baseId } = await seedTenant(db, ORG));
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { defaultTimeZone: 'UTC' });
    records = new RecordMutationService(db, { schema, query, defaultTimeZone: 'UTC' });
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

    await addComputed('Orders', 'Commission', 'formula', {
      expression: 'IF([Status] = "Paid", [Amount] * 0.1, 0)',
    });
    await addComputed('Orders', 'Doubled', 'formula', {
      expression: 'IF(TODAY() > DATE(2000, 1, 1), [Amount] * 2, 0)',
    });
    await addComputed('Customers', 'Total', 'lookup', {
      from: (tables['Orders'] as TableRow).id,
      select: (fields['Orders.Amount'] as FieldRow).id,
      where: {
        field: (fields['Orders.Customer'] as FieldRow).id,
        operator: 'intersects',
        value: { field_ref: '__id' },
      },
      aggregate: 'sum',
    });
    await sql`ANALYZE`.execute(db.kysely);

    const perms = (table: string) =>
      Object.fromEntries(
        Object.entries(fields)
          .filter(([key]) => key.startsWith(`${table}.`))
          .map(([, field]) => [field.id, 'read']),
      );
    const tableAccess = (table: string) => ({
      perm: 'read_only' as const,
      operations: [],
      view_rule: { allow_edit: false, visible_views: null },
      read_scope: 'all' as const,
      fields: perms(table),
      option_edit_fields: [],
      file_download_fields: [],
    });
    const orders = (tables['Orders'] as TableRow).id;
    const customers = (tables['Customers'] as TableRow).id;
    const accessWith = (ordersRule: unknown): RecordAccessContext =>
      ({
        baseId,
        resolved: {
          access: {
            role: null,
            is_admin: false,
            base_rule: { copy: true, download: true, share_link: true },
            tables: { [orders]: tableAccess('Orders'), [customers]: tableAccess('Customers') },
            dashboards: {},
          },
          internal: {
            editFilters: { [orders]: null, [customers]: null },
            readFilters: { [orders]: ordersRule, [customers]: null },
          },
        },
        userId: null,
        groupMemberUserIds: [],
        timeZone: 'UTC',
        locale: 'vi',
      }) as unknown as RecordAccessContext;
    admin = accessWith(null);
    // A reader of the orders of status Paid only (a third of them).
    scoped = accessWith({
      field: (fields['Orders.Status'] as FieldRow).id,
      operator: 'is',
      value: 'opt_paid000000000000',
    });
    line(
      `load average at start: ${os
        .loadavg()
        .map((n) => n.toFixed(2))
        .join(' ')}`,
    );
  }, 900_000);

  afterAll(async () => {
    process.stdout.write(`\nT457 computed reads bench\n${report.join('\n')}\n`);
    await db.destroy();
    await database.drop();
  });

  it('sort by a virtual same-row formula', async () => {
    await measure(
      'sort by virtual formula',
      'Orders',
      admin,
      { sort: [{ field: 'Doubled', direction: 'desc' }], fields: ['Ref', 'Doubled'] },
      ORDERS,
      500,
    );
  }, 900_000);

  it('filter by a stored formula', async () => {
    const commission = (fields['Orders.Commission'] as FieldRow).id;
    const filter = { field: commission, operator: 'gt', value: 50 };
    const matching = await query.query(scope, (tables['Orders'] as TableRow).id, admin, {
      filter,
      limit: 1,
    });
    const total =
      'total' in matching
        ? matching.total
        : 'total_estimate' in matching
          ? matching.total_estimate
          : ORDERS / 3;
    await measure(
      'filter by stored formula',
      'Orders',
      admin,
      { filter, fields: ['Ref', 'Commission'] },
      total,
      500,
    );
  }, 900_000);

  it('virtual formula selected only (after the page is cut)', async () => {
    await measure(
      'select virtual formula',
      'Orders',
      admin,
      { fields: ['Ref', 'Doubled'] },
      ORDERS,
      null,
    );
  }, 900_000);

  it('lookup sum read with a read rule on the source table (reader scope)', async () => {
    await measure('lookup sum, stored (admin)', 'Customers', admin, {}, CUSTOMERS, null);
    await measure('lookup sum, reader scope', 'Customers', scoped, {}, CUSTOMERS, null);
  }, 900_000);
});
