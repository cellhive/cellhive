/**
 * Opt-in bench of whole-base packages (BACKLOG T1020, CONTRACTS §9 and
 * §12.2, SPEC §21): `S9_BENCH=1 pnpm --filter @cellhive/api test:int
 * test/int/s9-package.bench`. On the real application (Testcontainers
 * PostgreSQL + Valkey, local storage) with a real worker in the process:
 *
 * 1. `seed:bench` — the 200 000-record × 30-field table (`S9_BENCH_ROWS`
 *    overrides the count) with its 20 000 customers, links and computed
 *    fields — plus an attachment field holding `S9_BENCH_FILE_MB` (1024 by
 *    default) of PDF files of `S9_BENCH_FILE_EACH_MB` (25) each, one per
 *    record (random content: stored as is, the worst case for size);
 * 2. `cellhive base export` (the path of large packages: the job of the
 *    worker, then the copy to `--out`), then `cellhive base import` of that
 *    file into a new workspace of the same organization.
 *
 * For each: wall time of the command, time of the job (`started_at` →
 * `finished_at`) and of each of its phases (from `progress`, sampled every
 * 250 ms), peak RSS of the process (API + worker + this test, sampled
 * likewise, and its growth over the RSS before the step) with the peaks of
 * the V8 heap in use and of `Buffer` memory beside it (with `S9_BENCH_GC=1`
 * and `NODE_OPTIONS=--expose-gc`, also the heap still in use after a full
 * GC about once a second: what the process really holds), the peak size of
 * the worker's temporary directory, the size of the package, the growth of
 * the database and of the storage. Numbers are printed, never asserted
 * (they depend on the machine and its load, printed beside them); the
 * import must still succeed with every record and file.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { availableParallelism, cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';

import {
  BASE_EXPORT_PHASES,
  BASE_IMPORT_PHASES,
  baseExportPhaseOf,
  baseImportPhaseOf,
  baseImportResultSchema,
  type Id,
} from '@cellhive/contracts';
import {
  createStorageDriver,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type Env,
  type StorageDriver,
} from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { runCli } from '../../src/cli/run.js';
import { DB } from '../../src/common/tokens.js';
import { BENCH_EMAIL, BENCH_PASSWORD, seedBench } from '../../src/seed/bench-seed.js';
import { BENCH_ROWS } from '../../src/seed/bench-table.js';
import { createSampleAttachment } from '../../src/seed/sample-attachments.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { relaxRateLimits } from './record-fixture.js';
import { captureLogger, startTestApp, TEST_SESSION_SECRET, type TestApp } from './support.js';

const MB = 1024 * 1024;
const ROWS = Number(process.env['S9_BENCH_ROWS'] ?? String(BENCH_ROWS));
const FILE_TOTAL_MB = Number(process.env['S9_BENCH_FILE_MB'] ?? '1024');
const FILE_EACH_MB = Number(process.env['S9_BENCH_FILE_EACH_MB'] ?? '25');
const SAMPLE_MS = 250;

const mb = (bytes: number) => `${(bytes / MB).toFixed(0)} MB`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const loadText = () =>
  loadavg()
    .map((value) => value.toFixed(1))
    .join(' / ');

/** Bytes under `path` (files only), 0 when it does not exist. */
async function sizeOf(path: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true, recursive: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      total += (await stat(join(entry.parentPath, entry.name))).size;
    } catch {
      // Removed meanwhile.
    }
  }
  return total;
}

/** Packages in the storage (`{org}/base-export-{job}.chbase`, `{org}/base-import-{job}.chbase`). */
async function storedPackages(root: string): Promise<number> {
  try {
    const entries = await readdir(root, { recursive: true });
    return entries.filter((name) =>
      /base-(?:export|import)-job_[0-9A-Za-z]{16}\.chbase$/u.test(name),
    ).length;
  } catch {
    return 0;
  }
}

/** A PDF of `size` bytes: its magic bytes, then random content (does not compress). */
function pdfOf(size: number): Buffer {
  const head = Buffer.from('%PDF-1.7\n', 'latin1');
  const tail = Buffer.from('\n%%EOF\n', 'latin1');
  return Buffer.concat([head, randomBytes(size - head.length - tail.length), tail]);
}

interface Sampled {
  readonly wallMs: number;
  readonly rssBefore: number;
  readonly rssPeak: number;
  /** Peak of the V8 heap in use, and of the memory of `Buffer`s / `ArrayBuffer`s (outside it). */
  readonly heapPeak: number;
  readonly buffersPeak: number;
  /** With `S9_BENCH_GC=1` (and `--expose-gc`): peak of the heap still in use after a full GC. */
  readonly liveHeapPeak: number | null;
  readonly tempPeak: number;
  /** Ms from the first sample of each phase to the first of the next (or the end). */
  readonly phases: readonly (readonly [string, number])[];
}

/**
 * Runs `step` while sampling the RSS, the size of `temp` and the progress
 * of the job `jobOf()` names once it is known.
 */
async function sampled(
  db: Db,
  temp: string,
  phaseOf: (progress: number) => string,
  jobOf: () => string | null,
  step: () => Promise<void>,
): Promise<Sampled> {
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  let heapPeak = 0;
  let buffersPeak = 0;
  const gc =
    process.env['S9_BENCH_GC'] === '1' ? (globalThis as { gc?: () => void }).gc : undefined;
  let liveHeapPeak: number | null = gc === undefined ? null : 0;
  let samples = 0;
  let tempPeak = 0;
  const seen: [string, number][] = [];
  const started = performance.now();
  const state = { running: true };
  const sampler = (async () => {
    while (state.running) {
      const memory = process.memoryUsage();
      rssPeak = Math.max(rssPeak, memory.rss);
      heapPeak = Math.max(heapPeak, memory.heapUsed);
      buffersPeak = Math.max(buffersPeak, memory.arrayBuffers);
      samples += 1;
      // About once a second: what the heap really holds, garbage collected.
      if (gc !== undefined && samples % 4 === 0) {
        gc();
        liveHeapPeak = Math.max(liveHeapPeak ?? 0, process.memoryUsage().heapUsed);
      }
      tempPeak = Math.max(tempPeak, await sizeOf(temp));
      const jobId = jobOf();
      if (jobId !== null) {
        const row = await db.kysely
          .selectFrom('meta.jobs')
          .select(['status', 'progress'])
          .where('id', '=', jobId as Id<'job'>)
          .executeTakeFirst();
        if (row?.status === 'running') {
          const phase = phaseOf(row.progress);
          if (seen.at(-1)?.[0] !== phase) seen.push([phase, performance.now()]);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
    }
  })();
  try {
    await step();
  } finally {
    state.running = false;
    await sampler;
  }
  const ended = performance.now();
  const phases = seen.map(
    ([phase, at], index) => [phase, (seen[index + 1]?.[1] ?? ended) - at] as const,
  );
  return {
    wallMs: ended - started,
    rssBefore,
    rssPeak,
    heapPeak,
    buffersPeak,
    liveHeapPeak,
    tempPeak,
    phases,
  };
}

describe.skipIf(process.env['S9_BENCH'] !== '1')(
  'S9 bench: .chbase export and import (T1020)',
  () => {
    let database: TestDatabase;
    let db: Db;
    let t: TestApp;
    let worker: WorkerHandle;
    let storage: StorageDriver;
    let tempRoot: string;
    let outDir: string;
    let owner: Browser;
    let organizationId: Id<'org'>;
    let baseId: Id<'bse'>;
    let files = 0;
    const report: string[] = [];

    function env(): Env {
      return {
        NODE_ENV: 'test',
        PUBLIC_URL: t.config.publicUrl,
        DATABASE_URL: database.url,
        CACHE_URL: inject('cacheUrl'),
        APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
        SESSION_SECRET: TEST_SESSION_SECRET,
        STORAGE_DRIVER: 'local',
        STORAGE_LOCAL_PATH: t.storageRoot,
        LOG_LEVEL: 'warn',
      };
    }

    async function cli(argv: string[], onJob: (jobId: string) => void): Promise<string[]> {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(argv, env(), {
        out: (line) => {
          if (out.length === 0) onJob(line);
          out.push(line);
        },
        err: (line) => err.push(line),
      });
      expect(code, err.join('\n')).toBe(0);
      return out;
    }

    async function jobTimes(jobId: string): Promise<{ queuedMs: number; runMs: number }> {
      const row = await db.kysely
        .selectFrom('meta.jobs')
        .select(['created_at', 'started_at', 'finished_at'])
        .where('id', '=', jobId as Id<'job'>)
        .executeTakeFirstOrThrow();
      const started = row.started_at?.getTime() ?? row.created_at.getTime();
      return {
        queuedMs: started - row.created_at.getTime(),
        runMs: (row.finished_at?.getTime() ?? started) - started,
      };
    }

    const databaseSize = async () =>
      Number(
        (
          await sql<{
            size: string;
          }>`SELECT pg_database_size(current_database())::text AS size`.execute(db.kysely)
        ).rows[0]?.size ?? 0,
      );

    function describeStep(
      label: string,
      sample: Sampled,
      job: { queuedMs: number; runMs: number },
    ) {
      report.push(
        `${label}: command ${seconds(sample.wallMs)}, job ${seconds(job.runMs)} ` +
          `(queued ${seconds(job.queuedMs)}); RSS peak ${mb(sample.rssPeak)} ` +
          `(+${mb(Math.max(0, sample.rssPeak - sample.rssBefore))} over ${mb(sample.rssBefore)}; ` +
          `heap in use ≤ ${mb(sample.heapPeak)}, buffers ≤ ${mb(sample.buffersPeak)}` +
          `${sample.liveHeapPeak === null ? '' : `, live heap after GC ≤ ${mb(sample.liveHeapPeak)}`}); ` +
          `worker temp peak ${mb(sample.tempPeak)}`,
        `  phases: ${sample.phases.map(([phase, ms]) => `${phase} ${seconds(ms)}`).join(', ')}`,
      );
    }

    beforeAll(async () => {
      database = await createMigratedDatabase();
      db = createTestDb(database.url);
      t = await startTestApp({ DATABASE_URL: database.url, LOG_LEVEL: 'warn' });
      relaxRateLimits(t);
      storage = createStorageDriver(t.config);
      tempRoot = await mkdtemp(join(tmpdir(), 'cellhive-s9-bench-worker-'));
      outDir = await mkdtemp(join(tmpdir(), 'cellhive-s9-bench-out-'));
      const seedStarted = Date.now();
      const seeded = await seedBench(t.app, { rows: ROWS });
      organizationId = seeded.organizationId;
      baseId = seeded.baseId;
      report.push(
        `seed:bench ${String(ROWS)} rows × 30 fields in ${seconds(Date.now() - seedStarted)}`,
      );

      // The files: one PDF per record of the 200k table, in a new attachment field.
      const scope = orgScope(organizationId);
      const ownerId = (
        await db.kysely
          .selectFrom('meta.users')
          .select('id')
          .where('email', '=', BENCH_EMAIL)
          .executeTakeFirstOrThrow()
      ).id;
      const field = await t.app
        .get(SchemaService)
        .addField(
          scope,
          seeded.tableId,
          { name: 'Tệp', type: 'attachment', options: {} },
          systemAuditContext(),
        );
      const table = await db.kysely
        .selectFrom('meta.tables')
        .select('db_table_name')
        .where('id', '=', seeded.tableId)
        .executeTakeFirstOrThrow();
      files = Math.max(1, Math.round(FILE_TOTAL_MB / FILE_EACH_MB));
      const { rows: records } = await sql<{ id: Id<'rec'> }>`
      SELECT __id AS id FROM ${sql.table(`data.${table.db_table_name}`)} ORDER BY __auto LIMIT ${files}
    `.execute(db.kysely);
      owner = new Browser(t.app);
      expect((await owner.login(BENCH_EMAIL, BENCH_PASSWORD)).statusCode).toBe(204);
      const filesStarted = Date.now();
      for (const [index, record] of records.entries()) {
        const id = await createSampleAttachment(db, storage, scope, {
          baseId,
          tableId: seeded.tableId,
          fieldId: field.id,
          ownerId,
          file: {
            filename: `ho-so-${String(index + 1).padStart(3, '0')}.pdf`,
            mime: 'application/pdf',
            bytes: pdfOf(FILE_EACH_MB * MB),
          },
        });
        const patched = await owner.request({
          method: 'PATCH',
          url: `/api/v1/tables/${seeded.tableId}/records`,
          payload: { records: [{ id: record.id, fields: { Tệp: [{ id }] } }] },
        });
        expect(patched.statusCode, patched.body).toBe(200);
      }
      report.push(
        `files: ${String(files)} × ${String(FILE_EACH_MB)} MB PDF = ${String(files * FILE_EACH_MB)} MB ` +
          `in ${seconds(Date.now() - filesStarted)}`,
      );

      const { logger } = captureLogger();
      worker = await createWorker(t.config, {
        logger,
        pollIntervalMs: 50,
        taskList: buildTaskList({
          config: t.config,
          db: t.app.get<Db>(DB),
          logger,
          baseExport: { tempRoot },
          baseImport: { tempRoot },
        }),
      });
    }, 3_600_000);

    afterAll(async () => {
      process.stdout.write(
        `\nS9 bench — .chbase (${String(availableParallelism())} CPUs ${cpus()[0]?.model ?? ''}, ` +
          `${mb(totalmem())} RAM, load ${loadText()})\n${report.map((line) => `  ${line}`).join('\n')}\n`,
      );
      await (worker as WorkerHandle | undefined)?.close();
      await (storage as StorageDriver | undefined)?.close();
      await t.close();
      await db.destroy();
      await database.drop();
      await rm(tempRoot, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    });

    it('exports the base with cellhive base export, then imports it with cellhive base import', async () => {
      const path = join(outDir, 'bench.chbase');
      const exportJob: { id: string | null } = { id: null };
      const storageBefore = await sizeOf(t.storageRoot);
      const exported = await sampled(
        db,
        tempRoot,
        baseExportPhaseOf,
        () => exportJob.id,
        async () => {
          await cli(['base', 'export', '--base', baseId, '--out', path], (jobId) => {
            exportJob.id = jobId;
          });
        },
      );
      if (exportJob.id === null) throw new Error('no export job');
      const packageBytes = (await stat(path)).size;
      describeStep('export', exported, await jobTimes(exportJob.id));
      report.push(
        `  package ${mb(packageBytes)} (${String(packageBytes)} bytes); ` +
          `phases of the contract: ${BASE_EXPORT_PHASES.map(([name]) => name).join(' → ')}`,
      );

      const workspace = await owner.request({
        method: 'POST',
        url: `/api/v1/orgs/${organizationId}/workspaces`,
        payload: { name: 'Bench import' },
      });
      expect(workspace.statusCode, workspace.body).toBe(201);
      const workspaceId = workspace.json<{ id: string }>().id;
      const databaseBefore = await databaseSize();
      const storageMid = await sizeOf(t.storageRoot);
      const importJob: { id: string | null } = { id: null };
      let out: string[] = [];
      const imported = await sampled(
        db,
        tempRoot,
        baseImportPhaseOf,
        () => importJob.id,
        async () => {
          out = await cli(
            ['base', 'import', '--workspace', workspaceId, '--file', path, '--as', BENCH_EMAIL],
            (jobId) => {
              importJob.id = jobId;
            },
          );
        },
      );
      if (importJob.id === null) throw new Error('no import job');
      describeStep('import', imported, await jobTimes(importJob.id));
      const result = baseImportResultSchema.parse(JSON.parse(out[1] ?? '{}'));
      // The uploaded copy of the package is deleted as the job ends: wait for it (10 s at most).
      const deadline = Date.now() + 10_000;
      while ((await storedPackages(t.storageRoot)) > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      report.push(
        `  database +${mb((await databaseSize()) - databaseBefore)}, storage +` +
          `${mb((await sizeOf(t.storageRoot)) - storageMid)} (export left ` +
          `${mb(storageMid - storageBefore)} behind: the CLI deletes its stored copy); ` +
          `phases of the contract: ${BASE_IMPORT_PHASES.map(([name]) => name).join(' → ')}`,
        `  created: ${String(result.report.tables)} tables, ${String(result.report.fields)} fields, ` +
          `${String(result.report.records)} records, ${String(result.report.links)} links, ` +
          `${String(result.report.attachments)} files`,
      );
      expect(result.report.records).toBeGreaterThanOrEqual(ROWS);
      expect(result.report.attachments).toBe(files);
    }, 3_600_000);
  },
);
