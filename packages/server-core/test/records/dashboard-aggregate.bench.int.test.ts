/**
 * Opt-in bench (BACKLOG T806): a dashboard of 5 widgets over 200 000 records,
 * uncached — `S7_BENCH=1 pnpm --filter @cellhive/server-core test:int
 * test/records/dashboard-aggregate.bench`. Reports the wall time of the 5
 * widget queries run together (as a dashboard opens) and of each widget,
 * p50/p95 over the runs. It never fails on the numbers: the target (< 2 s
 * uncached, SPEC §21) is confirmed on the reference runner by the CI perf
 * job (T818).
 */
import { newId, type Id } from '@cellhive/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { RecordQueryService, type WidgetQuery } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import {
  accessOf,
  buildOrdersFixture,
  insertBulk,
  NOW,
  TIME_ZONE,
  type OrdersFixture,
} from './fixtures.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ROWS = 200_000;
const RUNS = 10;
const ORG: Id<'org'> = 'org_T806BenchOrgAAAA';

/** Deterministic PRNG (mulberry32) so runs are comparable. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(process.env['S7_BENCH'] !== '1')('Dashboard widget bench (200k, 5 widgets)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let fx: OrdersFixture;
  let table: TableRow;
  let query: RecordQueryService;
  const fields: Record<string, FieldRow> = {};
  const report: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 4 });
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW, defaultTimeZone: TIME_ZONE });
    fx = await buildOrdersFixture(db, schema, ORG);
    const scope = orgScope(ORG);
    const context = systemAuditContext();
    const created = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Sales', primaryFieldName: 'name' },
      context,
    );
    table = created.table;
    fields['name'] = created.primaryField;
    const statuses = ['New', 'Open', 'Won', 'Lost', 'Hold'].map((name) => ({
      id: newId('opt'),
      name,
    }));
    const tags = Array.from({ length: 30 }, (_, i) => ({
      id: newId('opt'),
      name: `T${String(i)}`,
    }));
    const specs: [string, string, unknown][] = [
      ['region', 'text', {}],
      ['amount', 'number', {}],
      ['status', 'select', { options: statuses }],
      ['tags', 'select', { multiple: true, options: tags }],
      ['at', 'datetime', { style: { format: 'yyyy-MM-dd HH:mm' } }],
      ['owner', 'user', { multiple: false }],
    ];
    for (const [name, type, options] of specs) {
      fields[name] = await schema.addField(scope, table.id, { name, type, options }, context);
    }
    fx.schema.tables.push({
      id: table.id,
      fields: Object.values(fields).map((field) => ({ id: field.id, type: field.type })),
    });

    const random = prng(20261025);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const users = Object.values(fx.users).map((user) => user.id);
    const regions = Array.from({ length: 60 }, (_, i) => `Region ${String(i)}`);
    const column = (name: string) => fields[name]?.db_column_name as string;
    const values = (make: (index: number) => unknown) =>
      Array.from({ length: ROWS }, (_, i) => make(i));
    const base = Date.parse('2024-01-01T00:00:00Z');
    await insertBulk(pool, table, [
      { name: column('name'), pgType: 'text', values: values((i) => `Deal ${String(i)}`) },
      {
        name: column('region'),
        pgType: 'text',
        values: values(() => (random() < 0.05 ? null : pick(regions))),
      },
      {
        name: column('amount'),
        pgType: 'numeric',
        values: values(() => (random() < 0.05 ? null : Math.floor(random() * 1_000_000) / 100)),
      },
      {
        name: column('status'),
        pgType: 'text',
        castTo: 'text[]',
        values: values(() => `{${pick(statuses).id}}`),
      },
      {
        name: column('tags'),
        pgType: 'text',
        castTo: 'text[]',
        values: values(() => `{${pick(tags).id},${pick(tags).id}}`),
      },
      {
        name: column('at'),
        pgType: 'timestamptz',
        values: values(() =>
          new Date(base + Math.floor(random() * 1000 * 86_400_000)).toISOString(),
        ),
      },
      {
        name: column('owner'),
        pgType: 'text',
        castTo: 'text[]',
        values: values(() => `{${pick(users)}}`),
      },
    ]);
    await pool.query(`ANALYZE`);
  }, 600_000);

  afterAll(async () => {
    for (const line of report) process.stdout.write(`${line}\n`);
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  it('5 widgets of a dashboard, uncached', async () => {
    const F = (name: string) => fields[name]?.id as Id<'fld'>;
    const dim = (name: string, dateBucket: 'month' | null = null) => ({
      field: F(name),
      dateBucket,
      bucketWidth: null,
    });
    const grouped = {
      kind: 'grouped' as const,
      tableId: table.id,
      filter: null,
      series: null,
      sort: 'metric_desc' as const,
      limit: 20,
      groupOthers: false,
    };
    const widgets: Record<string, WidgetQuery> = {
      'kpi sum + compare month': {
        kind: 'kpi',
        tableId: table.id,
        filter: null,
        metric: { id: 'm1', aggregation: 'sum', field: F('amount') },
        compare: { dateField: F('at'), period: 'month' },
      },
      'bar status × sum/avg': {
        ...grouped,
        dimension: dim('status'),
        metrics: [
          { id: 'm1', aggregation: 'sum', field: F('amount') },
          { id: 'm2', aggregation: 'avg', field: F('amount') },
        ],
      },
      'line month × status series': {
        ...grouped,
        dimension: dim('at', 'month'),
        series: dim('status'),
        metrics: [{ id: 'm1', aggregation: 'count', field: null }],
        sort: 'dimension_asc',
        limit: 50,
      },
      'pie multi-select top 10 + Other': {
        ...grouped,
        dimension: dim('tags'),
        metrics: [{ id: 'm1', aggregation: 'count', field: null }],
        limit: 10,
        groupOthers: true,
      },
      'table region × count_distinct owner': {
        ...grouped,
        dimension: dim('region'),
        metrics: [
          { id: 'm1', aggregation: 'count', field: null },
          { id: 'm2', aggregation: 'count_distinct', field: F('owner') },
        ],
        limit: 50,
      },
    };
    const access = accessOf(fx, 'u_admin');
    const scope = orgScope(ORG);
    const runOne = async (widget: WidgetQuery) => {
      const started = performance.now();
      const result = await query.widgetData(scope, access, widget, { timeZone: TIME_ZONE });
      expect(result.status).toBe('ok');
      return performance.now() - started;
    };
    // Warm-up (plans, catalog caches), not measured.
    await Promise.all(Object.values(widgets).map(runOne));

    const dashboard: number[] = [];
    const each = new Map<string, number[]>(Object.keys(widgets).map((name) => [name, []]));
    for (let run = 0; run < RUNS; run += 1) {
      const started = performance.now();
      const times = await Promise.all(Object.values(widgets).map(runOne));
      dashboard.push(performance.now() - started);
      Object.keys(widgets).forEach((name, index) => each.get(name)?.push(times[index] as number));
    }
    const ms = (value: number) => `${value.toFixed(0)} ms`;
    report.push(
      `T806 bench: ${String(ROWS)} records, ${String(RUNS)} runs, 5 widgets in parallel`,
      `  dashboard: p50 ${ms(percentile(dashboard, 50))}, p95 ${ms(percentile(dashboard, 95))}`,
      ...[...each].map(
        ([name, samples]) =>
          `  ${name}: p50 ${ms(percentile(samples, 50))}, p95 ${ms(percentile(samples, 95))}`,
      ),
    );
  }, 600_000);
});
