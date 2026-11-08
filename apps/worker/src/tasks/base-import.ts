import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  BASE_IMPORT_JOB_TYPE,
  idOf,
  problemTitle,
  problemTypeUri,
  type Id,
} from '@cellhive/contracts';
import {
  acquireOrgSlot,
  AppError,
  BASE_IMPORT_STEPS,
  BaseImportStopped,
  basePackageImportKey,
  countRunningJobsOf,
  DbBaseImportTarget,
  deferrableJob,
  importBasePackage,
  mayCreateBaseIn,
  openBasePackage,
  orgScope,
  purgeBaseImport,
  WorkspacesRepository,
  type AuditContext,
  type BaseImportExtension,
  type BaseImportSchemaMethods,
  type BaseImportTarget,
  type BasePackageLimits,
  type Db,
  type JobProblem,
  type JobsRepository,
  type JsonObject,
  type RecordMutationService,
  type SchemaService,
  type StorageDriver,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Base imports running at once per organization (ADR-18 `acquireOrgSlot`, CONTRACTS §12.2). */
export const BASE_IMPORT_ORG_CAP = 1;

const payloadSchema = z.object({
  organization_id: idOf('org'),
  job_id: idOf('job'),
  workspace_id: idOf('wsp'),
  api_token_id: idOf('tok').optional(),
});

export interface BaseImportDeps {
  readonly db: Db;
  readonly jobs: JobsRepository;
  readonly storage: Pick<StorageDriver, 'getStream' | 'putStream' | 'delete'>;
  /** Builds and purges the hidden base. */
  readonly schema: Pick<SchemaService, BaseImportSchemaMethods>;
  /** Loads its records and computes its formula/lookup columns (with a job statement timeout). */
  readonly records: Pick<RecordMutationService, 'loadPackageBatch' | 'backfillComputedBatch'>;
  readonly logger: Logger;
  /** Caps of `BASE_PACKAGE_MAX_BYTES` (`basePackageLimits(config.limits.basePackageMaxBytes)`). */
  readonly limits: BasePackageLimits;
  /** `MAX_FIELDS_PER_TABLE`. */
  readonly maxFieldsPerTable: number;
  /** `ATTACHMENT_MAX_FILE_BYTES`. */
  readonly maxFileBytes: number;
  /** Where the package is copied before it is read (default: the OS temporary directory). */
  readonly tempRoot?: string;
  /**
   * What the import creates once the records are loaded (computed fields,
   * AI options, views, dashboards, roles, automations…; default:
   * `BASE_IMPORT_STEPS`, T1019). Tests may replace them.
   */
  readonly extensions?: readonly BaseImportExtension[];
  /** Tests only: wraps the target (to fail at a chosen step). */
  readonly target?: (target: BaseImportTarget) => BaseImportTarget;
}

/** The temporary directory of one import job: the same on every attempt, so a retry removes it. */
export function baseImportTempDir(root: string, jobId: Id<'job'>): string {
  return join(root, `cellhive-base-import-${jobId}`);
}

/** Codes of a failed import kept as they are; anything else is `INTERNAL`. */
const OWN_PROBLEMS: ReadonlySet<string> = new Set([
  'INVALID_PACKAGE',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'PERMISSION_DENIED',
]);

function problemOf(error: unknown): JobProblem {
  if (error instanceof AppError && OWN_PROBLEMS.has(error.code)) {
    return {
      type: problemTypeUri(error.code),
      title: problemTitle(error.code),
      status: error.status,
      code: error.code,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.errors === undefined
        ? {}
        : { errors: error.errors.map((item) => ({ ...item }) as unknown as JsonObject) }),
      ...(error.params === undefined ? {} : { params: { ...error.params } as JsonObject }),
    };
  }
  return internal('The import failed; start a new one.');
}

function internal(detail: string): JobProblem {
  return {
    type: problemTypeUri('INTERNAL'),
    title: problemTitle('INTERNAL'),
    status: 500,
    code: 'INTERNAL',
    detail,
  };
}

/**
 * `base.import` (CONTRACTS §12.2): enqueued by `POST
 * /workspaces/:id/bases/import` (and `cellhive base import`) with its
 * `meta.jobs` row, once the package is stored under
 * `{org}/base-import-{job}.chbase`. One import per organization runs at a
 * time; others are deferred (ADR-18).
 *
 * The package is copied into a temporary directory of the job and read
 * there by the bounded reader; the importer (the job's creator) must still
 * be able to create a base in the workspace. `importBasePackage` checks the
 * whole package, builds the base hidden — tables, fields, links, files,
 * records, then (`BASE_IMPORT_STEPS`) formula and lookup fields with their
 * values, AI options, shared views, form covers, dashboards, custom roles
 * and automations, all off — then makes it visible with the job's success
 * in one transaction. Any failure — an invalid package
 * (`INVALID_PACKAGE`), a cancelled job, anything else (`INTERNAL`) — purges
 * the hidden base (data tables, meta rows, stored files) and marks the job
 * `failed` (a cancelled job keeps its status); nothing is retried or
 * resumed. A job found `running` was interrupted (the worker stopped): its
 * base is purged and it fails. The temporary directory and the stored
 * package are removed when the job ends, whatever the outcome.
 *
 * Logs carry ids, counts and codes, never names or values of the package.
 */
export function createBaseImportTask(deps: BaseImportDeps): Task<'base.import'> {
  const tempRoot = deps.tempRoot ?? tmpdir();
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error({ job_id: helpers.job.id }, 'base.import: malformed payload, skipped');
      return;
    }
    const { organization_id: orgId, job_id: jobId, workspace_id: workspaceId } = parsed.data;
    const scope = orgScope(orgId);
    const context = { job_id: helpers.job.id, org_id: orgId, import_job_id: jobId };
    const dir = baseImportTempDir(tempRoot, jobId);
    const key = basePackageImportKey(orgId, jobId);
    const job = await deferrableJob(helpers);
    const removePackage = async () => {
      await rm(dir, { recursive: true, force: true });
      await deps.storage.delete(key).catch((error: unknown) => {
        deps.logger.warn({ ...context, err: error }, 'base.import: stored package not deleted');
      });
    };

    const state = await deps.db.withTx(async (tx) => {
      const txScope = orgScope(orgId, tx);
      const current = await deps.jobs.getById(txScope, jobId);
      if (current === undefined || current.type !== BASE_IMPORT_JOB_TYPE) return 'skip';
      if (current.status === 'running') return 'interrupted';
      if (current.status !== 'queued') return 'skip';
      const slot = await acquireOrgSlot(tx, {
        orgId,
        kind: BASE_IMPORT_JOB_TYPE,
        cap: BASE_IMPORT_ORG_CAP,
        countRunning: countRunningJobsOf(deps.jobs, BASE_IMPORT_JOB_TYPE),
        job,
      });
      if (!slot.acquired) return 'deferred';
      const running = await deps.jobs.markRunning(txScope, jobId);
      return running === undefined ? 'skip' : { createdBy: running.created_by };
    });
    if (state === 'interrupted') {
      // Never resumed: what the attempt that stopped built goes, then the job fails.
      await purgeBaseImport(deps, scope, jobId);
      await removePackage();
      await deps.jobs.markFailed(
        scope,
        jobId,
        internal('The import stopped before it finished; start a new one.'),
      );
      deps.logger.warn(context, 'base.import interrupted');
      return;
    }
    if (typeof state === 'string') {
      if (state === 'skip') {
        // A job cancelled or failed before it ran leaves nothing behind.
        await purgeBaseImport(deps, scope, jobId);
        await removePackage();
      }
      deps.logger.info({ ...context, state }, 'base.import: not run now');
      return;
    }

    const started = Date.now();
    try {
      const importerId = state.createdBy;
      if ((await new WorkspacesRepository(deps.db).getById(scope, workspaceId)) === undefined) {
        throw new AppError('NOT_FOUND', { detail: 'The workspace no longer exists.' });
      }
      if (
        importerId === null ||
        !(await mayCreateBaseIn(deps.db, scope, importerId, workspaceId))
      ) {
        throw new AppError('PERMISSION_DENIED', {
          detail: 'The importer can no longer create bases in this workspace.',
        });
      }
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, 'package.chbase');
      const body = await deps.storage.getStream(key);
      if (body === null) {
        throw new AppError('NOT_FOUND', {
          detail: 'The uploaded package is gone; upload it again.',
        });
      }
      await pipeline(body, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
      const reader = await openBasePackage(path, { limits: deps.limits });
      try {
        const auditContext: AuditContext = {
          actor: { type: 'user', id: importerId },
          via:
            parsed.data.api_token_id === undefined
              ? null
              : { api_token_id: parsed.data.api_token_id },
          batch_id: jobId,
          request_id: null,
          ip: null,
          user_agent: null,
        };
        const own = new DbBaseImportTarget(
          { db: deps.db, schema: deps.schema, records: deps.records, storage: deps.storage },
          scope,
          { jobId, workspaceId, importerId, context: auditContext },
        );
        const result = await importBasePackage(reader, deps.target?.(own) ?? own, {
          maxFieldsPerTable: deps.maxFieldsPerTable,
          maxFileBytes: deps.maxFileBytes,
          extensions: deps.extensions ?? BASE_IMPORT_STEPS,
        });
        deps.logger.info(
          {
            ...context,
            base_id: result.base_id,
            tables: result.report.tables,
            fields: result.report.fields,
            records: result.report.records,
            links: result.report.links,
            attachments: result.report.attachments,
            views: result.report.views,
            dashboards: result.report.dashboards,
            roles: result.report.roles,
            automations: result.report.automations,
            files_skipped: result.report.files_skipped.length,
            unmatched_users: result.report.unmatched_users,
            duration_ms: Date.now() - started,
          },
          'base imported',
        );
      } finally {
        reader.close();
      }
    } catch (err) {
      // A purge that fails throws: graphile-worker runs the job again, which purges first.
      await purgeBaseImport(deps, scope, jobId);
      if (err instanceof BaseImportStopped) {
        deps.logger.info({ ...context, duration_ms: Date.now() - started }, 'base.import stopped');
        return;
      }
      const problem = problemOf(err);
      deps.logger.error(
        {
          ...context,
          ...(problem.code === 'INTERNAL' ? { err } : {}),
          code: problem.code,
          duration_ms: Date.now() - started,
        },
        'base.import failed',
      );
      await deps.jobs.markFailed(scope, jobId, problem);
    } finally {
      await removePackage();
    }
  };
}
