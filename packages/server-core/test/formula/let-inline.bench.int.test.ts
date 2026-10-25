/**
 * Opt-in bench (BACKLOG T454): `FORMULA_BENCH=1 pnpm --filter
 * @cellhive/server-core test:int test/formula/let-inline.bench`.
 *
 * `LET` is inlined: each use of a variable repeats the SQL of its value.
 * Measures, on 200 000 rows, a formula whose variable is used once against
 * the same formula using it four times, and a same-row formula
 * (`IF([Status] = "Xong", [Amount] * 0.1, 0)`) as a `SELECT` and as a
 * set-based `UPDATE`. Reports numbers; it never fails on them.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../support/postgres.js';

import {
  compileCase,
  createHarnessTable,
  createTestDb,
  harnessKysely,
  type AnyKysely,
  type HarnessTable,
} from './harness.js';
import { STATUS_OPTIONS, UNIT_FIELDS } from './unit-fields.js';

import type { Db } from '../../src/db/index.js';

const ORG = 'org_T454LetBench0001';
const ROWS = 200_000;

describe.skipIf(process.env['FORMULA_BENCH'] !== '1')('formula SQL bench (200k rows)', () => {
  let database: TestDatabase;
  let appDb: Db;
  let db: AnyKysely;
  let table: HarnessTable;

  beforeAll(async () => {
    database = await createTestDatabase();
    appDb = createTestDb(database.url);
    table = await createHarnessTable(appDb, database, ORG, {
      fields: [...UNIT_FIELDS, { name: 'Out', type: 'number' }],
      cases: [],
    });
    ({ db } = harnessKysely(database.url));
    const column = (name: string) =>
      sql.id(table.model.fields.find((field) => field.name === name)?.column as string);
    await sql`
      INSERT INTO ${sql.id('data', table.tableName)} (__id, ${column('Name')}, ${column('Amount')}, ${column('Status')})
      SELECT 'rec_' || lpad(g::text, 16, '0'), 'Nguyễn Văn ' || g, g * 1000,
             ARRAY[(${sql.val(STATUS_OPTIONS.map((option) => option.id))}::text[])[1 + g % 3]]
        FROM generate_series(1, ${ROWS}) AS g
    `.execute(db);
    await sql`ANALYZE ${sql.id('data', table.tableName)}`.execute(db);
  }, 600_000);

  afterAll(async () => {
    await db.destroy();
    await appDb.destroy();
    await database.drop();
  });

  async function timeSelect(formula: string): Promise<number> {
    const compiled = compileCase(table, {
      name: formula,
      formula,
      tz: 'Asia/Ho_Chi_Minh',
      now: '2026-01-01T00:00:00.000Z',
      expected: null,
    }).sql;
    const times: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      await sql`SELECT count(${compiled}) FROM ${sql.id('data', table.tableName)}`.execute(db);
      times.push(performance.now() - started);
    }
    return Math.min(...times);
  }

  it('reports LET inlining and same-row costs', async () => {
    const heavy = 'REGEXREPLACE(UPPER(UNACCENT([Name])), "[0-9]", "#")';
    const once = await timeSelect(`LET(x, ${heavy}, LEN(x))`);
    const four = await timeSelect(`LET(x, ${heavy}, LEN(x & x & x & x))`);
    const plain = await timeSelect('IF([Status] = "Xong", [Amount] * 0.1, 0)');
    const out = table.model.fields.find((field) => field.name === 'Out')?.column as string;
    const compiled = compileCase(table, {
      name: 'update',
      formula: 'IF([Status] = "Xong", [Amount] * 0.1, 0)',
      tz: 'UTC',
      now: '2026-01-01T00:00:00.000Z',
      expected: null,
    }).sql;
    const started = performance.now();
    await sql`UPDATE ${sql.id('data', table.tableName)} SET ${sql.id(out)} = ${compiled}`.execute(
      db,
    );
    const update = performance.now() - started;
    process.stdout.write(
      `[T454 bench] ${String(ROWS)} rows: LET used once ${once.toFixed(0)} ms, four times ${four.toFixed(0)} ms; ` +
        `IF/select SELECT ${plain.toFixed(0)} ms, UPDATE ${update.toFixed(0)} ms\n`,
    );
    expect(four).toBeGreaterThan(0);
  }, 600_000);
});
