/**
 * Opt-in bench (BACKLOG T106; T302 adds views and group counts; T472 the
 * summary bar — 5 summaries over the 200 000 rows, target p95 < 500 ms):
 * `T106_BENCH=1 pnpm --filter @cellhive/server-core test:int
 * test/records/record-query.bench`. 200 000 rows × 30 fields, filter + sort
 * + limit 200, p95 at the first, middle and last page. Reports numbers; it
 * never fails on them (the target is SPEC §21, checked by humans).
 */
import { newId, type Id } from '@cellhive/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { RecordQueryService, type RecordQueryRequest } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { configJson, defaultViewConfig, ViewsRepository } from '../../src/views/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, insertBulk, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ROWS = 200_000;
const RUNS = 20;
const ORG: Id<'org'> = 'org_T106BenchOrgAAAA';

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

const SYLLABLES = ['An', 'Bình', 'Cường', 'Dũng', 'Hà', 'Khánh', 'Linh', 'Minh', 'Phát', 'Thảo'];

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(process.env['T106_BENCH'] !== '1')('RecordQueryService bench (200k × 30)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let fx: OrdersFixture;
  let table: TableRow;
  const fields: Record<string, FieldRow> = {};
  const report: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    // T319: `T106_BENCH_WORK_MEM=32MB` compares a larger sort memory for deep offsets.
    const workMem = process.env['T106_BENCH_WORK_MEM'];
    if (workMem !== undefined && /^\d+(kB|MB)$/u.test(workMem)) {
      const client = new pg.Client({ connectionString: database.url });
      await client.connect();
      const name = (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0]
        ?.db as string;
      await client.query(
        `ALTER DATABASE "${name.replaceAll('"', '""')}" SET work_mem = '${workMem}'`,
      );
      await client.end();
      report.push(`work_mem = ${workMem}`);
    }
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 4 });
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    fx = await buildOrdersFixture(db, schema, ORG);
    const scope = orgScope(ORG);
    const context = systemAuditContext();
    const created = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Bench', primaryFieldName: 'Tên' },
      context,
    );
    table = created.table;
    fields['name'] = created.primaryField;

    const options = ['A', 'B', 'C', 'D', 'E'].map((name) => ({ id: newId('opt'), name }));
    const specs: [string, string, unknown][] = [
      ...Array.from({ length: 9 }, (_, i): [string, string, unknown] => [
        `t${String(i)}`,
        'text',
        {},
      ]),
      ...Array.from({ length: 8 }, (_, i): [string, string, unknown] => [
        `n${String(i)}`,
        'number',
        {},
      ]),
      ...Array.from({ length: 4 }, (_, i): [string, string, unknown] => [
        `s${String(i)}`,
        'select',
        { options },
      ]),
      ...Array.from({ length: 4 }, (_, i): [string, string, unknown] => [
        `d${String(i)}`,
        'datetime',
        { style: { format: i % 2 === 0 ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm' } },
      ]),
      ['c0', 'checkbox', {}],
      ['c1', 'checkbox', {}],
      ['u0', 'user', { multiple: false }],
      ['u1', 'user', {}],
    ];
    for (const [name, type, fieldOptions] of specs) {
      fields[name] = await schema.addField(
        scope,
        table.id,
        { name, type, options: fieldOptions },
        context,
      );
    }
    expect(Object.keys(fields)).toHaveLength(30);

    const random = prng(20260923);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const users = Object.values(fx.users).map((user) => user.id);
    const phrase = () => `${pick(SYLLABLES)} ${pick(SYLLABLES)} ${pick(SYLLABLES)}`;
    const column = (name: string) => fields[name]?.db_column_name as string;
    const columns: { name: string; pgType: string; values: unknown[] }[] = [];
    const add = (name: string, pgType: string, make: (index: number) => unknown) => {
      columns.push({
        name: column(name),
        pgType,
        values: Array.from({ length: ROWS }, (_, i) => make(i)),
      });
    };
    add('name', 'text', (i) => `${phrase()} ${String(i)}`);
    for (let i = 0; i < 9; i += 1)
      add(`t${String(i)}`, 'text', () => (random() < 0.1 ? null : phrase()));
    for (let i = 0; i < 8; i += 1) {
      add(`n${String(i)}`, 'numeric', () =>
        random() < 0.05 ? null : Math.floor(random() * 1_000_000) / 100,
      );
    }
    for (let i = 0; i < 4; i += 1) {
      // A text[] column value per row: arrays of arrays do not unnest, so bind a literal.
      add(`s${String(i)}`, 'text', () => `{${pick(options).id}}`);
    }
    const base = Date.parse('2024-01-01T00:00:00Z');
    for (let i = 0; i < 4; i += 1) {
      add(`d${String(i)}`, i % 2 === 0 ? 'date' : 'timestamptz', () => {
        const at = new Date(base + Math.floor(random() * 1000 * 86_400_000));
        return i % 2 === 0 ? at.toISOString().slice(0, 10) : at.toISOString();
      });
    }
    add('c0', 'boolean', () => random() < 0.5);
    add('c1', 'boolean', () => random() < 0.2);
    add('u0', 'text', () => `{${pick(users)}}`);
    add('u1', 'text', () => `{${pick(users)},${pick(users)}}`);
    // select/user columns are text[]: bind `{…}` literals, cast after unnest.
    const arrayColumns = new Set(['s0', 's1', 's2', 's3', 'u0', 'u1'].map(column));
    await insertBulk(
      pool,
      table,
      columns.map((spec) => (arrayColumns.has(spec.name) ? { ...spec, castTo: 'text[]' } : spec)),
    );
    await pool.query(`ANALYZE data.${pg.escapeIdentifier(table.db_table_name)}`);
    fx.schema.tables.push({
      id: table.id,
      fields: Object.values(fields).map((field) => ({ id: field.id, type: field.type })),
    });
  }, 600_000);

  afterAll(async () => {
    process.stdout.write(
      `\nT106 bench (${String(ROWS)} rows, 30 fields, p95 of ${String(RUNS)} runs)\n${report.join('\n')}\n`,
    );
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  async function measure(label: string, request: RecordQueryRequest) {
    const service = new RecordQueryService(db, { now: () => NOW });
    const access = accessOf(fx, 'u_admin');
    // Exact match count for the offsets, whatever the total_estimate threshold.
    const counter = new RecordQueryService(db, {
      now: () => NOW,
      exactTotalThreshold: Number.MAX_SAFE_INTEGER,
    });
    const first = await counter.query(orgScope(ORG), table.id, access, {
      ...request,
      offset: 0,
      include_total: true,
    });
    const matching =
      'total' in first ? first.total : 'total_estimate' in first ? first.total_estimate : 0;
    const reported = await service.query(orgScope(ORG), table.id, access, request);
    const totalKind =
      'total' in reported ? 'total' : 'total_estimate' in reported ? 'total_estimate' : 'no_total';
    const offsets = {
      first: 0,
      middle: Math.floor(matching / 2),
      last: Math.max(0, matching - (request.limit ?? 200)),
    };
    for (const [where, offset] of Object.entries(offsets)) {
      const samples: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const start = performance.now();
        const page = await service.query(orgScope(ORG), table.id, access, { ...request, offset });
        samples.push(performance.now() - start);
        expect(page.records.length).toBeGreaterThan(0);
      }
      report.push(
        `${label.padEnd(44)} ${where.padEnd(6)} offset=${String(offset).padStart(6)} matching=${String(matching)} ${totalKind} p50=${percentile(samples, 50).toFixed(1)}ms p95=${percentile(samples, 95).toFixed(1)}ms`,
      );
    }
  }

  it('filter + sort by number + limit 200', { timeout: 600_000 }, async () => {
    await measure('n0 >= 1000 AND s0 in (A,B), sort n1 desc', {
      field_key_type: 'name',
      filter: {
        logic: 'and',
        conditions: [
          ['n0', '>=', 1000],
          ['s0', 'intersects', ['A', 'B']],
        ],
      },
      sort: [{ field: 'n1', direction: 'desc' }],
      limit: 200,
    });
  });

  it('filter + sort by text + limit 200', { timeout: 600_000 }, async () => {
    await measure('c0 = true, sort t0 asc', {
      filter: { logic: 'and', conditions: [['c0', '==', true]] },
      sort: [{ field: 't0', direction: 'asc' }],
      limit: 200,
    });
  });

  it('no filter (total_estimate) + sort by date + limit 200', { timeout: 600_000 }, async () => {
    await measure('all rows, sort d1 desc', {
      sort: [{ field: 'd1', direction: 'desc' }],
      limit: 200,
    });
  });

  it('search + limit 200', { timeout: 600_000 }, async () => {
    await measure("search 'cuong phat'", { search: 'cuong phat', limit: 200 });
  });

  /** T302: a saved view with a filter, a sort and two group levels. */
  async function benchView(): Promise<Id<'viw'>> {
    const id = (name: string) => fields[name]?.id as Id<'fld'>;
    const row = await new ViewsRepository(db).insert(orgScope(ORG), {
      id: newId('viw'),
      tableId: table.id,
      type: 'grid',
      name: `Bench ${newId('viw')}`,
      config: configJson({
        ...defaultViewConfig('grid'),
        filter: { op: 'and', items: [{ field: id('n0'), operator: 'gte', value: 1000 }] },
        sort: [{ field: id('n1'), direction: 'desc' }],
        group: [
          { field: id('s0'), direction: 'asc' },
          { field: id('c0'), direction: 'desc' },
        ],
      }),
      position: 1,
      ownerId: null,
    });
    return row.id;
  }

  it(
    'T302: through a view (filter + sort + group 2 levels) + limit 200',
    { timeout: 600_000 },
    async () => {
      const viewId = await benchView();
      await measure('view: n0 >= 1000, group s0,c0, sort n1', { view_id: viewId, limit: 200 });
      // Grid blocks after the first skip the count (FRONTEND §3.3).
      await measure('view, include_total=false', {
        view_id: viewId,
        limit: 200,
        include_total: false,
      });
    },
  );

  it('T302: group counts through the view (2 levels)', { timeout: 600_000 }, async () => {
    const viewId = await benchView();
    const service = new RecordQueryService(db, { now: () => NOW });
    const access = accessOf(fx, 'u_admin');
    const samples: number[] = [];
    let groups = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const start = performance.now();
      const counts = await service.groupCounts(orgScope(ORG), table.id, access, {
        view_id: viewId,
      });
      samples.push(performance.now() - start);
      groups = counts.groups.length;
    }
    expect(groups).toBeGreaterThan(0);
    report.push(
      `${'group-counts: view (n0 >= 1000, group s0,c0)'.padEnd(44)} groups=${String(groups)} p50=${percentile(samples, 50).toFixed(1)}ms p95=${percentile(samples, 95).toFixed(1)}ms`,
    );
  });

  it(
    'T472: summaries (5 functions) over every row, then grouped through the view',
    {
      timeout: 600_000,
    },
    async () => {
      const service = new RecordQueryService(db, { now: () => NOW });
      const access = accessOf(fx, 'u_admin');
      const summaries = {
        n0: 'sum',
        n1: 'avg',
        d0: 'date_range',
        s0: 'unique',
        u1: 'unique',
      } as const;
      const viewId = await benchView();
      for (const [label, request] of [
        ['summaries: 5 over 200k rows', { field_key_type: 'name' as const, summaries }],
        [
          'summaries: 5 through the view (group s0,c0)',
          { field_key_type: 'name' as const, view_id: viewId, summaries },
        ],
      ] as const) {
        const samples: number[] = [];
        let count = 0;
        for (let run = 0; run < RUNS; run += 1) {
          const start = performance.now();
          const result = await service.summaries(orgScope(ORG), table.id, access, request);
          samples.push(performance.now() - start);
          count = result.count;
          expect(Object.keys(result.summaries)).toHaveLength(5);
        }
        report.push(
          `${label.padEnd(44)} matching=${String(count)} p50=${percentile(samples, 50).toFixed(1)}ms p95=${percentile(samples, 95).toFixed(1)}ms`,
        );
      }
    },
  );
});
