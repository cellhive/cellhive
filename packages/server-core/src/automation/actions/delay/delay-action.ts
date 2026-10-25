import { MAX_DELAY_MINUTES, type DelayAction } from '@cellhive/contracts';

import { AppError } from '../../../errors/app-error.js';
import { AutomationStepError } from '../../engine/errors.js';
import { untilOf } from '../../engine/run-engine.js';

import { parseUntil } from './until.js';

import type { JsonObject, JsonValue } from '../../../db/schema.js';
import type { RecordQueryService } from '../../../records/record-query.service.js';
import type {
  AutomationActionContext,
  AutomationActionHandler,
  AutomationActionResult,
} from '../../engine/action-registry.js';
import type { TemplateWarning } from '../../values/evaluator.js';

const MINUTE_MS = 60_000;

/**
 * `delay` (SPEC §11.5, §11.7; ADR-18; BACKLOG T506). First attempt: the
 * end of the wait is `minutes` from now, or the instant `until` resolves
 * to (≤ 30 days ahead, else `invalid_value`; already past → no wait); the
 * step returns `wait` — the engine parks the step and the run `waiting`
 * and schedules `automation.run` for then (no worker held, not running
 * time). When the job resumes it (`previous.until` reached):
 *
 * - the trigger record (if the trigger has one, `record.deleted` aside) is
 *   read again as `run_as`: in the trash or gone (or no longer readable) →
 *   run `skipped` `record_deleted` (`params.state = trashed | missing`);
 * - `recheck_condition` is tested on its latest version (`matchRecord`, as
 *   `run_as`; `record.deleted` reads the trash): no match → run `skipped`
 *   `recheck_not_matched` — the SLA case of SPEC §24;
 * - else the step `succeeded` and the run goes on.
 *
 * Output: `{ until, resumed_at, recheck }` (`recheck`: `matched`,
 * `not_matched`, `record_deleted` or `null` without condition) — no value.
 * The definition is the run's snapshot: editing the automation meanwhile
 * changes nothing for a waiting run.
 */
export function createDelayAction(query: RecordQueryService): AutomationActionHandler {
  return {
    async execute(raw): Promise<AutomationActionResult> {
      const context = raw as AutomationActionContext & { readonly action: DelayAction };
      const { config } = context.action;
      const now = context.now();
      const warnings: TemplateWarning[] = [];
      let until = untilOf(context.previous);
      if (until === null) {
        if (config.minutes !== null) {
          until = new Date(now.getTime() + config.minutes * MINUTE_MS);
        } else if (config.until !== null) {
          const resolved = await context.values.resolve(config.until);
          warnings.push(...resolved.warnings);
          until = parseUntil(resolved.value, context.run.timeZone);
          if (until === null) {
            throw new AutomationStepError('invalid_value', 'until is empty or not a date', {
              params: { field: 'until' },
            });
          }
          if (until.getTime() - now.getTime() > MAX_DELAY_MINUTES * MINUTE_MS) {
            throw new AutomationStepError('invalid_value', 'until is more than 30 days ahead', {
              params: { field: 'until', max_minutes: MAX_DELAY_MINUTES },
            });
          }
        } else {
          throw new AutomationStepError('invalid_value', 'The delay has no length', {
            params: { field: 'minutes' },
          });
        }
      }
      const waiting: JsonObject = {
        until: until.toISOString(),
        ...(warnings.length === 0 ? {} : { warnings: warnings as unknown as JsonValue }),
      };
      if (until.getTime() > now.getTime()) return { output: waiting, wait: { until }, warnings };

      const resumed = { ...waiting, resumed_at: now.toISOString() };
      const deleted = await triggerRecordGone(context, query);
      if (deleted !== null) {
        return {
          output: { ...resumed, recheck: 'record_deleted' },
          skip: { code: 'record_deleted', params: { state: deleted } },
          warnings,
        };
      }
      if (config.recheck_condition === null) {
        return { output: { ...resumed, recheck: null }, warnings };
      }
      if (!(await matchesTrigger(context, query, config.recheck_condition))) {
        return {
          output: { ...resumed, recheck: 'not_matched' },
          skip: { code: 'recheck_not_matched' },
          warnings,
        };
      }
      return { output: { ...resumed, recheck: 'matched' }, warnings };
    },
  };
}

/** The trigger record is no longer live for `run_as`: `trashed`, `missing`, or `null` (live). */
async function triggerRecordGone(
  context: AutomationActionContext,
  query: RecordQueryService,
): Promise<'trashed' | 'missing' | null> {
  const { triggerTableId, triggerRecordId, triggerType } = context.run;
  if (triggerTableId === null || triggerRecordId === null || triggerType === 'record.deleted') {
    return null;
  }
  requireTriggerTable(context, triggerTableId);
  const { scope } = context;
  const access = context.access.record;
  if (await query.matchRecord(scope, triggerTableId, triggerRecordId, access, null)) return null;
  const trashed = await query.matchRecord(scope, triggerTableId, triggerRecordId, access, null, {
    trashed: true,
  });
  return trashed ? 'trashed' : 'missing';
}

async function matchesTrigger(
  context: AutomationActionContext,
  query: RecordQueryService,
  filter: unknown,
): Promise<boolean> {
  const { triggerTableId, triggerRecordId } = context.run;
  if (triggerTableId === null || triggerRecordId === null) return false;
  requireTriggerTable(context, triggerTableId);
  try {
    return await query.matchRecord(
      context.scope,
      triggerTableId,
      triggerRecordId,
      context.access.record,
      filter,
      { trashed: context.run.triggerType === 'record.deleted' },
    );
  } catch (error) {
    // A field of the condition `run_as` cannot read any more: the definition is not valid for it.
    if (error instanceof AppError && error.status === 422) {
      throw new AutomationStepError('permission_denied', 'run_as cannot test the condition', {
        params: { scope: 'table', error: error.code },
      });
    }
    throw error;
  }
}

function requireTriggerTable(context: AutomationActionContext, tableId: string): void {
  if (
    context.schema.access.tables[tableId as keyof typeof context.schema.access.tables] === undefined
  ) {
    throw new AutomationStepError('permission_denied', 'run_as cannot read the trigger table', {
      params: { scope: 'table', table_id: tableId },
    });
  }
}
