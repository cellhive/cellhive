/**
 * TS ≡ SQL equivalence harness (SPEC §9.4, BACKLOG T454): every same-row
 * case of the shared fixture is compiled by the SQL compiler, evaluated on
 * a row of a real data table (created by `SchemaService` on PostgreSQL 18)
 * and compared with the fixture's expected value — the value the TS
 * evaluator (T453) must give too. Replayed under two session settings
 * (ADR-21 §6): the results must not depend on `TimeZone`, `DateStyle`,
 * `lc_time`.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../support/postgres.js';

import { loadFormulaFixture, sameRowCases } from './fixture-source.js';
import {
  compileCase,
  createHarnessTable,
  createTestDb,
  harnessKysely,
  insertCaseRows,
  sameValue,
  selectValue,
  show,
  type AnyKysely,
  type HarnessTable,
} from './harness.js';

import type { Db } from '../../src/db/index.js';
import type pg from 'pg';

const ORG = 'org_T454Harness00001';
const fixture = loadFormulaFixture();
const cases = sameRowCases(fixture);

/** Session settings the results must not depend on. */
const SESSIONS = [
  { name: 'UTC, ISO', timeZone: 'UTC', dateStyle: 'ISO, MDY', lcTime: 'C' },
  {
    name: 'Pacific/Kiritimati (+14), SQL/DMY, en_US lc_time',
    timeZone: 'Pacific/Kiritimati',
    dateStyle: 'SQL, DMY',
    lcTime: 'en_US.utf8',
  },
] as const;

describe('formula SQL compiler ≡ fixture (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let appDb: Db;
  let db: AnyKysely;
  let pool: pg.Pool;
  let table: HarnessTable;
  let ids: Map<string, string>;

  beforeAll(async () => {
    database = await createTestDatabase();
    appDb = createTestDb(database.url);
    table = await createHarnessTable(appDb, database, ORG, fixture);
    ({ db, pool } = harnessKysely(database.url));
    ids = await insertCaseRows(db, table, cases);
  });

  afterAll(async () => {
    await db.destroy();
    await appDb.destroy();
    await database.drop();
  });

  it('covers at least 250 same-row cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(250);
    expect(new Set(cases.map((item) => item.name)).size).toBe(cases.length);
  });

  const results = new Map<string, unknown[]>();

  for (const session of SESSIONS) {
    it(`gives the expected value for every case (${session.name})`, async () => {
      await sql`SELECT set_config('TimeZone', ${session.timeZone}, false),
                       set_config('DateStyle', ${session.dateStyle}, false),
                       set_config('lc_time', ${session.lcTime}, false)`.execute(db);
      const failures: string[] = [];
      for (const item of cases) {
        try {
          const compiled = compileCase(table, item);
          const actual = await selectValue(db, table, compiled, ids.get(item.name) as string);
          const seen = results.get(item.name) ?? [];
          seen.push(show(compiled.type, actual));
          results.set(item.name, seen);
          if (!sameValue(compiled.type, actual, item.expected)) {
            failures.push(
              `${item.name}: expected ${JSON.stringify(item.expected)}, got ${show(compiled.type, actual)}`,
            );
          }
        } catch (error) {
          failures.push(`${item.name}: ${(error as Error).message}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('gives identical results whatever the session settings', () => {
    const differing = [...results].filter(([, values]) => new Set(values).size !== 1);
    expect(differing).toEqual([]);
    expect(pool.totalCount).toBeLessThanOrEqual(1);
  });
});
