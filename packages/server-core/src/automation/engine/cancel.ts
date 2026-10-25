import { AutomationRunsRepository } from '../repository/automation-runs.repository.js';

import { cancelDeliveriesOfRuns } from './http-wait.js';

import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { AutomationRunCancelCode, Id } from '@cellhive/contracts';

/**
 * Cancels the runs of an automation that wait inside a `delay` (SPEC
 * §11.7, BACKLOG T506): called in the transaction that turns the
 * automation off or deletes it — by a person (`disable`, `DELETE`), the
 * circuit breaker, or `run_as` losing access (T507). Their resume job
 * then finds them `cancelled` and does nothing. Runs `queued` or
 * `running` are left alone. Runs waiting for an HTTP delivery (T605) are
 * `waiting` too: their `pending` delivery is cancelled with them. Returns
 * the ids of the cancelled runs.
 */
export async function cancelWaitingRuns(
  db: Db,
  scope: OrgScope,
  automationId: Id<'aut'>,
  code: AutomationRunCancelCode,
): Promise<Id<'run'>[]> {
  if (scope.tx === undefined) throw new TypeError('cancelWaitingRuns needs a transaction scope');
  const ids = await new AutomationRunsRepository(db).cancelWaiting(
    scope,
    { automationId },
    { code },
  );
  await cancelDeliveriesOfRuns(db, scope, ids);
  return ids;
}

/**
 * Cancels one `waiting` run (the hook of the run log's cancel, T518);
 * `false` when it is not `waiting` (any more).
 */
export async function cancelWaitingRun(
  db: Db,
  scope: OrgScope,
  runId: Id<'run'>,
  error: { readonly code: string },
): Promise<boolean> {
  const ids = await new AutomationRunsRepository(db).cancelWaiting(scope, { runId }, { ...error });
  // Waiting for an HTTP delivery (T605): the destination never receives it.
  await cancelDeliveriesOfRuns(db, scope, ids);
  return ids.length > 0;
}
