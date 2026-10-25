import { idOf, TABLE_TRASH_RETENTION_DAYS, type Id } from '@cellhive/contracts';
import {
  acquireOrgSlot,
  AppError,
  countRunningJobsOf,
  deferrableJob,
  enqueue,
  isRetryableDdlError,
  listExpiredTrashedTables,
  orgScope,
  systemAuditContext,
  type Db,
  type ExpiredTrashedTable,
  type JobsRepository,
  type SchemaService,
  type TablesRepository,
} from '@cellhive/server-core';
import { z } from 'zod';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** `meta.jobs.type` of a per-organization table purge run (counted by the org slot). */
export const TABLES_PURGE_JOB_TYPE = 'tables.purge';
/** Table purge runs of one organization at once (ADR-18 `acquireOrgSlot`). */
export const TABLES_PURGE_ORG_CAP = 1;
/** Expired tables listed per page by the daily fan-out. */
export const TABLES_PURGE_FANOUT_PAGE = 500;
/** Tables purged by one run of one organization; the rest wait for the next day. */
export const TABLES_PURGE_PER_RUN = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

const payloadSchema = z.object({ organization_id: idOf('org'), job_id: idOf('job') });

/** Cutoff of the 30-day table trash (T461, ADR-23 §3). */
export function tableTrashCutoff(now: Date): Date {
  return new Date(now.getTime() - TABLE_TRASH_RETENTION_DAYS * DAY_MS);
}

export interface TablesPurgeDeps {
  readonly db: Db;
  readonly jobs: JobsRepository;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/**
 * `tables.purge` (daily cron, T461; CONTRACTS §12.2): starts one
 * `tables.purge_org` job per organization with a table in the trash for
 * more than 30 days, with its `meta.jobs` row (system job), in one
 * transaction per organization. An organization whose previous run is still
 * queued or running gets none (idempotent). Logs counts only.
 */
export function createTablesPurgeTask(deps: TablesPurgeDeps): Task<'tables.purge'> {
  return async () => {
    const started = Date.now();
    const before = tableTrashCutoff(deps.now?.() ?? new Date());
    const seen = new Set<Id<'org'>>();
    let enqueued = 0;
    let skipped = 0;
    let after: ExpiredTrashedTable | null = null;
    for (;;) {
      const page = await listExpiredTrashedTables(deps.db.kysely, {
        before,
        after,
        limit: TABLES_PURGE_FANOUT_PAGE,
      });
      for (const { organizationId } of page) {
        if (seen.has(organizationId)) continue;
        seen.add(organizationId);
        const created = await deps.db.withTx(async (tx) => {
          const scope = orgScope(organizationId, tx);
          if ((await deps.jobs.findActive(scope, TABLES_PURGE_JOB_TYPE)) !== undefined) {
            return false;
          }
          const job = await deps.jobs.create(scope, {
            type: TABLES_PURGE_JOB_TYPE,
            createdBy: null,
          });
          await enqueue(
            tx,
            'tables.purge_org',
            { organization_id: organizationId, job_id: job.id },
            { jobKey: `tables.purge:${organizationId}`, maxAttempts: 5 },
          );
          return true;
        });
        if (created) enqueued += 1;
        else skipped += 1;
      }
      after = page.at(-1) ?? null;
      if (page.length < TABLES_PURGE_FANOUT_PAGE) break;
    }
    deps.logger.info(
      { enqueued, skipped, duration_ms: Date.now() - started },
      'tables purge jobs started',
    );
  };
}

export interface TablesPurgeOrgDeps {
  readonly db: Db;
  readonly schema: Pick<SchemaService, 'purgeTable'>;
  readonly tables: Pick<TablesRepository, 'listExpiredTrash'>;
  readonly jobs: JobsRepository;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/** Busy schema (lock timeout, running conversion, compaction) or already gone: next run. */
function skippable(error: unknown): boolean {
  return (
    (error instanceof AppError && (error.code === 'SCHEMA_LOCKED' || error.code === 'NOT_FOUND')) ||
    isRetryableDdlError(error)
  );
}

/**
 * `tables.purge_org` (T461; ADR-23 §3, CONTRACTS §13): permanently deletes
 * the tables of one organization trashed more than 30 days ago, oldest
 * first, each in its own transaction through `SchemaService.purgeTable`
 * (which re-checks the table under its lock), with one `table.purged`
 * audit entry each (`batch_id` = the job). One run per organization at a
 * time (ADR-18: a second one is deferred); a run found `running` (worker
 * restarted) resumes — purged tables are no longer listed. A table whose
 * schema is busy is skipped until the next day; any other failure marks
 * the run `failed` and is retried by the next cron. Logs ids and counts
 * only.
 */
export function createTablesPurgeOrgTask(deps: TablesPurgeOrgDeps): Task<'tables.purge_org'> {
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error({ job_id: helpers.job.id }, 'tables.purge_org: malformed payload, skipped');
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
        kind: TABLES_PURGE_JOB_TYPE,
        cap: TABLES_PURGE_ORG_CAP,
        countRunning: countRunningJobsOf(deps.jobs, TABLES_PURGE_JOB_TYPE),
        job,
      });
      if (!slot.acquired) return 'deferred';
      return (await deps.jobs.markRunning(txScope, data.job_id)) === undefined ? 'skip' : 'run';
    });
    if (state === 'skip' || state === 'deferred') {
      deps.logger.info({ ...context, state }, 'tables.purge_org: not run now');
      return;
    }

    const started = Date.now();
    const before = tableTrashCutoff(deps.now?.() ?? new Date());
    const audit = systemAuditContext(data.job_id);
    let purged = 0;
    let records = 0;
    let busy = 0;
    try {
      const expired = await deps.tables.listExpiredTrash(scope, {
        before,
        limit: TABLES_PURGE_PER_RUN,
      });
      for (const [index, table] of expired.entries()) {
        try {
          const result = await deps.schema.purgeTable(
            scope,
            table.id,
            { reason: 'retention', deletedBefore: before },
            audit,
          );
          if (result !== null) {
            purged += 1;
            records += result.recordCount;
          }
        } catch (error) {
          if (!skippable(error)) throw error;
          busy += 1;
          deps.logger.warn(
            { ...context, table_id: table.id, err: error },
            'tables.purge_org: table busy, retried next run',
          );
        }
        await deps.jobs.setProgress(scope, data.job_id, (index + 1) / expired.length);
      }
      await deps.jobs.markSucceeded(scope, data.job_id, {
        tables: expired.length,
        purged,
        records,
        skipped_tables: busy,
      });
    } catch (error) {
      await deps.jobs.markFailed(scope, data.job_id, {
        code: error instanceof AppError ? error.code : 'INTERNAL',
        title: 'Tables purge failed',
        status: 500,
      });
      deps.logger.error(
        { ...context, err: error, purged, duration_ms: Date.now() - started },
        'tables.purge_org failed',
      );
      return;
    }
    deps.logger.info(
      {
        ...context,
        resumed: state === 'resume',
        purged,
        records,
        skipped_tables: busy,
        duration_ms: Date.now() - started,
      },
      'tables.purge_org finished',
    );
  };
}
