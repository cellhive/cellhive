import { logTimeTick, type AutomationTimeTaskDeps } from './automation-schedule-tick.js';

import type { Task } from 'graphile-worker';

/**
 * `automation.date_scan` (cron every minute; SPEC §11.2, BACKLOG T508):
 * fires `record.date_reached` automations for the records whose date (+
 * offset) passed since the last scan (`AutomationTimeTriggers.scanDates`):
 * one run per (record, value), at most `AUTOMATION_MAX_RUNS_PER_BATCH` per
 * automation per scan. A scan missed (worker stopped) is caught up by the
 * next one; a scan run twice creates nothing twice. Logs ids, codes and
 * counts only — never dates or record values.
 */
export function createAutomationDateScanTask(
  deps: AutomationTimeTaskDeps,
): Task<'automation.date_scan'> {
  return async () => {
    const tick = await deps.triggers.scanDates(deps.now?.() ?? new Date());
    logTimeTick(deps.logger, tick, 'automation date scan');
  };
}
