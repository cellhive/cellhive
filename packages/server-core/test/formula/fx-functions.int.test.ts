/**
 * `fx.*` SQL functions (migrations 0021 and 0023, BACKLOG T454/T473): all
 * IMMUTABLE and PARALLEL SAFE, independent of session settings and
 * collations (ADR-21), and one bad row never fails a whole `SELECT`/`UPDATE`
 * (SPEC §9.4).
 */
import { foldCase, lowerCase, upperCase } from '@cellhive/formula-engine';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../support/postgres.js';

import {
  compileCase,
  createHarnessTable,
  createTestDb,
  harnessKysely,
  insertCaseRows,
  type AnyKysely,
  type HarnessTable,
} from './harness.js';
import { UNIT_FIELDS } from './unit-fields.js';

import type { FormulaFixtureCase } from './fixture-types.js';
import type { Db } from '../../src/db/index.js';

const ORG = 'org_T454FxFunction01';

/** The functions BACKLOG T454 names, plus the ones the compiler relies on. */
const REQUIRED = [
  'div',
  'value',
  'todate',
  'sqrt',
  'ln',
  'log',
  'year',
  'weekday',
  'weeknum',
  'datedif',
  'workday',
  'networkdays',
  'edate',
  'eomonth',
  'text_date',
  'text_number',
  'format',
  'large',
  'small',
  'stdev',
  'regex_match',
  'regex_extract',
  'regex_replace',
  'fold',
  'fold_all',
  'lower',
  'upper',
];

const rowCase = (name: string, row: Record<string, unknown>): FormulaFixtureCase => ({
  name,
  formula: '1',
  row,
  tz: 'UTC',
  now: '2026-01-01T00:00:00.000Z',
  expected: null,
});

/** Rows with good and bad inputs for the batch tests. */
const ROWS = [
  rowCase('good', { Amount: 4, Qty: 2, Name: '12', Note: '[0-9]+' }),
  rowCase('zero', { Amount: 1, Qty: 0, Name: 'abc', Note: '(' }),
  rowCase('empty', {}),
  rowCase('big', { Amount: 10, Qty: 5000, Name: '1e999', Note: '[' }),
];

describe('fx functions (PostgreSQL 18)', () => {
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
    await insertCaseRows(db, table, ROWS);
  });

  afterAll(async () => {
    await db.destroy();
    await appDb.destroy();
    await database.drop();
  });

  it('are all IMMUTABLE and PARALLEL SAFE', async () => {
    const { rows } = await sql<{ name: string; volatility: string; parallel: string }>`
      SELECT p.proname AS name, p.provolatile AS volatility, p.proparallel AS parallel
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'fx'
    `.execute(db);
    expect(rows.length).toBeGreaterThanOrEqual(50);
    expect(rows.filter((row) => row.volatility !== 'i' || row.parallel !== 's')).toEqual([]);
    const names = new Set(rows.map((row) => row.name));
    expect(REQUIRED.filter((name) => !names.has(name))).toEqual([]);
  });

  it('give the same results whatever TimeZone, DateStyle and lc_time', async () => {
    const probe = sql<{ out: string }>`SELECT to_json(ARRAY[
        fx.year(TIMESTAMPTZ '2026-12-31 20:00:00+00', 'Asia/Ho_Chi_Minh')::text,
        fx.hour(TIMESTAMPTZ '2026-03-08 07:30:00+00', 'America/New_York')::text,
        fx.date_text(fx.local_date(TIMESTAMPTZ '2026-12-31 20:00:00+00', 'Asia/Ho_Chi_Minh')),
        fx.date_text(DATE '2026-02-01'),
        fx.datetime_text(TIMESTAMPTZ '2026-01-01 00:00:00+00', 'Asia/Ho_Chi_Minh'),
        fx.text_date(TIMESTAMP '2026-03-05 01:02:03', 'D/M/YY H:mm:ss YYYY-MM-DD'),
        fx.text_number(1234.5, '#,##0.00'),
        extract(epoch FROM fx.todate('2026-07-01 12:00', 'America/New_York'))::bigint::text,
        extract(epoch FROM fx.date_to_ts(DATE '2026-01-01', 'Asia/Ho_Chi_Minh'))::bigint::text,
        extract(epoch FROM fx.edate(TIMESTAMPTZ '2026-01-15 17:00:00+00', 6, 'America/New_York'))::bigint::text,
        extract(epoch FROM fx.ts_add(TIMESTAMPTZ '2026-03-07 12:00:00+00', 1))::bigint::text,
        fx.weeknum(DATE '2026-12-31', 1)::text,
        fx.datedif(DATE '2000-06-15', DATE '2003-02-10', 'YD')::text,
        fx.text_date(TIMESTAMP '2021-04-09 17:05:03', 'DDDD, D MMMM YYYY hh:mm:ss ddd mmm'),
        fx.text_number(-0.5, '#.#'),
        fx.fold('İSTANBUL ẞ ΣΑΣ Đà Nẵng' COLLATE "tr-x-icu") COLLATE "C",
        array_to_string(fx.fold_all(ARRAY['İ' COLLATE "und-x-icu", NULL, 'ǅ']), ',', '∅') COLLATE "C"
      ])::text AS out`;
    const outputs: string[] = [];
    for (const [timeZone, dateStyle, lcTime] of [
      ['UTC', 'ISO, MDY', 'C'],
      ['Pacific/Kiritimati', 'SQL, DMY', 'en_US.utf8'],
      ['America/Los_Angeles', 'German', 'C'],
    ] as const) {
      await sql`SELECT set_config('TimeZone', ${timeZone}, false),
                       set_config('DateStyle', ${dateStyle}, false),
                       set_config('lc_time', ${lcTime}, false)`.execute(db);
      const { rows } = await probe.execute(db);
      outputs.push(rows[0]?.out ?? '');
    }
    expect(new Set(outputs)).toEqual(new Set([outputs[0]]));
    expect(JSON.parse(outputs[0] ?? '[]')).toEqual([
      '2027',
      '3',
      '2027-01-01',
      '2026-02-01',
      '2026-01-01 07:00:00',
      '5/3/26 1:02:03 2026-03-05',
      '1,234.50',
      '1782921600',
      '1767200400',
      '1784131200',
      '1772971200',
      '53',
      '240',
      'Friday, 9 April 2021 17:05:03 Fri Apr',
      '-.5',
      'istanbul ß σασ đà nẵng',
      'i,∅,ǆ',
    ]);
  });

  it('lower, upper and fold every code point like the TS evaluator (Unicode simple case mappings, T473)', async () => {
    const { rows } = await sql<{ code: number; lower: string; upper: string; folded: string }>`
      SELECT c AS code, fx.lower(chr(c) COLLATE "und-x-icu") AS lower,
             fx.upper(chr(c) COLLATE "tr-x-icu") AS upper, fx.fold(chr(c)) AS folded
        FROM generate_series(1, 1114111) AS c
       WHERE c NOT BETWEEN 55296 AND 57343
    `.execute(db);
    expect(rows).toHaveLength(0x10ffff - 0x800);
    const differing = rows
      .filter((row) => {
        const char = String.fromCodePoint(row.code);
        return (
          lowerCase(char) !== row.lower ||
          upperCase(char) !== row.upper ||
          foldCase(char) !== row.folded
        );
      })
      .map((row) => row.code.toString(16));
    expect(differing).toEqual([]);
    // Whole strings too: no context rule (final sigma) on either side.
    const text = 'ΟΔΟΣ Σ ς İı ßẞ Ǆǅǆ ĐÀ NẴNG đà nẵng Ꭰꭰ';
    const whole = await sql<{ lower: string; upper: string }>`
      SELECT fx.lower(${text}) AS lower, fx.upper(${text}) AS upper
    `.execute(db);
    expect(whole.rows[0]).toEqual({ lower: lowerCase(text), upper: upperCase(text) });
    const version = await sql<{ version: string }>`SELECT unicode_version() AS version`.execute(db);
    // The TS table (case-fold.ts) was generated from Unicode 16.0: regenerate it on change.
    expect(version.rows[0]?.version).toBe('16.0');
  });

  /** A formula compiled against the harness table. */
  const compile = (formula: string) => compileCase(table, { ...rowCase(formula, {}), formula }).sql;

  it('return NULL for a bad row instead of failing the whole SELECT', async () => {
    const { rows } = await sql<{
      id: string;
      ratio: string | null;
      number: string | null;
      match: boolean | null;
    }>`
      SELECT __id AS id,
             ${compile('[Amount] / [Qty]')} AS ratio,
             ${compile('VALUE([Name]) + POWER(10, [Qty])')} AS number,
             ${compile('REGEXMATCH([Name], [Note])')} AS match
        FROM ${sql.id('data', table.tableName)} ORDER BY __id
    `.execute(db);
    expect(rows).toEqual([
      { id: 'rec_0000000000000000', ratio: '2', number: '112', match: true },
      { id: 'rec_0000000000000001', ratio: null, number: null, match: null },
      { id: 'rec_0000000000000002', ratio: null, number: null, match: null },
      { id: 'rec_0000000000000003', ratio: '0.002', number: null, match: null },
    ]);
  });

  it('keep a set-based UPDATE going when some rows fail', async () => {
    const out = table.model.fields.find((field) => field.name === 'Out')?.column as string;
    const result = await sql`
      UPDATE ${sql.id('data', table.tableName)}
         SET ${sql.id(out)} = ${compile('IFERROR([Amount] / [Qty], -1) + SQRT([Amount] - 3) * 0')}
    `.execute(db);
    expect(result.numAffectedRows).toBe(4n);
    const { rows } = await sql<{ out: string | null }>`
      SELECT ${sql.id(out)} AS out FROM ${sql.id('data', table.tableName)} ORDER BY __id
    `.execute(db);
    expect(rows.map((row) => row.out)).toEqual(['2', null, null, '0.002']);
  });

  it('run in parallel workers (error trapping included)', async () => {
    await sql`SELECT set_config('debug_parallel_query', 'on', false)`.execute(db);
    try {
      const { rows } = await sql<{ bad: string }>`
        SELECT count(*) FILTER (WHERE ${compile('ISERROR(REGEXMATCH([Name], [Note]))')}) AS bad
          FROM ${sql.id('data', table.tableName)}
      `.execute(db);
      expect(rows[0]?.bad).toBe('2');
    } finally {
      await sql`SELECT set_config('debug_parallel_query', 'off', false)`.execute(db);
    }
  });
});
