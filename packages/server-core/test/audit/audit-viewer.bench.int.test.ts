/**
 * Opt-in bench (BACKLOG T709): `AUDIT_BENCH=1 pnpm --filter
 * @cellhive/server-core test:int test/audit/audit-viewer.bench`.
 *
 * The audit viewer (`AuditLogsRepository.list`, CONTRACTS §11.4) on
 * 1 000 000 entries of 3 organizations (500 000 / 300 000 / 200 000) over
 * 13 monthly partitions (`AUDIT_BENCH_ROWS` to change the volume), plus
 * 100 000 entries written before and after the migration (write cost):
 *
 * 1. migrates to 0051, writes the volume, then times migration 0052
 *    (`audit_logs_actor_idx` + `audit_logs_action_idx` on the partitioned
 *    parent) — the Upgrade notes number;
 * 2. measures p50/p95 of the first page without filter, `actor_id` and
 *    `action` over the last 7 days, and a few other shapes, on the largest
 *    organization.
 *
 * Targets (BACKLOG T709): first page p95 < 100 ms, `actor_id` / `action`
 * over 7 days p95 < 300 ms. Asserted only when the 1-minute load is below
 * twice the CPU count (S6 test rule); always reported.
 */
import os from 'node:os';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLogsRepository, type AuditLogFilter } from '../../src/audit/index.js';
import { createMigrator, decodeCursor, orgScope, type Db } from '../../src/db/index.js';
import { migrateJobQueue } from '../../src/jobs/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

import { actorOf, createPartitions, insertAuditVolume } from './audit-volume.js';

import type { Id } from '@cellhive/contracts';

const ROWS = Number(process.env['AUDIT_BENCH_ROWS'] ?? '1000000');
const ORGS: readonly (readonly [Id<'org'>, number])[] = [
  ['org_T709AuditBenchA1', 0.5],
  ['org_T709AuditBenchB1', 0.3],
  ['org_T709AuditBenchC1', 0.2],
];
const ACTORS = 50;
const DAYS = 330;
const SAMPLES = 100;
const INSERTS = 100_000;
const load = () => os.loadavg()[0] ?? 0;
const LOAD_LIMIT = 2 * os.cpus().length;

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(process.env['AUDIT_BENCH'] !== '1')('audit viewer bench (T709)', () => {
  let database: TestDatabase;
  let db: Db;
  let repo: AuditLogsRepository;
  const report: string[] = [];
  const results = new Map<string, { p50: number; p95: number }>();
  const [org] = ORGS[0] as readonly [Id<'org'>, number];
  const scope = orgScope(org);
  const weekAgo = () => new Date(Date.now() - 7 * 86_400_000);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url, { statementTimeoutMs: 0 });
    await migrateJobQueue({ connectionString: database.url });
    const migrator = createMigrator(db.kysely);
    const before = await migrator.migrateTo('0051_secrets_allowed_hosts');
    if (before.error !== undefined)
      throw new Error('migrate to 0051 failed', { cause: before.error });
    // 13 partitions: 11 months back through next month.
    await createPartitions(db, 11);
    const started = performance.now();
    for (const [orgId, share] of ORGS) {
      const tenant = await seedTenant(db, orgId);
      await insertAuditVolume(db, {
        orgId,
        count: Math.round(ROWS * share),
        actors: ACTORS,
        days: DAYS,
        baseIds: [tenant.baseId, `bse_${orgId.slice(4, 18)}Z9`],
      });
    }
    report.push(`write ${String(ROWS)} entries: ${(performance.now() - started).toFixed(0)} ms`);
    const { rows: partitions } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'meta.audit_logs'::regclass
    `.execute(db.kysely);
    report.push(`partitions: ${String(partitions[0]?.n)}`);

    // Write cost of the two indexes: the same 100 000 extra entries before and after.
    const extra = async (orgId: Id<'org'>) => {
      const insertStarted = performance.now();
      await insertAuditVolume(db, {
        orgId,
        count: INSERTS,
        actors: ACTORS,
        days: 1,
        baseIds: ['bse_T709AuditBenchX1', 'bse_T709AuditBenchX2'],
      });
      return performance.now() - insertStarted;
    };
    await seedTenant(db, 'org_T709AuditBenchX1');
    await seedTenant(db, 'org_T709AuditBenchX2');
    const insertBefore = await extra('org_T709AuditBenchX1');

    const indexStarted = performance.now();
    const after = await migrator.migrateToLatest();
    if (after.error !== undefined) throw new Error('migration 0052 failed', { cause: after.error });
    const indexMs = performance.now() - indexStarted;
    const insertAfter = await extra('org_T709AuditBenchX2');
    report.push(
      `insert ${String(INSERTS)} entries: ${insertBefore.toFixed(0)} ms without the indexes, ` +
        `${insertAfter.toFixed(0)} ms with them`,
    );
    report.push(
      `migration 0052 (2 indexes on ${String(ROWS)} rows): ${indexMs.toFixed(0)} ms ` +
        `(${((indexMs / ROWS) * 1_000_000).toFixed(0)} ms per million rows)`,
    );
    const { rows: sizes } = await sql<{ name: string; bytes: string }>`
      SELECT p.relname AS name, sum(pg_relation_size(i.inhrelid))::text AS bytes
        FROM pg_inherits AS i JOIN pg_class AS p ON p.oid = i.inhparent
       WHERE p.relname IN ('audit_logs_actor_idx', 'audit_logs_action_idx')
       GROUP BY p.relname ORDER BY p.relname
    `.execute(db.kysely);
    for (const size of sizes) {
      report.push(`${size.name}: ${(Number(size.bytes) / 1024 / 1024).toFixed(1)} MiB`);
    }
    await sql`ANALYZE meta.audit_logs`.execute(db.kysely);
    repo = new AuditLogsRepository(db);
  }, 1_800_000);

  afterAll(async () => {
    process.stdout.write(
      `\nT709 audit viewer bench (load ${load().toFixed(1)}, limit ${String(LOAD_LIMIT)})\n` +
        `  ${report.join('\n  ')}\n`,
    );
    await db.destroy();
    await database.drop();
  });

  async function measure(name: string, filter: (i: number) => AuditLogFilter): Promise<void> {
    const samples: number[] = [];
    // Warm-up: the first query of a shape loads its index pages.
    await repo.list(scope, filter(0), { cursor: null, limit: 50 });
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = performance.now();
      await repo.list(scope, filter(i), { cursor: null, limit: 50 });
      samples.push(performance.now() - started);
    }
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    results.set(name, { p50, p95 });
    report.push(`${name}: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
  }

  it('measures the viewer queries', async () => {
    await measure('first page, no filter', () => ({}));
    await measure('first page, 7 days', () => ({ from: weekAgo() }));
    await measure('actor_id, 7 days', (i) => ({
      actorIds: [actorOf(org, i % ACTORS)],
      from: weekAgo(),
    }));
    await measure('action (rare: field.updated), 7 days', () => ({
      actions: ['field.updated'],
      from: weekAgo(),
    }));
    await measure('action (common: record.updated), 7 days', () => ({
      actions: ['record.updated'],
      from: weekAgo(),
    }));
    await measure('3 actors, 7 days', (i) => ({
      actorIds: [0, 1, 2].map((k) => actorOf(org, (i + k) % ACTORS)),
      from: weekAgo(),
    }));
    await measure('action_prefix auth. + role., 7 days', () => ({
      actionPrefixes: ['auth.', 'role.'],
      from: weekAgo(),
    }));
    await measure('actor_id + action record.updated, 7 days', (i) => ({
      actorIds: [actorOf(org, i % ACTORS)],
      actions: ['record.updated'],
      from: weekAgo(),
    }));
    await measure('actor_id, no dates', (i) => ({ actorIds: [actorOf(org, i % ACTORS)] }));

    // "Load more": the 5th page of an actor's last 7 days.
    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      let cursor: string | null = null;
      const filter = { actorIds: [actorOf(org, i % ACTORS)], from: weekAgo() };
      for (let p = 0; p < 5; p += 1) {
        const started = performance.now();
        const page = await repo.list(scope, filter, {
          cursor: cursor === null ? null : decodeCursor(cursor),
          limit: 50,
        });
        if (p === 4) samples.push(performance.now() - started);
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
    }
    report.push(`actor_id, 7 days, 5th page: p95 ${percentile(samples, 95).toFixed(1)} ms`);

    if (load() >= LOAD_LIMIT) {
      report.push(`not asserted: load ${load().toFixed(1)} ≥ ${String(LOAD_LIMIT)}`);
      return;
    }
    expect(results.get('first page, no filter')?.p95).toBeLessThan(100);
    expect(results.get('actor_id, 7 days')?.p95).toBeLessThan(300);
    expect(results.get('action (rare: field.updated), 7 days')?.p95).toBeLessThan(300);
    expect(results.get('action (common: record.updated), 7 days')?.p95).toBeLessThan(300);
  }, 600_000);
});
