import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  isWorkerAlive,
  startJobRunner,
  WORKER_LIVENESS_APPLICATION_NAME,
} from '../../src/index.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  queuedJobs,
  waitFor,
  type CapturedLogger,
  type TestDatabase,
} from './support.js';

import type { Runner, Task } from 'graphile-worker';

const WORKER_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('worker crash and shutdown', () => {
  let database: TestDatabase;
  let db: Db;

  async function addJob(task: string): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      SELECT id::text AS id FROM graphile_worker.add_job(${task}, '{}'::json, max_attempts => 5)
    `.execute(db.kysely);
    return rows[0]?.id ?? '';
  }

  async function doneRows(): Promise<{ job_id: string; attempts: number }[]> {
    const { rows } = await sql<{ job_id: string; attempts: number }>`
      SELECT job_id, attempts FROM public.test_done ORDER BY job_id
    `.execute(db.kysely);
    return rows;
  }

  /** Records completion; used by the in-process runners. */
  const completes: Task = async (_payload, helpers) => {
    await helpers.query('INSERT INTO public.test_done (job_id, attempts) VALUES ($1, $2)', [
      helpers.job.id,
      helpers.job.attempts,
    ]);
  };

  function startRunner(
    taskList: Record<string, Task>,
    options: { hostname?: string; logger?: CapturedLogger; pid?: number } = {},
  ): Promise<Runner> {
    return startJobRunner({
      connectionString: database.url,
      concurrency: 2,
      pollIntervalMs: 200,
      logger: (options.logger ?? captureLogger()).logger,
      hostname: options.hostname ?? 'host-b',
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      taskList,
    });
  }

  /**
   * Runs `test.slow` in a child worker process on `hostname`; resolves once
   * the job started there (it then hangs until `kill`). `pid` replaces the
   * pid in its worker id (another PID namespace).
   */
  async function startChildWorker(
    hostname: string,
    pid?: number,
  ): Promise<{ pid: number; kill(): Promise<void> }> {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'test/int/fixtures/hanging-worker.ts'],
      {
        cwd: WORKER_ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          DATABASE_URL: database.url,
          WORKER_HOSTNAME: hostname,
          ...(pid === undefined ? {} : { WORKER_PID: String(pid) }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    // Crash: no graceful shutdown, the job stays locked by the dead worker.
    const kill = async (): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    };
    try {
      await waitFor(
        async () => {
          const { rows } = await sql<{
            job_id: string;
          }>`SELECT job_id FROM public.test_started`.execute(db.kysely);
          return rows.length > 0;
        },
        { timeoutMs: 30_000, what: 'the job to start in the child worker' },
      );
    } catch (err) {
      await kill();
      throw err;
    }
    return { pid: child.pid ?? 0, kill };
  }

  /** Runs `test.slow` in a child worker on `hostname`, SIGKILLs it once the job started. */
  async function crashChildWorker(hostname: string): Promise<void> {
    const child = await startChildWorker(hostname);
    await child.kill();
  }

  const startedCount = async (): Promise<number> => {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM public.test_started
    `.execute(db.kysely);
    return rows[0]?.n ?? 0;
  };

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    await sql`CREATE TABLE public.test_started (job_id text NOT NULL)`.execute(db.kysely);
    await sql`CREATE TABLE public.test_done (job_id text NOT NULL, attempts int NOT NULL)`.execute(
      db.kysely,
    );
  });

  beforeEach(async () => {
    await sql`TRUNCATE public.test_started, public.test_done`.execute(db.kysely);
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('a job whose worker was killed mid-run reruns at once when a worker of the same host starts (T702)', async () => {
    const jobId = await addJob('test.slow');
    await crashChildWorker('host-a');

    const [locked] = await queuedJobs(db, 'test.slow');
    expect(locked).toMatchObject({ id: jobId, attempts: 1 });
    // The dead process locked it with its worker id `ob-<host>-<pid>-<8 base62>`.
    expect(locked?.locked_by).toMatch(/^ob-host-a-[1-9][0-9]*-[0-9A-Za-z]{8}$/u);

    const captured = captureLogger();
    const started = Date.now();
    const runner = await startRunner(
      { 'test.slow': completes },
      { hostname: 'host-a', logger: captured },
    );
    try {
      const [done] = await waitFor(
        async () => {
          const rows = await doneRows();
          return rows.length > 0 ? rows : undefined;
        },
        { what: 'the job to complete on the new worker' },
      );
      // Not after graphile-worker's 4-hour lock timeout: right after the start.
      expect(Date.now() - started).toBeLessThan(15_000);
      // The crashed run counted as an attempt; the job was not lost.
      expect(done).toEqual({ job_id: jobId, attempts: 2 });
      const unlocked = captured.lines.find(
        (line) => line['msg'] === 'jobs of dead workers on this host unlocked',
      );
      expect(unlocked).toMatchObject({ dead_workers: 1, jobs: 1 });
      expect(unlocked?.['worker_id']).toMatch(
        new RegExp(`^ob-host-a-${String(process.pid)}-[0-9A-Za-z]{8}$`, 'u'),
      );
      expect(unlocked?.['worker_id']).not.toBe(locked?.locked_by);
      await waitFor(async () => (await queuedJobs(db, 'test.slow')).length === 0, {
        what: 'the job to leave the queue',
      });
    } finally {
      await runner.stop();
    }
  });

  it('a worker starting or restarting next to a live worker of the same host leaves its running job alone', async () => {
    const jobId = await addJob('test.slow');
    // E.g. `pnpm dev`: the api with MODE=all and `apps/worker` on one machine.
    const child = await startChildWorker('host-a');
    try {
      const [locked] = await queuedJobs(db, 'test.slow');
      expect(locked?.locked_by).toMatch(
        new RegExp(`^ob-host-a-${String(child.pid)}-[0-9A-Za-z]{8}$`, 'u'),
      );
      for (let restart = 0; restart < 2; restart += 1) {
        const captured = captureLogger();
        const runner = await startRunner(
          { 'test.slow': completes },
          { hostname: 'host-a', logger: captured },
        );
        try {
          await new Promise((resolve) => setTimeout(resolve, 600));
          expect(
            captured.lines.find(
              (line) => line['msg'] === 'jobs of dead workers on this host unlocked',
            ),
          ).toMatchObject({ dead_workers: 0, live_workers: 1, jobs: 0 });
        } finally {
          await runner.stop();
        }
        // Still running in the live process: not unlocked, not run a second time.
        const [still] = await queuedJobs(db, 'test.slow');
        expect(still).toMatchObject({ id: jobId, attempts: 1, locked_by: locked?.locked_by });
        expect(await startedCount()).toBe(1);
        expect(await doneRows()).toEqual([]);
      }
    } finally {
      await child.kill();
    }
  });

  it('a live worker in another PID namespace with the same hostname and pid keeps its job', async () => {
    // Two containers of one pod: same hostname, both PID 1 — pids say nothing.
    const jobId = await addJob('test.slow');
    const child = await startChildWorker('host-a', 1);
    try {
      const [locked] = await queuedJobs(db, 'test.slow');
      expect(locked?.locked_by).toMatch(/^ob-host-a-1-[0-9A-Za-z]{8}$/u);
      const captured = captureLogger();
      const runner = await startRunner(
        { 'test.slow': completes },
        { hostname: 'host-a', pid: 1, logger: captured },
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(
          captured.lines.find(
            (line) => line['msg'] === 'jobs of dead workers on this host unlocked',
          ),
        ).toMatchObject({ dead_workers: 0, live_workers: 1, jobs: 0 });
      } finally {
        await runner.stop();
      }
      const [still] = await queuedJobs(db, 'test.slow');
      expect(still).toMatchObject({ id: jobId, attempts: 1, locked_by: locked?.locked_by });
      expect(await startedCount()).toBe(1);
      expect(await doneRows()).toEqual([]);
    } finally {
      await child.kill();
    }
    // Once it is dead, the same pid no longer protects it.
    const captured = captureLogger();
    const runner = await startRunner(
      { 'test.slow': completes },
      { hostname: 'host-a', pid: 1, logger: captured },
    );
    try {
      await waitFor(async () => (await doneRows()).length > 0, { what: 'the job to rerun' });
      expect(await doneRows()).toEqual([{ job_id: jobId, attempts: 2 }]);
    } finally {
      await runner.stop();
    }
  });

  it('the liveness lock is taken again after its connection drops', async () => {
    const captured = captureLogger();
    const runner = await startRunner({ 'test.slow': completes }, { logger: captured });
    const probe = new pg.Client({ connectionString: database.url });
    await probe.connect();
    try {
      const started = captured.lines.find((line) => line['msg'] === 'job runner starting');
      const workerId = String(started?.['worker_id']);
      expect(await isWorkerAlive(probe, workerId)).toBe(true);
      const { rows } = await probe.query<{ killed: boolean }>(
        `SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = $1`,
        [WORKER_LIVENESS_APPLICATION_NAME],
      );
      expect(rows).toEqual([{ killed: true }]);
      await waitFor(
        () =>
          Promise.resolve(
            captured.lines.some((line) => line['msg'] === 'worker liveness lock reacquired'),
          ),
        { what: 'the liveness lock to be reacquired' },
      );
      expect(
        captured.lines.some((line) => line['msg'] === 'worker liveness lock lost, reacquiring'),
      ).toBe(true);
      expect(await isWorkerAlive(probe, workerId)).toBe(true);
    } finally {
      await probe.end();
      await runner.stop();
    }
    // Stopped: its lock is released, it reads as dead.
    const after = new pg.Client({ connectionString: database.url });
    await after.connect();
    try {
      const started = captured.lines.find((line) => line['msg'] === 'job runner starting');
      expect(await isWorkerAlive(after, String(started?.['worker_id']))).toBe(false);
    } finally {
      await after.end();
    }
  });

  it('a worker of another host does not unlock it: it waits for the 4-hour lock timeout', async () => {
    const jobId = await addJob('test.slow');
    await crashChildWorker('host-a');

    const [locked] = await queuedJobs(db, 'test.slow');
    expect(locked).toMatchObject({ id: jobId, attempts: 1 });
    expect(locked?.locked_by).toMatch(/^ob-host-a-/u);

    const captured = captureLogger();
    const runner = await startRunner(
      { 'test.slow': completes },
      { hostname: 'host-b', logger: captured },
    );
    try {
      // Still locked: graphile-worker only reclaims it after its lock timeout
      // (4 h) or when the dead worker is unlocked explicitly.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(await doneRows()).toEqual([]);
      const [still] = await queuedJobs(db, 'test.slow');
      expect(still?.locked_by).toBe(locked?.locked_by);
      expect(
        captured.lines.find((line) => line['msg'] === 'jobs of dead workers on this host unlocked'),
      ).toMatchObject({ dead_workers: 0, jobs: 0 });

      await sql`SELECT graphile_worker.force_unlock_workers(${[locked?.locked_by ?? '']}::text[])`.execute(
        db.kysely,
      );
      const [done] = await waitFor(
        async () => {
          const rows = await doneRows();
          return rows.length > 0 ? rows : undefined;
        },
        { what: 'the job to complete on the new worker' },
      );
      // The crashed run counted as an attempt; the job was not lost.
      expect(done).toEqual({ job_id: jobId, attempts: 2 });
      await waitFor(async () => (await queuedJobs(db, 'test.slow')).length === 0, {
        what: 'the job to leave the queue',
      });
    } finally {
      await runner.stop();
    }
  });

  it('a graceful stop lets the running job finish', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runner = await startRunner({
      'test.slow': async (payload, helpers) => {
        started();
        await new Promise((resolve) => setTimeout(resolve, 500));
        await completes(payload, helpers);
      },
    });
    const jobId = await addJob('test.slow');
    await running;
    await runner.stop();

    expect(await doneRows()).toEqual([{ job_id: jobId, attempts: 1 }]);
    // Completion is recorded before stop() resolves, not left locked for 4 h.
    expect(await queuedJobs(db, 'test.slow')).toEqual([]);
  });
});
