import { IMPORT_JOB_TYPE, type Id } from '@cellhive/contracts';
import {
  AUDIT_BASE_EXPORT_JOB_TYPE,
  AUDIT_EXPORT_JOB_TYPE,
  auditExportKey,
  importReportKey,
  listExpiredExportFiles,
  orgScope,
  type Db,
  type JobsRepository,
  type StorageDriver,
} from '@cellhive/server-core';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Job types whose result links a downloadable file, and the file's storage key. */
const FILE_JOBS: readonly {
  readonly type: string;
  readonly key: (organizationId: Id<'org'>, jobId: Id<'job'>) => string;
}[] = [
  { type: AUDIT_EXPORT_JOB_TYPE, key: auditExportKey },
  // A base's audit log (T709): same file name scheme as the organization export.
  { type: AUDIT_BASE_EXPORT_JOB_TYPE, key: auditExportKey },
  // Error reports of imports (CONTRACTS §19), valid 24 hours.
  { type: IMPORT_JOB_TYPE, key: importReportKey },
];

/** Expired export files handled per batch. */
export const EXPORT_CLEANUP_BATCH = 100;

export interface ExportsCleanupDeps {
  readonly db: Db;
  readonly jobs: Pick<JobsRepository, 'clearDownload'>;
  readonly storage: Pick<StorageDriver, 'delete'>;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

/**
 * `exports.cleanup` (hourly cron): deletes the stored file of every
 * `audit.export` job whose download link expired (`result.expires_at`,
 * one hour, CONTRACTS §12.2) and of every `table.import` error report
 * (24 hours, CONTRACTS §19), and removes `result.download_url` from the job
 * (`file_deleted: true`), so the link is never offered again. The file is
 * deleted first: a failure leaves the job listed for the next run. Storage
 * keys come from ids only (`auditExportKey`), never from the job result.
 * Logs counts only.
 */
export function createExportsCleanupTask(deps: ExportsCleanupDeps): Task<'exports.cleanup'> {
  const batchSize = deps.batchSize ?? EXPORT_CLEANUP_BATCH;
  return async () => {
    const started = Date.now();
    const now = deps.now?.() ?? new Date();
    let deleted = 0;
    for (const { type, key } of FILE_JOBS) {
      for (;;) {
        const expired = await listExpiredExportFiles(deps.db.kysely, {
          type,
          now,
          limit: batchSize,
        });
        for (const file of expired) {
          await deps.storage.delete(key(file.organizationId, file.jobId));
          await deps.jobs.clearDownload(orgScope(file.organizationId), file.jobId);
          deleted += 1;
        }
        if (expired.length < batchSize) break;
      }
    }
    deps.logger.info(
      { files: deleted, duration_ms: Date.now() - started },
      'expired export files deleted',
    );
  };
}
