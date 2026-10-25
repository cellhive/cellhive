import { auditLogFiltersSchema, idOf, type Id } from '@cellhive/contracts';
import {
  acquireOrgSlot,
  AUDIT_BASE_EXPORT_JOB_TYPE,
  AUDIT_EXPORT_JOB_TYPE,
  AUDIT_EXPORT_JOB_TYPES,
  countRunningJobsOf,
  deferrableJob,
  OrgMembersRepository,
  orgScope,
  writeAuditExport,
  type AuditViewer,
  type Db,
  type JobsRepository,
  type StorageDriver,
  type Tx,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

const payloadSchema = z.object({
  organization_id: idOf('org'),
  job_id: idOf('job'),
  // The export body's filters (CONTRACTS §11.4); a single string is one
  // value of a repeatable filter, as queued before T709.
  filters: auditLogFiltersSchema,
});

/**
 * Audit exports (organization and base, T709) running at once per
 * organization (ADR-18 `acquireOrgSlot`).
 */
export const AUDIT_EXPORT_ORG_CAP = 1;

/** Running audit exports of the organization, of every audit export type. */
function countRunningAuditExports(jobs: JobsRepository) {
  return async (tx: Tx, orgId: Id<'org'>): Promise<number> => {
    let running = 0;
    for (const type of AUDIT_EXPORT_JOB_TYPES) {
      running += await countRunningJobsOf(jobs, type)(tx, orgId);
    }
    return running;
  };
}

export interface AuditExportDeps {
  readonly db: Db;
  readonly jobs: JobsRepository;
  readonly storage: Pick<StorageDriver, 'put'>;
  readonly logger: Logger;
}

/**
 * `audit.export` (CONTRACTS §11.4): enqueued by `POST /orgs/:id/audit-logs/export`
 * (`audit.export` job) and `POST /bases/:id/audit-logs/export`
 * (`audit.base_export` job, `filters.base_id` = the base) together with
 * its `meta.jobs` row. One audit export per organization runs at a time,
 * whatever its type (others are deferred, ADR-18). The CSV goes to object storage and the
 * job result carries the download link (CONTRACTS §12.2).
 *
 * A malformed payload or a job that is gone or already final completes
 * without work. A failure marks the job `failed` with a problem document
 * (never a stack trace) instead of retrying: the user starts a new export.
 * Logs carry counters only, never audit values.
 */
export function createAuditExportTask(deps: AuditExportDeps): Task<'audit.export'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error({ job_id: helpers.job.id }, 'audit.export: malformed payload, skipped');
      return;
    }
    const { organization_id: orgId, job_id: jobId, filters } = parsed.data;
    const context = { job_id: helpers.job.id, org_id: orgId, export_job_id: jobId };
    const scope = orgScope(orgId);
    const job = await deferrableJob(helpers);

    let viewer: AuditViewer = { userId: null, isOrgAdmin: false };
    const state = await deps.db.withTx(async (tx) => {
      const txScope = orgScope(orgId, tx);
      const current = await deps.jobs.getById(txScope, jobId);
      if (current === undefined || !['queued', 'running'].includes(current.status)) return 'skip';
      // The `via` column shows API tokens as its creator may see them (S6 decision #19).
      const role =
        current.created_by === null
          ? undefined
          : await new OrgMembersRepository(deps.db).roleOf(txScope, current.created_by);
      viewer = {
        userId: current.created_by,
        isOrgAdmin: role === 'owner' || role === 'admin',
      };
      // Never more than the job's own scope: a base export always names its base.
      if (!AUDIT_EXPORT_JOB_TYPES.includes(current.type)) return 'skip';
      if (current.type === AUDIT_BASE_EXPORT_JOB_TYPE && filters.base_id === undefined) {
        return 'skip';
      }
      // A retry after a crash finds its own row running already: continue it.
      if (current.status === 'running') return 'run';
      const slot = await acquireOrgSlot(tx, {
        orgId,
        // One lock and one count for both audit export types.
        kind: AUDIT_EXPORT_JOB_TYPE,
        cap: AUDIT_EXPORT_ORG_CAP,
        countRunning: countRunningAuditExports(deps.jobs),
        job,
      });
      if (!slot.acquired) return 'deferred';
      return (await deps.jobs.markRunning(txScope, jobId)) === undefined ? 'skip' : 'run';
    });
    if (state !== 'run') {
      deps.logger.info({ ...context, state }, 'audit.export: not run now');
      return;
    }

    const started = Date.now();
    try {
      const result = await writeAuditExport(
        {
          db: deps.db,
          storage: deps.storage,
          onProgress: async (progress) => {
            await deps.jobs.setProgress(scope, jobId, progress);
          },
        },
        scope,
        jobId,
        filters,
        viewer,
      );
      await deps.jobs.markSucceeded(scope, jobId, result);
      deps.logger.info(
        {
          ...context,
          rows: result.rows,
          size: result.size,
          truncated: result.truncated,
          duration_ms: Date.now() - started,
        },
        'audit log exported',
      );
    } catch (err) {
      deps.logger.error({ ...context, err }, 'audit.export failed');
      await deps.jobs.markFailed(scope, jobId, {
        type: 'https://cellhive.io/errors/INTERNAL',
        title: 'Internal error',
        status: 500,
        code: 'INTERNAL',
        detail: 'The export failed; start a new one.',
      });
    }
  };
}
