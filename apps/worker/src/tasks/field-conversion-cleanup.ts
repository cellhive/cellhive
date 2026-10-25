import {
  listExpiredFieldConversions,
  orgScope,
  type Db,
  type SchemaService,
} from '@cellhive/server-core';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Expired conversions handled per batch. */
export const FIELD_CONVERSION_CLEANUP_BATCH = 100;

export interface FieldConversionCleanupDeps {
  readonly db: Db;
  readonly schema: Pick<SchemaService, 'dropExpiredConversionColumn'>;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

/**
 * `field.conversion_cleanup` (hourly cron, T403, SPEC §5.5 step 3; CONTRACTS
 * §12.2): drops the old column (`f_x__old_<ms>`) of every finished type
 * conversion whose 7-day revert window is over, through
 * `SchemaService.dropExpiredConversionColumn` (the only DDL path), and marks
 * it `cleaned`; the revert then answers `404`. A conversion that fails to
 * clean (e.g. the table's schema is busy) is logged and retried next hour.
 * Logs ids and counts only.
 */
export function createFieldConversionCleanupTask(
  deps: FieldConversionCleanupDeps,
): Task<'field.conversion_cleanup'> {
  const batchSize = deps.batchSize ?? FIELD_CONVERSION_CLEANUP_BATCH;
  return async () => {
    const started = Date.now();
    const now = deps.now?.() ?? new Date();
    const seen = new Set<string>();
    let dropped = 0;
    let failed = 0;
    for (;;) {
      const expired = (
        await listExpiredFieldConversions(deps.db.kysely, { now, limit: batchSize + seen.size })
      ).filter((conversion) => !seen.has(conversion.jobId));
      if (expired.length === 0) break;
      for (const conversion of expired.slice(0, batchSize)) {
        seen.add(conversion.jobId);
        try {
          if (
            await deps.schema.dropExpiredConversionColumn(
              orgScope(conversion.organizationId),
              conversion.jobId,
              now,
            )
          ) {
            dropped += 1;
          }
        } catch (err) {
          failed += 1;
          deps.logger.warn(
            { err, org_id: conversion.organizationId, job_id: conversion.jobId },
            'field conversion cleanup failed; retried next run',
          );
        }
      }
    }
    deps.logger.info(
      { columns: dropped, failed, duration_ms: Date.now() - started },
      'expired field conversion columns dropped',
    );
  };
}
