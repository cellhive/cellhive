import { idOf, RECORD_TRASH_RETENTION_DAYS, type Id } from '@cellhive/contracts';
import {
  acquireOrgSlot,
  AppError,
  countRunningJobsOf,
  deferrableJob,
  enqueue,
  isRetryableDdlError,
  listOrganizationsWithTables,
  orgScope,
  systemAuditContext,
  type Db,
  type JobsRepository,
  type RecordMutationService,
  type TablesRepository,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** `meta.jobs.type` of a per-organization purge run (counted by the org slot). */
export const RECORDS_PURGE_JOB_TYPE = 'records.purge';
/** Purge runs of one organization at once (ADR-18 `acquireOrgSlot`). */
export const RECORDS_PURGE_ORG_CAP = 1;
/** Organizations listed per page by the daily fan-out. */
export const RECORDS_PURGE_FANOUT_PAGE = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

const payloadSchema = z.object({ organization_id: idOf('org'), job_id: idOf('job') });

export interface RecordsPurgeDeps {
  readonly db: Db;
  readonly jobs: JobsRepository;
  readonly logger: Logger;
}

/**
 * `records.purge` (daily cron, T408; CONTRACTS §12.2): starts one
 * `records.purge_org` job per organization with tables, with its
 * `meta.jobs` row (system job), in one transaction per organization. An
 * organization whose previous run is still queued or running gets none
 * (idempotent: a missed or repeated cron run changes nothing). Logs counts
 * only.
 */
export function createRecordsPurgeTask(deps: RecordsPurgeDeps): Task<'records.purge'> {
  return async () => {
    const started = Date.now();
    let enqueued = 0;
    let skipped = 0;
    let after: Id<'org'> | null = null;
    for (;;) {
      const page = await listOrganizationsWithTables(deps.db.kysely, {
        after,
        limit: RECORDS_PURGE_FANOUT_PAGE,
      });
      for (const organizationId of page) {
        const created = await deps.db.withTx(async (tx) => {
          const scope = orgScope(organizationId, tx);
          if ((await deps.jobs.findActive(scope, RECORDS_PURGE_JOB_TYPE)) !== undefined) {
            return false;
          }
          const job = await deps.jobs.create(scope, {
            type: RECORDS_PURGE_JOB_TYPE,
            createdBy: null,
          });
          await enqueue(
            tx,
            'records.purge_org',
            { organization_id: organizationId, job_id: job.id },
            { jobKey: `records.purge:${organizationId}`, maxAttempts: 5 },
          );
          return true;
        });
        if (created) enqueued += 1;
        else skipped += 1;
      }
      after = page.at(-1) ?? null;
      if (page.length < RECORDS_PURGE_FANOUT_PAGE) break;
    }
    deps.logger.info(
      { enqueued, skipped, duration_ms: Date.now() - started },
      'records purge jobs started',
    );
  };
}

export interface RecordsPurgeOrgDeps {
  readonly db: Db;
  readonly records: Pick<RecordMutationService, 'purgeExpired'>;
  readonly tables: Pick<TablesRepository, 'listIds'>;
  readonly jobs: JobsRepository;
  readonly logger: Logger;
  readonly now?: () => Date;
  /** Records per batch; default `RECORD_PURGE_BATCH_SIZE` (500). */
  readonly batchSize?: number;
}

function retryable(error: unknown): boolean {
  return (
    (error instanceof AppError && error.code === 'SCHEMA_LOCKED') || isRetryableDdlError(error)
  );
}

/**
 * `records.purge_org` (T408; ADR-23 §2, SPEC §5.4): permanently deletes the
 * records of one organization trashed more than 30 days ago, table by
 * table (trash included), in batches of `RecordMutationService.purgeExpired`
 * — each its own transaction under `statement_timeout`, with one
 * `record.purged` summary audit entry (`batch_id` = the job) — until no
 * record is past the cutoff. One run per organization at a time (ADR-18:
 * a second one is deferred); a run found `running` (worker restarted)
 * resumes, and committed batches are never redone (the cutoff query finds
 * what is left). A table whose schema is busy is skipped until the next
 * day; any other failure marks the run `failed` and is retried by the next
 * cron. Logs ids and counts only.
 */
export function createRecordsPurgeOrgTask(deps: RecordsPurgeOrgDeps): Task<'records.purge_org'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error(
        { job_id: helpers.job.id },
        'records.purge_org: malformed payload, skipped',
      );
      return;
    }
    const data = parsed.data;
    const scope = orgScope(data.organization_id);
    const context = { job_id: data.job_id, org_id: data.organization_id };
    const job = await deferrableJob(helpers);
    const state = await deps.db.withTx(async (tx) => {
      const txScope = orgScope(data.organization_id, tx);
      const current = await deps.jobs.getById(txScope, data.job_id);
      if (current === undefined || !['queued', 'running'].includes(current.status)) return 'skip';
      if (current.status === 'running') return 'resume';
      const slot = await acquireOrgSlot(tx, {
        orgId: data.organization_id,
        kind: RECORDS_PURGE_JOB_TYPE,
        cap: RECORDS_PURGE_ORG_CAP,
        countRunning: countRunningJobsOf(deps.jobs, RECORDS_PURGE_JOB_TYPE),
        job,
      });
      if (!slot.acquired) return 'deferred';
      return (await deps.jobs.markRunning(txScope, data.job_id)) === undefined ? 'skip' : 'run';
    });
    if (state === 'skip' || state === 'deferred') {
      deps.logger.info({ ...context, state }, 'records.purge_org: not run now');
      return;
    }

    const started = Date.now();
    const now = deps.now?.() ?? new Date();
    const before = new Date(now.getTime() - RECORD_TRASH_RETENTION_DAYS * DAY_MS);
    const audit = systemAuditContext(data.job_id);
    let purged = 0;
    let batches = 0;
    let busy = 0;
    try {
      const tableIds = await deps.tables.listIds(scope);
      for (const [index, tableId] of tableIds.entries()) {
        try {
          for (;;) {
            const batch = await deps.records.purgeExpired(scope, tableId, {
              before,
              auditContext: audit,
              ...(deps.batchSize === undefined ? {} : { batchSize: deps.batchSize }),
            });
            if (batch.purged.length > 0) batches += 1;
            purged += batch.purged.length;
            if (batch.done) break;
          }
        } catch (error) {
          if (!retryable(error)) throw error;
          busy += 1;
          deps.logger.warn(
            { ...context, table_id: tableId, err: error },
            'records.purge_org: table busy, retried next run',
          );
        }
        await deps.jobs.setProgress(scope, data.job_id, (index + 1) / tableIds.length);
      }
      await deps.jobs.markSucceeded(scope, data.job_id, {
        tables: tableIds.length,
        purged,
        skipped_tables: busy,
      });
    } catch (error) {
      await deps.jobs.markFailed(scope, data.job_id, {
        code: error instanceof AppError ? error.code : 'INTERNAL',
        title: 'Records purge failed',
        status: 500,
      });
      deps.logger.error(
        { ...context, err: error, purged, batches, duration_ms: Date.now() - started },
        'records.purge_org failed',
      );
      return;
    }
    deps.logger.info(
      {
        ...context,
        resumed: state === 'resume',
        purged,
        batches,
        skipped_tables: busy,
        duration_ms: Date.now() - started,
      },
      'records.purge_org finished',
    );
  };
}
