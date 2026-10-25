/**
 * Opt-in bench (BACKLOG T464): `SEED_BENCH=1 pnpm --filter @cellhive/api
 * test:int test/int/seed-bench.bench` runs the whole `pnpm seed:bench`
 * (200 000 rows, 20 000 customers, the computed fields) on its own
 * Testcontainers database and reports the insert and backfill times
 * (targets: backfill of a stored field on 200 000 rows < 60 s, S4b
 * milestone). Checks that every computed field ends `ready`; never fails on
 * the numbers. `SEED_BENCH_ROWS` overrides the row count. The deterministic
 * checks live in `seed-tables.int.test.ts`.
 */
import os from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedBench } from '../../src/seed/bench-seed.js';
import { BENCH_ROWS } from '../../src/seed/bench-table.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { startTestApp, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';

const ROWS = Number(process.env['SEED_BENCH_ROWS'] ?? String(BENCH_ROWS));

describe.skipIf(process.env['SEED_BENCH'] !== '1')('seed:bench with computed fields (T464)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, LOG_LEVEL: 'warn' });
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('seeds the rows and backfills every computed field', async () => {
    const load = os.loadavg()[0] ?? 0;
    const started = Date.now();
    const result = await seedBench(t.app, { rows: ROWS });
    const totalMs = Date.now() - started;
    expect(result.created).toBe(true);
    expect(result.computed.every((field) => field.compute_state === 'ready')).toBe(true);
    const lines = [
      `seed:bench (${String(ROWS)} rows, ${String(result.customers?.rows ?? 0)} customers, load ${load.toFixed(1)}):`,
      `  insert   ${(result.insertMs / 1000).toFixed(1)} s`,
      `  computed ${(result.computedMs / 1000).toFixed(1)} s (${result.computed.map((field) => `${field.name}: ${field.compute_mode ?? '?'}`).join(', ')})`,
      `  total    ${(totalMs / 1000).toFixed(1)} s`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }, 3_600_000);
});
