/**
 * Injection through the cross-table compiler (BACKLOG "Quy ước S4b", T455):
 * tables named with SQL payloads, and payload literals in FILTER, LOOKUP and
 * record-title comparisons, keep their meaning — the SQL text holds only
 * placeholders and identifiers from meta, and nothing else runs.
 */
import { analyze } from '@cellhive/formula-engine';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compileCrossAnalysis } from '../../../src/formula/cross/index.js';
import { createTestDatabase, type TestDatabase } from '../../support/postgres.js';
import { createTestDb, harnessKysely, type AnyKysely } from '../harness.js';
import { literal, PAYLOADS, ref } from '../payloads.js';

import { createCrossBase, rid, type CrossBase } from './base.js';
import { crossContext, NOW, TZ } from './runner.js';

import type { Db } from '../../../src/db/index.js';

const ORG = 'org_T455Injection001';
const ORDERS = PAYLOADS[0];
const CUSTOMERS = PAYLOADS[6];

describe('cross-table formula injection (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let appDb: Db;
  let db: AnyKysely;
  let base: CrossBase;

  beforeAll(async () => {
    database = await createTestDatabase();
    appDb = createTestDb(database.url);
    ({ db } = harnessKysely(database.url));
    base = await createCrossBase(appDb, database, db, ORG, {
      Orders: ORDERS,
      Customers: CUSTOMERS,
    });
  });

  afterAll(async () => {
    await db.destroy();
    await appDb.destroy();
    await database.drop();
  });

  it('payload table names and literals are data, not SQL', async () => {
    const tables = async () => {
      const { rows } = await sql<{ count: string }>`
        SELECT count(*) FROM information_schema.tables WHERE table_schema = 'data'
      `.execute(db);
      return Number(rows[0]?.count);
    };
    const before = await tables();
    const snapshot = base.snapshot('Customers');
    const cross = crossContext(base, 'Customers', undefined);
    for (const payload of PAYLOADS) {
      const cases: [string, unknown][] = [
        [`${ref(ORDERS)}.FILTER(CurrentValue.[Ref] = ${literal(payload)}).[Ref].COUNTA()`, '0'],
        [
          `${ref(ORDERS)}.FILTER(CurrentValue.[Customer].CONTAIN(${literal(payload)})).[Ref].COUNTA()`,
          '0',
        ],
        [`LOOKUP(${literal(payload)}, ${ref(ORDERS)}.[Code], ${ref(ORDERS)}.[Ref]).COUNTA()`, '0'],
        [`IF(FIRST([Friends]) = ${literal(payload)}, "yes", ${literal(payload)})`, payload],
        [`${ref(ORDERS)}.MAP(${literal(payload)}).FIRST()`, payload],
        [
          `${ref(CUSTOMERS)}.FILTER(CurrentValue.[Name] = "An").[Name].FIRST() & ${literal(payload)}`,
          `An${payload}`,
        ],
      ];
      for (const [formula, expected] of cases) {
        const analysis = analyze(formula, snapshot, { form: 'display' });
        expect(analysis.errors, formula).toEqual([]);
        const compiled = compileCrossAnalysis(
          analysis,
          { timeZone: TZ, now: NOW, tableAlias: 'r' },
          cross,
        );
        const query = compiled.sql.compile(db);
        expect(query.sql).not.toContain('DROP');
        expect(query.sql).not.toContain('comment');
        expect(query.sql).not.toContain('OR 1=1');
        const { rows } = await sql<{ v: unknown }>`
          SELECT ${compiled.sql} AS v FROM ${sql.id('data', base.tables.Customers.db_table_name)} AS r
           WHERE r.__id = ${rid('c1')}
        `.execute(db);
        expect(rows[0]?.v, formula).toBe(expected);
      }
    }
    expect(await tables()).toBe(before);
  });
});
