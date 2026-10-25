import type { DateReminderScanner, DateReminderTick } from '@cellhive/server-core';
import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

export interface NotificationsDateReminderScanDeps {
  readonly scanner: Pick<DateReminderScanner, 'scanAll'>;
  readonly logger: Logger;
  /** Clock of the scan (tests pin it); default: the real one. */
  readonly now?: () => Date;
}

/** Logs a scan: counts, plus each field that did something (ids, codes and counts only). */
export function logDateReminderTick(logger: Logger, tick: DateReminderTick): void {
  for (const item of tick.results) {
    if (item.outcome === 'idle') continue;
    logger[item.outcome === 'error' ? 'warn' : 'info'](
      {
        org_id: item.organizationId,
        field_id: item.fieldId,
        outcome: item.outcome,
        reminders: item.reminders,
        ...(item.errorCode === undefined ? {} : { code: item.errorCode }),
      },
      'date reminder scan',
    );
  }
  logger.debug({ fields: tick.fields, reminders: tick.reminders }, 'date reminder scan: done');
}

/**
 * `notifications.date_reminder_scan` (cron every minute; BACKLOG T547,
 * ADR-34 §1, CONTRACTS §22.6): queues a `date.reminder` for the records
 * whose date (+ offset) passed since the last scan, field by field
 * (`DateReminderScanner.scanAll`): one per (record, value), at most
 * `DATE_REMINDER_MAX_PER_SCAN` per field per scan. A scan missed (worker
 * stopped) is caught up by the next one; a scan run twice queues nothing
 * twice. Logs ids, codes and counts only — never dates, values or users.
 */
export function createNotificationsDateReminderScanTask(
  deps: NotificationsDateReminderScanDeps,
): Task<'notifications.date_reminder_scan'> {
  return async () => {
    const tick = await deps.scanner.scanAll(deps.now?.() ?? new Date());
    logDateReminderTick(deps.logger, tick);
  };
}
