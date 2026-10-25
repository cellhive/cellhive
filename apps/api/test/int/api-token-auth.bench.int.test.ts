/**
 * Opt-in bench (BACKLOG T704): `AUTH_BENCH=1 pnpm --filter @cellhive/api
 * test:int test/int/api-token-auth.bench`. Measures the same authenticated
 * read (`GET /api/v1/bases/:id`) over the injected HTTP stack with the
 * session cookie and with `Authorization: Bearer cht_…`, and reports the
 * extra p95 cost of Bearer authentication (target ≤ 2 ms). Asserted only
 * when the machine is not loaded (1-minute load < 2 × CPUs, BACKLOG S6
 * "Test").
 */
import { availableParallelism, loadavg } from 'node:os';

import { createdApiTokenSchema } from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type RecordFixture } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';

const ROUNDS = 1_000;
const WARMUP = 100;

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(process.env['AUTH_BENCH'] !== '1')('Bearer vs session authentication bench', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, LOG_LEVEL: 'warn' });
    fx = await buildRecordFixture(t, db);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('adds at most 2 ms p95 over the session cookie', async () => {
    const created = await fx.call('u_editor', 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: 'bench',
      scopes: ['schema:read'],
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const token = createdApiTokenSchema.parse(created.json()).token;
    const cookie = await fx.cookie('u_editor');
    const url = `/api/v1/bases/${fx.baseId}`;
    const session = { cookie };
    const bearer = { authorization: `Bearer ${token}` };

    const run = async (headers: Record<string, string>): Promise<number> => {
      const started = process.hrtime.bigint();
      const response = await t.app.inject({ method: 'GET', url, headers });
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      expect(response.statusCode).toBe(200);
      return elapsed;
    };
    for (let index = 0; index < WARMUP; index += 1) {
      await run(session);
      await run(bearer);
    }
    const samples = { session: [] as number[], bearer: [] as number[] };
    // Interleaved, so both see the same machine state.
    for (let index = 0; index < ROUNDS; index += 1) {
      samples.session.push(await run(session));
      samples.bearer.push(await run(bearer));
    }
    const p50 = {
      session: percentile(samples.session, 50),
      bearer: percentile(samples.bearer, 50),
    };
    const p95 = {
      session: percentile(samples.session, 95),
      bearer: percentile(samples.bearer, 95),
    };
    const extra = p95.bearer - p95.session;
    process.stdout.write(
      `\nT704 auth bench (${String(ROUNDS)} requests each, GET /bases/:id)\n` +
        `  session p50 ${p50.session.toFixed(2)} ms, p95 ${p95.session.toFixed(2)} ms\n` +
        `  bearer  p50 ${p50.bearer.toFixed(2)} ms, p95 ${p95.bearer.toFixed(2)} ms\n` +
        `  extra p95 of Bearer: ${extra.toFixed(2)} ms (target ≤ 2 ms)\n`,
    );
    const [load] = loadavg();
    if ((load ?? 0) < 2 * availableParallelism()) expect(extra).toBeLessThanOrEqual(2);
  }, 600_000);
});
