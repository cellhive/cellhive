/**
 * Cross-table part of the TS ≡ SQL harness (SPEC §9.4, BACKLOG T455): every
 * case of `cases.ts` compiled by the cross-table compiler, evaluated on its
 * record in a real base (PostgreSQL 18, tables and junctions created by
 * `SchemaService`) and compared with the expected value, with the formula's
 * table aliased and unaliased.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../../support/postgres.js';
import { createTestDb, harnessKysely, sameValue, show, type AnyKysely } from '../harness.js';

import { createCrossBase, type CrossBase } from './base.js';
import { CROSS_CASES } from './cases.js';
import { compileCrossCase, selectCrossValue } from './runner.js';

import type { Db } from '../../../src/db/index.js';

const ORG = 'org_T455Harness00001';

describe('cross-table formula SQL compiler ≡ fixture (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let appDb: Db;
  let db: AnyKysely;
  let base: CrossBase;

  beforeAll(async () => {
    database = await createTestDatabase();
    appDb = createTestDb(database.url);
    ({ db } = harnessKysely(database.url));
    base = await createCrossBase(appDb, database, db, ORG);
  });

  afterAll(async () => {
    await db.destroy();
    await appDb.destroy();
    await database.drop();
  });

  it('covers at least 60 cross-table cases', () => {
    expect(CROSS_CASES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(CROSS_CASES.map((item) => item.name)).size).toBe(CROSS_CASES.length);
    expect(CROSS_CASES.filter((item) => item.scope !== undefined).length).toBeGreaterThanOrEqual(5);
    expect(CROSS_CASES.filter((item) => item.lookup !== undefined).length).toBeGreaterThanOrEqual(
      8,
    );
  });

  for (const alias of ['r', undefined]) {
    it(`gives the expected value for every case (${alias === undefined ? 'no alias' : `alias ${alias}`})`, async () => {
      const failures: string[] = [];
      for (const item of CROSS_CASES) {
        try {
          const compiled = compileCrossCase(base, item, alias);
          const actual = await selectCrossValue(db, base, item, compiled, alias);
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
});
