import { createRequire } from 'node:module';

import { E2E_STACK_ENV } from './ports';

/**
 * Direct database access for the `@perf` specs' setup steps (BACKLOG T818):
 * never for a measurement, only to bring the stack to the steady state the
 * budgets assume (FRONTEND §11.1) after a spec rewrote the bench table.
 */

interface Pg {
  Client: new (options: { connectionString: string }) => {
    connect: () => Promise<void>;
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
}

export async function sql(
  text: string,
  values: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const raw = process.env[E2E_STACK_ENV];
  if (raw === undefined) throw new Error('The E2E global setup did not publish the stack env.');
  const { DATABASE_URL } = JSON.parse(raw) as { DATABASE_URL: string };
  const pg = createRequire(new URL('../../api/package.json', import.meta.url))('pg') as Pg;
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

async function pendingDispatchJobs(): Promise<number> {
  const rows = await sql(
    // A job out of attempts stays in the table but never runs again.
    `SELECT count(*)::int AS n FROM graphile_worker.jobs
      WHERE task_identifier = 'events.dispatch' AND attempts < max_attempts`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * After a bulk rewrite of the bench table (150 000 records re-parented by
 * t417): waits until the worker has dispatched every event the writes
 * queued (the bench organization has automations, so `seed:bench` cannot
 * settle them), then `VACUUM (ANALYZE)` so the planner has statistics for
 * the new columns and no autovacuum starts in the middle of a later
 * measurement. Without it t417, t422 and t468 measured while the worker
 * still worked off ~150 000 `events.dispatch` jobs (perf runs 40147573116,
 * 40177286397, 40214587132). Returns what it waited, for the log.
 */
export async function settleAfterBulkWrites(
  timeoutMs = 30 * 60_000,
): Promise<{ jobs: number; drainedMs: number; vacuumMs: number }> {
  const started = Date.now();
  const jobs = await pendingDispatchJobs();
  let left = jobs;
  while (left > 0 && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    left = await pendingDispatchJobs();
  }
  if (left > 0) {
    throw new Error(
      `${String(left)} events.dispatch jobs still queued after ${String(timeoutMs)} ms`,
    );
  }
  const drainedMs = Date.now() - started;
  const vacuumStarted = Date.now();
  await sql('VACUUM (ANALYZE)');
  return { jobs, drainedMs, vacuumMs: Date.now() - vacuumStarted };
}
