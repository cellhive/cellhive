import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BASE_EXPORT_JOB_TYPE,
  baseExportResultSchema,
  createdApiTokenSchema,
  jobAcceptedSchema,
  jobSchema,
  newId,
  type ApiTokenScope,
  type CreatedApiToken,
  type Id,
  type JobDto,
} from '@cellhive/contracts';
import {
  BaseRolesRepository,
  basePackageKey,
  createStorageDriver,
  DbBaseExportSource,
  JobsRepository,
  openBasePackage,
  orgScope,
  RecordQueryService,
  type BaseExportSource,
  type Db,
  type StorageDriver,
  Env,
} from '@cellhive/server-core';
import {
  baseExportTempDir,
  buildTaskList,
  createExportsCleanupTask,
  createWorker,
  type WorkerHandle,
} from '@cellhive/worker';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { runCli } from '../../src/cli/run.js';

import { uniqueIp } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { captureLogger, startTestApp, TEST_SESSION_SECRET, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const DAY = 86_400_000;
const MIB = 1024 * 1024;
const EXPORT_SCOPES: ApiTokenScope[] = ['records:read', 'schema:read', 'automations:read'];

async function finishedJob(read: () => Promise<LightMyRequestResponse>): Promise<JobDto> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await read();
    expect(response.statusCode, response.body).toBe(200);
    const job = jobSchema.parse(response.json());
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${job.id} still ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * BACKLOG T1017 (CONTRACTS §12.2, §5 P119 and P121): `POST /bases/:id/export`
 * and the `base.export` job on the permission fixture of CONTRACTS §5 —
 * who may export (sessions and API tokens, `404` before `403`, one case per
 * missing scope), who sees and downloads the job, expiry, an interrupted
 * worker, a failure mid-export, `BASE_PACKAGE_MAX_BYTES` and `cellhive base
 * export`. The API runs with `BASE_PACKAGE_MAX_BYTES` = 1 MiB (the fixture
 * base is far smaller). The content of a package (P120) and the round
 * trip of `seed:demo` are in `base-export-demo.int.test.ts`.
 */
describe('base export (T1017)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle | undefined;
  let storage: StorageDriver;
  let tempRoot: string;
  let base2: Id<'bse'>;
  /** The next export runs through this source instead of the database (failures). */
  let nextSource: ((source: BaseExportSource) => BaseExportSource) | null = null;
  const tk = {} as Record<
    'pkg_x' | 'admin_b2' | 'sales_r' | 'no_schema' | 'no_automations' | 'no_records' | 'none',
    CreatedApiToken
  >;

  function bearer(token: CreatedApiToken, method: 'GET' | 'POST', url: string, payload?: object) {
    return t.app.inject({
      method,
      url: `/api/v1${url}`,
      remoteAddress: uniqueIp(),
      headers: { authorization: `Bearer ${token.token}` },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function createToken(
    user: FixtureUser,
    scopes: ApiTokenScope[],
    baseIds: Id<'bse'>[] | null = null,
  ): Promise<CreatedApiToken> {
    const response = await fx.call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: `export ${scopes.join(' ')}`,
      scopes,
      base_ids: baseIds,
      expires_at: new Date(Date.now() + 90 * DAY).toISOString(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  async function startWorker(): Promise<void> {
    if (worker !== undefined) return;
    const { logger } = captureLogger();
    worker = await createWorker(t.config, {
      logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db,
        logger,
        baseExport: {
          tempRoot,
          source: (organizationId, baseId) => {
            const source = new DbBaseExportSource(
              {
                db,
                records: new RecordQueryService(db, { defaultTimeZone: 'UTC' }),
                storage,
                timeZone: 'UTC',
              },
              orgScope(organizationId),
              baseId,
            );
            const wrap = nextSource;
            nextSource = null;
            return wrap === null ? source : wrap(source);
          },
        },
      }),
    });
  }

  async function exportAs(user: FixtureUser, baseId: Id<'bse'> = fx.baseId): Promise<Id<'job'>> {
    const response = await fx.call(user, 'POST', `/bases/${baseId}/export`);
    expect(response.statusCode, response.body).toBe(202);
    return jobAcceptedSchema.parse(response.json()).job_id;
  }

  const jobOf = (jobId: Id<'job'>) => finishedJob(() => fx.call('owner', 'GET', `/jobs/${jobId}`));

  async function packageFiles(): Promise<string[]> {
    try {
      return await readdir(tempRoot);
    } catch {
      return [];
    }
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, BASE_PACKAGE_MAX_BYTES: String(MIB) });
    fx = await buildRecordFixture(t, db);
    storage = createStorageDriver(t.config);
    tempRoot = await mkdtemp(join(tmpdir(), 'cellhive-base-export-test-'));
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        { fields: { title: 'r1', amount: 100, cost: 60, owner: [{ id: fx.users.u_sales1.id }] } },
        { fields: { title: 'r2', amount: 200, cost: 90, owner: [{ id: fx.users.u_sales2.id }] } },
        { fields: { title: 'r3', amount: 300, cost: 120 } },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);

    // B2: a second base of the workspace where u_admin is admin too (`tk_admin_b2`).
    const base = await fx.call('owner', 'GET', `/bases/${fx.baseId}`);
    const workspaceId = base.json<{ workspace_id: Id<'wsp'> }>().workspace_id;
    const second = await fx.call('owner', 'POST', `/workspaces/${workspaceId}/bases`, {
      name: 'B2',
    });
    expect(second.statusCode, second.body).toBe(201);
    base2 = second.json<{ id: Id<'bse'> }>().id;
    const adminRole = (
      await new BaseRolesRepository(db).listByBase(orgScope(fx.orgId), base2)
    ).find((role) => role.kind === 'system_admin');
    const assigned = await fx.call('owner', 'PUT', `/bases/${base2}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_admin.id,
      role_id: adminRole?.id,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);

    tk.pkg_x = await createToken('u_admin', EXPORT_SCOPES);
    tk.admin_b2 = await createToken('u_admin', EXPORT_SCOPES, [base2]);
    tk.sales_r = await createToken('u_sales1', ['records:read', 'schema:read']);
    tk.no_schema = await createToken('u_admin', ['records:read', 'automations:read']);
    tk.no_automations = await createToken('u_admin', ['records:read', 'schema:read']);
    tk.no_records = await createToken('u_admin', ['schema:read', 'automations:read']);
    tk.none = await createToken('u_admin', ['records:write']);
  }, 180_000);

  afterAll(async () => {
    await worker?.close();
    await storage.close();
    await t.close();
    await db.destroy();
    await database.drop();
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe('interrupted and failed jobs (no worker yet)', () => {
    it('a worker that dies mid-job: the retry fails the job and removes its file and object', async () => {
      const jobId = await exportAs('u_admin');
      // What the attempt that died left: the row running, a half-written spool, an object.
      await db.kysely
        .updateTable('meta.jobs')
        .set({ status: 'running', started_at: new Date() })
        .where('id', '=', jobId)
        .execute();
      const dir = baseExportTempDir(tempRoot, jobId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.chbase'), Buffer.from('PK\u0003\u0004 half'));
      const key = basePackageKey(fx.orgId, jobId);
      await storage.put(key, Buffer.from('half'), { contentType: 'application/zip' });

      await startWorker();
      const job = await jobOf(jobId);
      expect(job).toMatchObject({
        type: BASE_EXPORT_JOB_TYPE,
        status: 'failed',
        result: null,
        error: { code: 'INTERNAL' },
      });
      await expect(stat(dir)).rejects.toThrow();
      expect(await storage.head(key)).toBeNull();
    });

    it('a failure mid-export fails the job; no temporary file, no object', async () => {
      await startWorker();
      nextSource = (source) => ({
        ...bind(source),
        openRecords: async (tableId) => {
          const stream = await source.openRecords(tableId);
          return {
            rowCount: stream.rowCount,
            async *records() {
              for await (const batch of stream.records()) {
                yield batch;
                throw new Error('connection reset');
              }
            },
          };
        },
      });
      const jobId = await exportAs('u_admin');
      const job = await jobOf(jobId);
      expect(job).toMatchObject({ status: 'failed', error: { code: 'INTERNAL' } });
      expect(JSON.stringify(job.error)).not.toContain('connection reset');
      expect(await packageFiles()).toEqual([]);
      expect(await storage.head(basePackageKey(fx.orgId, jobId))).toBeNull();
    });

    it('a package over BASE_PACKAGE_MAX_BYTES: failed VALIDATION_FAILED PACKAGE_TOO_LARGE', async () => {
      await startWorker();
      const noise = randomBytes(1_500_000).toString('base64');
      nextSource = (source) => ({
        ...bind(source),
        openRecords: async (tableId) => {
          const stream = await source.openRecords(tableId);
          return {
            rowCount: stream.rowCount,
            async *records() {
              for await (const batch of stream.records()) {
                yield batch.map((record) => ({
                  ...record,
                  fields: { ...record.fields, [fx.fld['title']?.id ?? '']: noise },
                }));
              }
            },
          };
        },
      });
      const jobId = await exportAs('u_admin');
      const job = await jobOf(jobId);
      expect(job).toMatchObject({
        status: 'failed',
        error: {
          code: 'VALIDATION_FAILED',
          errors: [{ code: 'PACKAGE_TOO_LARGE', params: { limit: MIB } }],
        },
      });
      expect(await packageFiles()).toEqual([]);
      expect(await storage.head(basePackageKey(fx.orgId, jobId))).toBeNull();
    });
  });

  describe('P119 — POST /bases/B/export', () => {
    it('P119 u_admin (base admin) → 202, base.exported with counts in the same transaction', async () => {
      const jobId = await exportAs('u_admin');
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .selectAll()
        .where('organization_id', '=', fx.orgId)
        .where('action', '=', 'base.exported')
        .where('entity_id', '=', jobId)
        .execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_type: 'user',
        actor_id: fx.users.u_admin.id,
        base_id: fx.baseId,
        entity_type: 'job',
        after: {
          counts: { tables: 3, fields: 12, views: 3, dashboards: 0, automations: 0, roles: 1 },
        },
      });
      expect((await jobOf(jobId)).status).toBe('succeeded');
    });

    it('P119 org owner (not a base member) → 202', async () => {
      const jobId = await exportAs('owner');
      expect((await jobOf(jobId)).status).toBe('succeeded');
    });

    for (const user of ['u_editor', 'u_reader', 'u_sales1'] as const) {
      it(`P119 ${user} → 403 PERMISSION_DENIED`, async () => {
        expectProblem(
          await fx.call(user, 'POST', `/bases/${fx.baseId}/export`),
          403,
          'PERMISSION_DENIED',
        );
      });
    }

    it('P119 u_out, org other, unknown id → 404 before any check', async () => {
      expectProblem(await fx.call('u_out', 'POST', `/bases/${fx.baseId}/export`), 404, 'NOT_FOUND');
      expectProblem(
        await fx.call('stranger', 'POST', `/bases/${fx.baseId}/export`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('u_admin', 'POST', `/bases/${newId('bse')}/export`),
        404,
        'NOT_FOUND',
      );
    });

    it('P119 tk_admin_b2 (base outside base_ids) → 404, even without a scope', async () => {
      expectProblem(
        await bearer(tk.admin_b2, 'POST', `/bases/${fx.baseId}/export`),
        404,
        'NOT_FOUND',
      );
      const limited = await createToken('u_admin', ['records:write'], [base2]);
      expectProblem(await bearer(limited, 'POST', `/bases/${fx.baseId}/export`), 404, 'NOT_FOUND');
    });

    it('P119 tk_pkg_x (records:read + schema:read + automations:read) → 202', async () => {
      const response = await bearer(tk.pkg_x, 'POST', `/bases/${fx.baseId}/export`, {});
      expect(response.statusCode, response.body).toBe(202);
      const jobId = jobAcceptedSchema.parse(response.json()).job_id;
      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['via'])
        .where('action', '=', 'base.exported')
        .where('entity_id', '=', jobId)
        .executeTakeFirstOrThrow();
      expect(audit.via).toEqual({ api_token_id: tk.pkg_x.id });
      expect((await jobOf(jobId)).status).toBe('succeeded');
    });

    const missing = [
      ['no_schema', ['schema:read']],
      ['no_automations', ['automations:read']],
      ['no_records', ['records:read']],
      ['none', ['records:read']],
    ] as const;
    for (const [token, required] of missing) {
      it(`P119 token without ${required.join(', ')} → 403 INSUFFICIENT_SCOPE listing it`, async () => {
        const response = await bearer(tk[token], 'POST', `/bases/${fx.baseId}/export`);
        expectProblem(response, 403, 'INSUFFICIENT_SCOPE');
        expect(response.json<{ errors: { params: unknown }[] }>().errors[0]?.params).toEqual({
          required,
        });
      });
    }

    it('P119 tk_sales_r (u_sales1, records:read + schema:read) → 403 INSUFFICIENT_SCOPE', async () => {
      const response = await bearer(tk.sales_r, 'POST', `/bases/${fx.baseId}/export`);
      expectProblem(response, 403, 'INSUFFICIENT_SCOPE');
      expect(response.json<{ errors: { params: unknown }[] }>().errors[0]?.params).toEqual({
        required: ['automations:read'],
      });
    });

    it('P119 a token lacking both per-request scopes gets both listed', async () => {
      const token = await createToken('u_admin', ['records:read']);
      const response = await bearer(token, 'POST', `/bases/${fx.baseId}/export`);
      expectProblem(response, 403, 'INSUFFICIENT_SCOPE');
      expect(response.json<{ errors: { params: unknown }[] }>().errors[0]?.params).toEqual({
        required: ['schema:read', 'automations:read'],
      });
    });

    it('P119 an unknown option in the body → 422', async () => {
      expectProblem(
        await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/export`, { structure_only: true }),
        422,
        'VALIDATION_FAILED',
      );
    });
  });

  describe('P121 — GET /jobs/:id and GET /files/exports/:jobId of base.export', () => {
    let jobId: Id<'job'>;
    let downloadPath: string;

    beforeAll(async () => {
      await startWorker();
      jobId = await exportAs('u_admin', base2);
      const job = await finishedJob(() => fx.call('u_admin', 'GET', `/jobs/${jobId}`));
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      const result = baseExportResultSchema.parse(job.result);
      expect(result).toMatchObject({
        download_url: `/api/v1/files/exports/${jobId}`,
        skipped_personal_views: 0,
        counts: { tables: 0, records: 0 },
      });
      downloadPath = (result.download_url ?? '').replace('/api/v1', '');
    });

    it('P121 the creator while base admin → 200 and 302 to "<base name>.chbase"', async () => {
      expect((await fx.call('u_admin', 'GET', `/jobs/${jobId}`)).statusCode).toBe(200);
      const redirect = await fx.call('u_admin', 'GET', downloadPath);
      expect(redirect.statusCode).toBe(302);
      const location = new URL(redirect.headers.location as string);
      const file = await t.app.inject({
        method: 'GET',
        url: `${location.pathname}${location.search}`,
      });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-disposition']).toContain('B2.chbase');
      const path = join(tempRoot, '..', `p121-${jobId}.chbase`);
      await writeFile(path, file.rawPayload);
      const reader = await openBasePackage(path);
      try {
        await reader.verifyAll();
        expect(reader.manifest.base).toEqual({ id: base2, name: 'B2' });
        expect(reader.manifest.exported_by_email).toBe(fx.users.u_admin.email);
      } finally {
        reader.close();
        await rm(path, { force: true });
      }
    });

    it('P121 the org owner/admin → 200 and 302', async () => {
      expect((await fx.call('owner', 'GET', `/jobs/${jobId}`)).statusCode).toBe(200);
      expect((await fx.call('owner', 'GET', downloadPath)).statusCode).toBe(302);
    });

    it('P121 u_editor and another organization → 404', async () => {
      for (const user of ['u_editor', 'stranger'] as const) {
        expectProblem(await fx.call(user, 'GET', `/jobs/${jobId}`), 404, 'NOT_FOUND');
        expectProblem(await fx.call(user, 'GET', downloadPath), 404, 'NOT_FOUND');
      }
    });

    it("P121 the creator's token reaching the base → 200; outside base_ids → 404", async () => {
      expect((await bearer(tk.admin_b2, 'GET', `/jobs/${jobId}`)).statusCode).toBe(200);
      const outside = await createToken('u_admin', EXPORT_SCOPES, [fx.baseId]);
      expectProblem(await bearer(outside, 'GET', `/jobs/${jobId}`), 404, 'NOT_FOUND');
      expectProblem(await bearer(outside, 'GET', downloadPath), 404, 'NOT_FOUND');
    });

    it('P121 the creator demoted from base admin → 404; the org owner still 200', async () => {
      const removed = await fx.call('owner', 'DELETE', `/bases/${base2}/role-assignments`, {
        principal_type: 'user',
        principal_id: fx.users.u_admin.id,
      });
      expect(removed.statusCode, removed.body).toBeLessThan(300);
      expectProblem(await fx.call('u_admin', 'GET', `/jobs/${jobId}`), 404, 'NOT_FOUND');
      expectProblem(await fx.call('u_admin', 'GET', downloadPath), 404, 'NOT_FOUND');
      expect((await fx.call('owner', 'GET', `/jobs/${jobId}`)).statusCode).toBe(200);
    });

    it('P121 after one hour exports.cleanup deletes the package: file_deleted, 404', async () => {
      const key = basePackageKey(fx.orgId, jobId);
      expect(await storage.head(key)).not.toBeNull();
      const cleanup = createExportsCleanupTask({
        db,
        jobs: new JobsRepository(db),
        storage,
        logger: captureLogger().logger,
        now: () => new Date(Date.now() + 3_601_000),
      });
      await cleanup({}, {} as never);
      expect(await storage.head(key)).toBeNull();
      const job = jobSchema.parse((await fx.call('owner', 'GET', `/jobs/${jobId}`)).json());
      expect(job.result).toMatchObject({ file_deleted: true });
      expect(job.result).not.toHaveProperty('download_url');
      expectProblem(await fx.call('owner', 'GET', downloadPath), 404, 'NOT_FOUND');
    });
  });

  describe('one export per organization at a time', () => {
    it('a second export waits until the first is done', async () => {
      await startWorker();
      const first = await exportAs('u_admin');
      const second = await exportAs('owner');
      const [a, b] = await Promise.all([jobOf(first), jobOf(second)]);
      expect([a.status, b.status]).toEqual(['succeeded', 'succeeded']);
      // Never both running: the second started after the first finished.
      const rows = await db.kysely
        .selectFrom('meta.jobs')
        .select(['id', 'started_at', 'finished_at'])
        .where('id', 'in', [first, second])
        .execute();
      const [x, y] = [...rows].sort(
        (left, right) => (left.started_at?.getTime() ?? 0) - (right.started_at?.getTime() ?? 0),
      );
      expect((y?.started_at?.getTime() ?? 0) >= (x?.finished_at?.getTime() ?? 0)).toBe(true);
    });
  });

  describe('cellhive base export', () => {
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

    async function cli(...argv: string[]) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(argv, env(), {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      });
      return { code, out, err };
    }

    it('writes the package into a new file, as the system, and removes the stored copy', async () => {
      await startWorker();
      const out = join(tempRoot, '..', `cli-${String(Date.now())}.chbase`);
      try {
        const run = await cli('base', 'export', '--base', fx.baseId, '--out', out);
        expect(run.code, run.err.join('\n')).toBe(0);
        const [jobId, json] = run.out;
        expect(jobId).toMatch(/^job_[0-9A-Za-z]{16}$/u);
        const result = JSON.parse(json ?? '{}') as Record<string, unknown>;
        expect(result).toMatchObject({
          path: out,
          size: (await stat(out)).size,
          counts: { tables: 3, records: 3 },
          skipped_personal_views: 0,
        });
        expect(result).not.toHaveProperty('download_url');
        const reader = await openBasePackage(out);
        try {
          await reader.verifyAll();
          expect(reader.manifest.base.id).toBe(fx.baseId);
          expect(reader.manifest.exported_by_email).toBeNull();
          expect(reader.manifest.counts).toEqual(result['counts']);
        } finally {
          reader.close();
        }
        const job = await db.kysely
          .selectFrom('meta.jobs')
          .selectAll()
          .where('id', '=', jobId as Id<'job'>)
          .executeTakeFirstOrThrow();
        expect(job).toMatchObject({ type: BASE_EXPORT_JOB_TYPE, created_by: null });
        expect(job.result).toMatchObject({ file_deleted: true });
        const audit = await db.kysely
          .selectFrom('meta.audit_logs')
          .select(['actor_type', 'base_id'])
          .where('action', '=', 'base.exported')
          .where('entity_id', '=', jobId as Id<'job'>)
          .executeTakeFirstOrThrow();
        expect(audit).toEqual({ actor_type: 'system', base_id: fx.baseId });
        expect(await storage.head(basePackageKey(fx.orgId, jobId as Id<'job'>))).toBeNull();

        // Never overwrites a file; an unknown base or a bad name is refused before anything.
        const again = await cli('base', 'export', '--base', fx.baseId, '--out', out);
        expect(again.code).toBe(1);
        expect(again.err.join('\n')).toContain('already exists');
        const unknown = await cli(
          'base',
          'export',
          '--base',
          newId('bse'),
          '--out',
          `${out}.x.chbase`,
        );
        expect(unknown.code).toBe(1);
        const bad = await cli('base', 'export', '--base', fx.baseId, '--out', 'x.zip');
        expect(bad.code).toBe(2);
      } finally {
        await rm(out, { force: true });
      }
    });
  });

  describe('JobsRepository.baseIdOf (tenant)', () => {
    it('names the exported base in its organization only', async () => {
      const jobId = await exportAs('u_admin');
      await jobOf(jobId);
      const jobs = new JobsRepository(db);
      expect(await jobs.baseIdOf(orgScope(fx.orgId), jobId)).toBe(fx.baseId);
      const other = await db.kysely
        .selectFrom('meta.organizations')
        .select('id')
        .where('id', '!=', fx.orgId)
        .executeTakeFirstOrThrow();
      expect(await jobs.baseIdOf(orgScope(other.id), jobId)).toBeNull();
    });
  });
});

/** The methods of a source, bound, to spread into a wrapper. */
function bind(source: BaseExportSource): BaseExportSource {
  return {
    schema: () => source.schema(),
    memberEmails: () => source.memberEmails(),
    openRecords: (tableId) => source.openRecords(tableId),
    cellFiles: (tableId, ids) => source.cellFiles(tableId, ids),
    formCovers: (ids) => source.formCovers(ids),
    emailAssets: (ids) => source.emailAssets(ids),
    detachedNames: (refs) => source.detachedNames(refs),
    openFile: (object) => source.openFile(object),
  };
}
