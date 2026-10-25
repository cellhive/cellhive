import {
  importUploadKey,
  listExpiredImportUploads,
  orgScope,
  type Db,
  type ImportsRepository,
  type StorageDriver,
} from '@cellhive/server-core';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Expired uploads handled per batch. */
export const IMPORT_CLEANUP_BATCH = 100;

export interface ImportsCleanupDeps {
  readonly db: Db;
  readonly imports: Pick<ImportsRepository, 'delete'>;
  readonly storage: Pick<StorageDriver, 'delete'>;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

/**
 * `imports.cleanup` (hourly cron, CONTRACTS §19): deletes import uploads
 * past their 24-hour expiry whose import job, if any, is no longer queued
 * or running: the stored file first (a failure leaves the row for the next
 * run), then the `meta.imports` row. Storage keys come from ids only
 * (`importUploadKey`). Logs counts only.
 */
export function createImportsCleanupTask(deps: ImportsCleanupDeps): Task<'imports.cleanup'> {
  const batchSize = deps.batchSize ?? IMPORT_CLEANUP_BATCH;
  return async () => {
    const started = Date.now();
    const now = deps.now?.() ?? new Date();
    let deleted = 0;
    for (;;) {
      const expired = await listExpiredImportUploads(deps.db.kysely, { now, limit: batchSize });
      for (const upload of expired) {
        await deps.storage.delete(importUploadKey(upload.organizationId, upload.id));
        await deps.imports.delete(orgScope(upload.organizationId), upload.id);
        deleted += 1;
      }
      if (expired.length < batchSize) break;
    }
    deps.logger.info(
      { uploads: deleted, duration_ms: Date.now() - started },
      'expired import uploads deleted',
    );
  };
}
