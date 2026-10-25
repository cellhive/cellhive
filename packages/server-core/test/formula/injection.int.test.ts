/**
 * Injection on PostgreSQL (BACKLOG "Quy ước S4b"): a table and a field
 * named with SQL payloads, and literals made of them, keep their meaning —
 * the formula returns the payload text itself and nothing else runs.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../support/postgres.js';

import {
  compileCase,
  createHarnessTable,
  createTestDb,
  harnessKysely,
  insertCaseRows,
  selectValue,
  type AnyKysely,
  type HarnessTable,
} from './harness.js';
import { literal, PAYLOADS, ref } from './payloads.js';

import type { FormulaFixtureCase } from './fixture-types.js';
import type { Db } from '../../src/db/index.js';

const ORG = 'org_T454Injection001';
const FIELD = PAYLOADS[0];

const probe = (formula: string, row: Record<string, unknown> = {}): FormulaFixtureCase => ({
  name: formula,
  formula,
  row,
  tz: 'UTC',
  now: '2026-01-01T00:00:00.000Z',
  expected: null,
});

describe('formula injection (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let appDb: Db;
  let db: AnyKysely;
  let table: HarnessTable;
  let dataTables: () => Promise<number>;

  beforeAll(async () => {
    database = await createTestDatabase();
    appDb = createTestDb(database.url);
    table = await createHarnessTable(
      appDb,
      database,
      ORG,
      {
        fields: [
          { name: 'Title', type: 'text' },
          ...PAYLOADS.map((name) => ({ name, type: 'text' })),
        ],
        cases: [],
      },
      PAYLOADS.join(' '),
    );
    ({ db } = harnessKysely(database.url));
    await insertCaseRows(db, table, [
      probe('row', Object.fromEntries(PAYLOADS.map((p) => [p, p]))),
    ]);
    dataTables = async () => {
      const { rows } = await sql<{ count: string }>`
        SELECT count(*) FROM information_schema.tables WHERE table_schema = 'data'
      `.execute(db);
      return Number(rows[0]?.count);
    };
  });

  afterAll(async () => {
    await db.destroy();
    await appDb.destroy();
    await database.drop();
  });

  it('reads fields named with payloads and returns payload literals verbatim', async () => {
    const before = await dataTables();
    for (const payload of PAYLOADS) {
      const cases: [string, unknown][] = [
        [ref(payload), payload],
        [`${ref(payload)} & ${literal(payload)}`, payload + payload],
        [`IF(${ref(payload)} = ${literal(payload)}, ${literal(payload)}, "no")`, payload],
        [`LEN(${literal(payload)})`, String(Array.from(payload).length)],
        [`SUBSTITUTE(${ref(FIELD)}, ${literal(FIELD)}, ${literal(payload)})`, payload],
        [`REGEXREPLACE(${literal(payload)}, "x^", "y")`, payload],
      ];
      for (const [formula, expected] of cases) {
        const compiled = compileCase(table, probe(formula));
        const text = compiled.sql.compile(db).sql;
        expect(text).not.toContain('DROP');
        expect(text).not.toContain('comment');
        expect(await selectValue(db, table, compiled, 'rec_0000000000000000')).toBe(expected);
      }
    }
    expect(await dataTables()).toBe(before);
    const { rows } = await sql<{ count: string }>`
      SELECT count(*) FROM ${sql.id('data', table.tableName)}
    `.execute(db);
    expect(rows[0]?.count).toBe('1');
  });
});
