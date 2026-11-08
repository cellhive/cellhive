import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BASE_EXPORT_JOB_TYPE,
  BASE_PACKAGE_DOWNLOAD_TTL_SECONDS,
  BASE_PACKAGE_MEDIA_TYPE,
  idOf,
  problemTitle,
  problemTypeUri,
  type BaseExportResult,
  type Id,
} from '@cellhive/contracts';
import {
  acquireOrgSlot,
  AppError,
  basePackageKey,
  countRunningJobsOf,
  DbBaseExportSource,
  deferrableJob,
  exportBasePackage,
  exportDownloadPath,
  orgScope,
  UsersRepository,
  type BaseExportSource,
  type BasePackageLimits,
  type Db,
  type JobProblem,
  type JobsRepository,
  type JsonObject,
  type RecordQueryService,
  type StorageDriver,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Base exports running at once per organization (ADR-18 `acquireOrgSlot`, CONTRACTS §12.2). */
export const BASE_EXPORT_ORG_CAP = 1;

const payloadSchema = z.object({
  organization_id: idOf('org'),
  job_id: idOf('job'),
  base_id: idOf('bse'),
});

export interface BaseExportDeps {
  readonly db: Db;
  readonly jobs: JobsRepository;
  readonly storage: Pick<StorageDriver, 'putStream' | 'getStream' | 'delete'>;
  /** Reads the records (with a job statement timeout). */
  readonly records: RecordQueryService;
  readonly logger: Logger;
  /** Caps of `BASE_PACKAGE_MAX_BYTES` (`basePackageLimits(config.limits.basePackageMaxBytes)`). */
  readonly limits: BasePackageLimits;
  /** Zone of the system read context (`defaults.timezone`). */
  readonly timeZone: string;
  /** Where the package is spooled before it is stored (default: the OS temporary directory). */
  readonly tempRoot?: string;
  /** `app_version` of the manifest: the version of the running build (`config.version`). */
  readonly appVersion: string;
  readonly now?: () => Date;
  /** Tests only: the source of the base instead of the database and storage. */
  readonly source?: (organizationId: Id<'org'>, baseId: Id<'bse'>) => BaseExportSource;
}

/** The temporary directory of one export job: the same on every attempt, so a retry removes it. */
export function baseExportTempDir(root: string, jobId: Id<'job'>): string {
  return join(root, `cellhive-base-export-${jobId}`);
}

/** `error` of a failed export: its own problem for a package cap or a lost base, else `INTERNAL`. */
function problemOf(error: unknown): JobProblem {
  if (
    error instanceof AppError &&
    ['VALIDATION_FAILED', 'INVALID_PACKAGE', 'NOT_FOUND'].includes(error.code)
  ) {
    return {
      type: problemTypeUri(error.code),
      title: problemTitle(error.code),
      status: error.status,
      code: error.code,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.errors === undefined
        ? {}
        : { errors: error.errors.map((item) => ({ ...item }) as unknown as JsonObject) }),
    };
  }
  return interrupted('The export failed; start a new one.');
}

function interrupted(detail: string): JobProblem {
  return {
    type: problemTypeUri('INTERNAL'),
    title: problemTitle('INTERNAL'),
    status: 500,
    code: 'INTERNAL',
    detail,
  };
}

/**
 * `base.export` (CONTRACTS §12.2): enqueued by `POST /bases/:id/export` (and
 * `cellhive base export`) with its `meta.jobs` row and `base.exported`. One
 * export per organization runs at a time; others are deferred (ADR-18).
 *
 * The package is written by `exportBasePackage` into a file of a temporary
 * directory of the job, then stored with one `putStream` of its exact
 * length under `{org}/base-export-{job}.chbase`; the result carries the
 * download link (one hour), the size and the counts. The temporary
 * directory is removed in every case, before the job reads as final. A failure — a package over
 * `BASE_PACKAGE_MAX_BYTES` (`VALIDATION_FAILED` `PACKAGE_TOO_LARGE`), a cap
 * of the format (`INVALID_PACKAGE` `ARCHIVE_LIMIT_EXCEEDED`), anything
 * else (`INTERNAL`) — marks the job `failed` and deletes the stored object,
 * never retried. A job found `running` was interrupted (the worker
 * stopped): what the attempt left (temporary directory, stored object) is
 * removed and the job fails instead of running twice.
 *
 * Logs carry ids, counts and sizes, never names or values.
 */
export function createBaseExportTask(deps: BaseExportDeps): Task<'base.export'> {
  const tempRoot = deps.tempRoot ?? tmpdir();
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error({ job_id: helpers.job.id }, 'base.export: malformed payload, skipped');
      return;
    }
    const { organization_id: orgId, job_id: jobId, base_id: baseId } = parsed.data;
    const scope = orgScope(orgId);
    const context = { job_id: helpers.job.id, org_id: orgId, export_job_id: jobId };
    const dir = baseExportTempDir(tempRoot, jobId);
    const key = basePackageKey(orgId, jobId);
    const job = await deferrableJob(helpers);

    const state = await deps.db.withTx(async (tx) => {
      const txScope = orgScope(orgId, tx);
      const current = await deps.jobs.getById(txScope, jobId);
      if (current === undefined || current.type !== BASE_EXPORT_JOB_TYPE) return 'skip';
      if (current.status === 'running') return 'interrupted';
      if (current.status !== 'queued') return 'skip';
      const slot = await acquireOrgSlot(tx, {
        orgId,
        kind: BASE_EXPORT_JOB_TYPE,
        cap: BASE_EXPORT_ORG_CAP,
        countRunning: countRunningJobsOf(deps.jobs, BASE_EXPORT_JOB_TYPE),
        job,
      });
      if (!slot.acquired) return 'deferred';
      const running = await deps.jobs.markRunning(txScope, jobId);
      return running === undefined ? 'skip' : { createdBy: running.created_by };
    });
    if (state === 'interrupted') {
      await rm(dir, { recursive: true, force: true });
      await deps.storage.delete(key);
      await deps.jobs.markFailed(
        scope,
        jobId,
        interrupted('The export stopped before it finished; start a new one.'),
      );
      deps.logger.warn(context, 'base.export interrupted');
      return;
    }
    if (typeof state === 'string') {
      deps.logger.info({ ...context, state }, 'base.export: not run now');
      return;
    }

    const started = Date.now();
    try {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, 'package.chbase');
      const exportedBy =
        state.createdBy === null
          ? undefined
          : await new UsersRepository(deps.db).findById(state.createdBy);
      const source =
        deps.source?.(orgId, baseId) ??
        new DbBaseExportSource(
          {
            db: deps.db,
            records: deps.records,
            storage: deps.storage,
            timeZone: deps.timeZone,
          },
          scope,
          baseId,
        );
      const exported = await exportBasePackage(source, {
        path,
        tempDir: dir,
        limits: deps.limits,
        appVersion: deps.appVersion,
        exportedAt: deps.now?.() ?? new Date(),
        exportedByEmail: exportedBy?.email ?? null,
        onProgress: async (progress) => {
          await deps.jobs.setProgress(scope, jobId, progress);
        },
      });
      await deps.storage.putStream(key, createReadStream(path), {
        contentType: BASE_PACKAGE_MEDIA_TYPE,
        contentLength: exported.bytes,
      });
      // Cleaned up before the job reads as final.
      await rm(dir, { recursive: true, force: true });
      const finishedAt = deps.now?.() ?? new Date();
      const result: BaseExportResult = {
        download_url: exportDownloadPath(jobId),
        expires_at: new Date(
          finishedAt.getTime() + BASE_PACKAGE_DOWNLOAD_TTL_SECONDS * 1000,
        ).toISOString(),
        size: exported.bytes,
        counts: exported.counts,
        skipped_personal_views: exported.skippedPersonalViews,
      };
      if ((await deps.jobs.markSucceeded(scope, jobId, result as JsonObject)) === undefined) {
        // No longer running (cancelled or failed meanwhile): nothing to download.
        await deps.storage.delete(key);
      }
      deps.logger.info(
        {
          ...context,
          size: exported.bytes,
          uncompressed: exported.uncompressedBytes,
          ...exported.counts,
          duration_ms: Date.now() - started,
        },
        'base exported',
      );
    } catch (err) {
      const problem = problemOf(err);
      deps.logger.error(
        { ...context, err, code: problem.code, duration_ms: Date.now() - started },
        'base.export failed',
      );
      // The temporary directory and the stored object go before the job reads as failed.
      await rm(dir, { recursive: true, force: true });
      await deps.storage.delete(key).catch((error: unknown) => {
        deps.logger.warn({ ...context, err: error }, 'base.export: stored package not deleted');
      });
      await deps.jobs.markFailed(scope, jobId, problem);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
