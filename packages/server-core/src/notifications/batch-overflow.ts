import { automationBatchOverflowDataSchema } from '@cellhive/contracts';

import type { AutomationRunsRepository } from '../automation/repository/automation-runs.repository.js';
import type { OrgScope } from '../db/repository.js';
import type { JsonValue } from '../db/schema.js';

/**
 * The records of a bulk change an automation left out, for an
 * `automation.batch_overflow` notification (QA S5 L6, BACKLOG T542): read
 * **when the notification is read or sent** from its stand-in run `run_id`
 * (`error.skipped`, kept up to date while the batch goes on — ADR-26 §4),
 * never stored on the notification. `null` when the data is not a
 * `batch_overflow` one, the run is gone (retention) or belongs to another
 * automation. Callers check first that the reader may see the automation
 * (CONTRACTS §21); this does not.
 */
export async function batchOverflowSkipped(
  runs: AutomationRunsRepository,
  scope: OrgScope,
  data: JsonValue,
  automationId: string,
): Promise<number | null> {
  const parsed = automationBatchOverflowDataSchema.safeParse(data);
  if (!parsed.success || parsed.data.automation_id !== automationId) return null;
  const run = await runs.get(scope, parsed.data.run_id);
  if (run?.automation_id !== automationId) return null;
  const error = run.error;
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null;
  const skipped = error.skipped;
  return typeof skipped === 'number' && Number.isInteger(skipped) && skipped >= 0 ? skipped : null;
}
