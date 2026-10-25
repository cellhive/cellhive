/**
 * Opt-in bench (BACKLOG T401): `T401_BENCH=1 pnpm --filter
 * @cellhive/server-core test:int test/records/links.bench`.
 *
 * - `records/query` on 200 000 rows with 2 link columns (1–3 links per
 *   cell, 20 000 linked records), limit 200: p95 at the first, middle and
 *   last page (target < 500 ms);
 * - `GET` of a record whose cell holds 500 links: p95 and payload size
 *   (target < 300 ms);
 * - `PATCH` writing 500 links in one cell (target < 1 s).
 *
 * Reports numbers; it never fails on them (SPEC §21 targets, checked by
 * humans). The deterministic part (the plans use the junction indexes) is in
 * `links.int.test.ts`.
 */
import { newId, type Id } from '@cellhive/contracts';
import { LINK_MAX_PER_CELL } from '@cellhive/field-types';
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

import { accessOf, buildOrdersFixture, insertBulk, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ROWS = 200_000;
const TARGETS = 20_000;
const RUNS = 20;
const ORG: Id<'org'> = 'org_T401BenchOrgAAAA';

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(process.env['T401_BENCH'] !== '1')('link fields bench (200k × 2 links)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let fx: OrdersFixture;
  let query: RecordQueryService;
  let mutation: RecordMutationService;
  let rows: TableRow;
  let targets: TableRow;
  const links: FieldRow[] = [];
  const report: string[] = [];
  const scope = orgScope(ORG);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 4 });
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    mutation = new RecordMutationService(db, { schema, query, now: () => NOW });
    fx = await buildOrdersFixture(db, schema, ORG);
    const context = systemAuditContext();
    targets = (
      await schema.createTable(
        scope,
        { baseId: fx.baseId, name: 'Targets', primaryFieldName: 'Tên' },
        context,
      )
    ).table;
    const created = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Rows', primaryFieldName: 'Tên' },
      context,
    );
    rows = created.table;
    for (const name of ['l0', 'l1']) {
      links.push(
        await schema.addField(
          scope,
          rows.id,
          { name, type: 'link', options: { link_table: targets.id, bidirectional: name === 'l1' } },
          context,
        ),
      );
    }
    const targetFields = await pool.query<{ id: Id<'fld'>; type: string }>(
      'SELECT id, type FROM meta.fields WHERE table_id = $1 AND deleted_at IS NULL',
      [targets.id],
    );
    const rowFields = await pool.query<{ id: Id<'fld'>; type: string }>(
      'SELECT id, type FROM meta.fields WHERE table_id = $1 AND deleted_at IS NULL',
      [rows.id],
    );
    fx.schema.tables.push(
      { id: targets.id, fields: targetFields.rows },
      { id: rows.id, fields: rowFields.rows },
    );
    const primaryColumn = async (table: TableRow) =>
      (
        await pool.query<{ db_column_name: string }>(
          'SELECT db_column_name FROM meta.fields WHERE table_id = $1 AND is_primary',
          [table.id],
        )
      ).rows[0]?.db_column_name as string;
    const targetName = await primaryColumn(targets);
    const rowName = await primaryColumn(rows);

    // TEST FIXTURE: rows and junction rows written directly (bench data only).
    await insertBulk(pool, targets, [
      {
        name: targetName,
        pgType: 'text',
        values: Array.from({ length: TARGETS }, (_, i) => `Khách ${String(i)}`),
      },
    ]);
    await insertBulk(pool, rows, [
      {
        name: rowName,
        pgType: 'text',
        values: Array.from({ length: ROWS }, (_, i) => `Dòng ${String(i)}`),
      },
    ]);
    for (const [index, link] of links.entries()) {
      await pool.query(
        `INSERT INTO data.${pg.escapeIdentifier(link.link_junction as string)} (a_id, b_id, position)
         SELECT r.__id, t.__id, g.k
           FROM data.${pg.escapeIdentifier(rows.db_table_name)} AS r
           CROSS JOIN LATERAL generate_series(0, (r.__auto % 3)::int) AS g(k)
           JOIN data.${pg.escapeIdentifier(targets.db_table_name)} AS t
             ON t.__auto = ((r.__auto * 7 + g.k * 13 + $1) % ${String(TARGETS)}) + 1
         ON CONFLICT DO NOTHING`,
        [index],
      );
    }
    await pool.query(`ANALYZE data.${pg.escapeIdentifier(rows.db_table_name)}`);
    await pool.query(`ANALYZE data.${pg.escapeIdentifier(targets.db_table_name)}`);
    for (const link of links) {
      await pool.query(`ANALYZE data.${pg.escapeIdentifier(link.link_junction as string)}`);
    }
  }, 600_000);

  afterAll(async () => {
    process.stdout.write(`\nT401 link bench (p95 of ${String(RUNS)} runs)\n${report.join('\n')}\n`);
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  it('records/query, limit 200, two link columns', async () => {
    const access = accessOf(fx, 'u_admin');
    for (const [label, offset] of [
      ['first', 0],
      ['middle', ROWS / 2],
      ['last', ROWS - 200],
    ] as const) {
      const samples: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const start = performance.now();
        const page = await query.query(scope, rows.id, access, {
          offset,
          limit: 200,
          include_total: run === 0,
        });
        samples.push(performance.now() - start);
        expect(page.records).toHaveLength(200);
      }
      report.push(
        `query ${label} page: p50 ${percentile(samples, 50).toFixed(1)} ms, p95 ${percentile(samples, 95).toFixed(1)} ms`,
      );
    }
  }, 600_000);

  it('PATCH 500 links, then GET the record', async () => {
    const access = accessOf(fx, 'u_admin');
    const ids = (
      await pool.query<{ __id: string }>(
        `SELECT __id FROM data.${pg.escapeIdentifier(targets.db_table_name)} ORDER BY __auto LIMIT ${String(LINK_MAX_PER_CELL)}`,
      )
    ).rows.map((row) => row.__id);
    const record = (
      await pool.query<{ __id: Id<'rec'> }>(
        `SELECT __id FROM data.${pg.escapeIdentifier(rows.db_table_name)} ORDER BY __auto LIMIT 1`,
      )
    ).rows[0]?.__id as Id<'rec'>;
    const requestId = newId('req');
    const start = performance.now();
    await mutation.update(
      scope,
      rows.id,
      access,
      { records: [{ id: record, fields: { l1: ids } }] },
      {
        actor: { type: 'user', id: fx.users.u_admin.id },
        via: null,
        batch_id: requestId,
        request_id: requestId,
        ip: null,
        user_agent: 'bench',
      },
    );
    report.push(`PATCH 500 links (two-way): ${(performance.now() - start).toFixed(1)} ms`);
    const samples: number[] = [];
    let bytes = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const begin = performance.now();
      const out = await query.getRecord(scope, rows.id, record, access);
      samples.push(performance.now() - begin);
      bytes = JSON.stringify(out).length;
      expect(out.fields.l1).toHaveLength(LINK_MAX_PER_CELL);
    }
    report.push(
      `GET record with 500 links: p50 ${percentile(samples, 50).toFixed(1)} ms, p95 ${percentile(samples, 95).toFixed(1)} ms, payload ${String(bytes)} bytes`,
    );
  }, 600_000);
});
