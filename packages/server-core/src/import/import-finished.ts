import { IMPORT_JOB_TYPE, type Id, type ImportFinishedStatus } from '@cellhive/contracts';

import { AuditLogsRepository } from '../audit/audit-logs.repository.js';
import { orgScope } from '../db/repository.js';
import { enqueueNotification } from '../notifications/fanout.js';

import type { Db, Tx } from '../db/create-db.js';
import type { JobRecord, JobsRepository } from '../jobs/jobs.repository.js';

/**
 * How one CSV/XLSX import ended, for `import.finished` (ADR-34 §4,
 * BACKLOG T548, CONTRACTS §19, §22.1). Counts only, never a cell value.
 */
export interface ImportFinishedNotice {
  readonly organizationId: Id<'org'>;
  readonly jobId: Id<'job'>;
  readonly baseId: Id<'bse'>;
  /**
   * The table imported into, which the recipient must still read when the
   * notification is written. `null` when no such table remains: a
   * create-mode import that failed or was cancelled (its new table went to
   * the trash, or was never created), or an import cancelled before it
   * started — the recipient then only needs to open the base.
   */
  readonly tableId: Id<'tbl'> | null;
  /** Who started the import: the only recipient. */
  readonly userId: Id<'usr'>;
  /** Who ended it: the importer (the run), or the user who cancelled it. Default: the importer. */
  readonly endedBy?: Id<'usr'>;
  readonly status: ImportFinishedStatus;
  /** Records the import created. */
  readonly created: number;
  /** Records it updated (CSV/XLSX import only appends today: `0`). */
  readonly updated: number;
  /** Data rows it skipped because of their values. */
  readonly failedRows: number;
}

/**
 * Priority of the `import.finished` fan-out job (graphile-worker: lower runs
 * first, default 0): ahead of the `events.dispatch` jobs the import's last
 * batches queued just before (one per record), so the importer hears of the
 * end in realtime instead of after the whole backlog (T548).
 */
export const IMPORT_FINISHED_FANOUT_PRIORITY = -1;

/**
 * Queues `import.finished` for the importer in `tx` — the transaction that
 * moves the job to its final state, so the notification exists only if
 * that change commits (ADR-06). `group_key = job_id`: a retried job or a
 * second end path never notifies twice. The person who started the import
 * is notified even though they are its actor (`skip_actor = false`, the
 * deliberate exception of CONTRACTS §22.1); their access to the base (and
 * table) is checked when the notification is written.
 */
export function notifyImportFinished(tx: Tx, notice: ImportFinishedNotice): Promise<void> {
  return enqueueNotification(tx, {
    organizationId: notice.organizationId,
    type: 'import.finished',
    baseId: notice.baseId,
    tableId: notice.tableId,
    entityType: 'job',
    entityId: notice.jobId,
    actor: { type: 'user', id: notice.endedBy ?? notice.userId },
    groupKey: notice.jobId,
    userIds: [notice.userId],
    skipActor: false,
    data: {
      job_id: notice.jobId,
      status: notice.status,
      created: notice.created,
      updated: notice.updated,
      failed_rows: notice.failedRows,
    },
    priority: IMPORT_FINISHED_FANOUT_PRIORITY,
  });
}

/**
 * Records an import job wrote before it stopped, counted from the audit log
 * (each record it created has one entry with `batch_id = job_…`, CONTRACTS
 * §19): what an interrupted run reports, as its own counters are lost.
 */
export async function importedRecordCount(
  db: Db,
  tx: Tx,
  input: {
    readonly organizationId: Id<'org'>;
    readonly jobId: Id<'job'>;
  },
): Promise<number> {
  const counts = await new AuditLogsRepository(db).countRecordBatches(
    orgScope(input.organizationId, tx),
    [input.jobId],
  );
  return counts.get(input.jobId) ?? 0;
}

export interface CancelImportJobInput {
  readonly organizationId: Id<'org'>;
  readonly jobId: Id<'job'>;
  /** Base of the import (the upload's). */
  readonly baseId: Id<'bse'>;
  /** The user cancelling it (the importer or an organization owner/admin). */
  readonly cancelledBy: Id<'usr'>;
}

/**
 * `POST …/imports/:jobId/cancel` (CONTRACTS §19): moves a `queued` or
 * `running` `table.import` job to `cancelled`, in one transaction with the
 * job row locked, and returns it (`undefined` when it was not queued or
 * running). A job that never started is finished here: `import.finished`
 * (`cancelled`, all counts `0`, no table) is queued in the same
 * transaction. A running job is finished by its worker, which stops before
 * its next batch and notifies with what it wrote (the lock orders this
 * against `markRunning`, so exactly one side notifies).
 */
export function cancelImportJob(
  db: Db,
  jobs: Pick<JobsRepository, 'lockById' | 'markCancelled'>,
  input: CancelImportJobInput,
): Promise<JobRecord | undefined> {
  return db.withTx(async (tx) => {
    const scope = orgScope(input.organizationId, tx);
    const current = await jobs.lockById(scope, input.jobId);
    if (current?.type !== IMPORT_JOB_TYPE) return undefined;
    if (current.status !== 'queued' && current.status !== 'running') return undefined;
    const cancelled = await jobs.markCancelled(scope, input.jobId);
    if (cancelled !== undefined && current.status === 'queued' && current.created_by !== null) {
      await notifyImportFinished(tx, {
        organizationId: input.organizationId,
        jobId: input.jobId,
        baseId: input.baseId,
        tableId: null,
        userId: current.created_by,
        endedBy: input.cancelledBy,
        status: 'cancelled',
        created: 0,
        updated: 0,
        failedRows: 0,
      });
    }
    return cancelled;
  });
}
