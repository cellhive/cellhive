import { setImmediate as nextTurn } from 'node:timers/promises';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';

/** Resolves to `'hung'` when `promise` takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'hung'> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<'hung'>((resolve) => {
    timer = setTimeout(() => {
      resolve('hung');
    }, ms);
  });
  try {
    return await Promise.race([promise, hung]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `Db.destroy()` while queries are in flight (a graceful shutdown with a
 * realtime re-check still running): a connection the pool was still
 * opening must be used and given back, so that closing never waits forever
 * for it.
 */
describe('Db.destroy with queries in flight', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('finishes the queries whose connection was still opening, then closes', async () => {
    const db = createTestDb(database.url);
    await sql`SELECT 1`.execute(db.kysely);
    // The first query takes the idle connection; the others open new ones.
    const queries = [1, 2, 3].map((value) =>
      sql<{ value: number }>`SELECT ${value}::int AS value`.execute(db.kysely),
    );
    await nextTurn();
    const closed = await within(db.destroy(), 10_000);
    expect(closed).not.toBe('hung');
    const results = await Promise.all(queries);
    expect(results.map((result) => result.rows[0]?.value)).toEqual([1, 2, 3]);
    // Closing twice is harmless.
    await db.destroy();
  });

  it('refuses queries started after it was called', async () => {
    const db = createTestDb(database.url);
    await sql`SELECT 1`.execute(db.kysely);
    await db.destroy();
    await expect(sql`SELECT 1`.execute(db.kysely)).rejects.toThrow();
  });
});
