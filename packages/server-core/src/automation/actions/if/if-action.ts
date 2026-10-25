import { AppError } from '../../../errors/app-error.js';
import { AutomationStepError } from '../../engine/errors.js';

import { compareIfValues } from './compare.js';

import type { JsonValue } from '../../../db/schema.js';
import type { RecordQueryService } from '../../../records/record-query.service.js';
import type {
  AutomationActionContext,
  AutomationActionHandler,
  AutomationActionResult,
} from '../../engine/action-registry.js';
import type { TemplateWarning } from '../../values/evaluator.js';
import type { IfAction } from '@cellhive/contracts';

/**
 * The one-level `if` step (SPEC §11.3, BACKLOG T505): Filter DSL conditions
 * on the **latest** trigger record, read as `run_as` (`matchRecord`; a
 * record it cannot read any more does not match), and value conditions
 * (`compareIfValues`) on values of SPEC §11.4, joined by `match`
 * (`and`/`or`, one level). The engine runs `then` when they hold, else
 * `else` — or ends the run `succeeded` when `on_false = stop`. Output:
 * `{ result, branch }`.
 */
export function createIfAction(query: RecordQueryService): AutomationActionHandler {
  return {
    async execute(raw): Promise<AutomationActionResult> {
      const context = raw as AutomationActionContext & { readonly action: IfAction };
      const { config } = context.action;
      const warnings: TemplateWarning[] = [];
      const results: boolean[] = [];
      for (const condition of config.conditions) {
        if ('filter' in condition) {
          results.push(await matchesTrigger(context, query, condition.filter));
          continue;
        }
        const value = await context.values.resolve(condition.value);
        const compare =
          condition.compare === null ? null : await context.values.resolve(condition.compare);
        warnings.push(...value.warnings, ...(compare?.warnings ?? []));
        results.push(compareIfValues(value.value, condition.operator, compare?.value ?? null));
      }
      const result = config.match === 'or' ? results.some(Boolean) : results.every(Boolean);
      const branch = result ? 'then' : config.on_false === 'stop' ? 'stop' : 'else';
      return {
        output: {
          result,
          branch,
          ...(warnings.length === 0 ? {} : { warnings: warnings as unknown as JsonValue }),
        },
        warnings,
        branch,
      };
    },
  };
}

async function matchesTrigger(
  context: AutomationActionContext,
  query: RecordQueryService,
  filter: unknown,
): Promise<boolean> {
  const { triggerTableId, triggerRecordId } = context.run;
  if (triggerTableId === null || triggerRecordId === null) return false;
  if (context.schema.access.tables[triggerTableId] === undefined) {
    throw new AutomationStepError('permission_denied', 'run_as cannot read the trigger table', {
      params: { scope: 'table', table_id: triggerTableId },
    });
  }
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
    // A field of the filter `run_as` cannot read any more: the definition is not valid for it.
    if (error instanceof AppError && error.status === 422) {
      throw new AutomationStepError('permission_denied', 'run_as cannot test the condition', {
        params: { scope: 'table', error: error.code },
      });
    }
    throw error;
  }
}
