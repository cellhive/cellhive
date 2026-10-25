import type { AutomationTimeTriggers, TimeTriggerTick } from '@cellhive/server-core';
import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

export interface AutomationTimeTaskDeps {
  readonly triggers: Pick<AutomationTimeTriggers, 'tickSchedules' | 'scanDates'>;
  readonly logger: Logger;
  /** Clock of the tick (tests pin it); default: the real one. */
  readonly now?: () => Date;
}

/** Logs a tick: counts, plus each automation that did something (ids and codes only). */
export function logTimeTick(logger: Logger, tick: TimeTriggerTick, message: string): void {
  for (const item of tick.results) {
    if (item.outcome === 'idle' || item.outcome === 'duplicate') continue;
    logger[item.outcome === 'error' ? 'warn' : 'info'](
      {
        org_id: item.organizationId,
        automation_id: item.automationId,
        outcome: item.outcome,
        runs: item.runs,
        ...(item.errorCode === undefined ? {} : { code: item.errorCode }),
        ...(item.missed === undefined || item.missed === 0 ? {} : { missed: item.missed }),
      },
      message,
    );
  }
  logger.debug({ automations: tick.automations, runs: tick.runs }, `${message}: tick done`);
}

/**
 * `automation.schedule_tick` (cron every minute; SPEC §11.2, BACKLOG T508):
 * fires the `schedule` automations whose latest fire time passed since the
 * last tick (`AutomationTimeTriggers.tickSchedules`). A tick missed or run
 * twice changes nothing: each automation keeps a cursor and every run a
 * dedupe key. Logs ids, codes and counts only.
 */
export function createAutomationScheduleTickTask(
  deps: AutomationTimeTaskDeps,
): Task<'automation.schedule_tick'> {
  return async () => {
    const tick = await deps.triggers.tickSchedules(deps.now?.() ?? new Date());
    logTimeTick(deps.logger, tick, 'automation schedule');
  };
}
