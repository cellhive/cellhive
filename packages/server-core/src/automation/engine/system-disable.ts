import { systemAuditContext } from '../../audit/audit-entry.js';
import { AuditWriter } from '../../audit/audit-writer.js';
import { withTxScope, type OrgScope } from '../../db/repository.js';
import { emit } from '../../events/event-writer.js';
import { AUTOMATION_NOTIFICATIONS, type AutomationNotifier } from '../dispatch/notifier.js';
import { AutomationRunsRepository } from '../repository/automation-runs.repository.js';
import { AutomationsRepository } from '../repository/automations.repository.js';

import { cancelWaitingRuns } from './cancel.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { AutomationDisabledReasonKind, AutomationRow, JsonObject } from '../../db/schema.js';

const audit = new AuditWriter();

export interface SystemDisableOptions {
  readonly notifier?: AutomationNotifier;
  /**
   * Also cancel the `queued` runs (ADR-25 §5: `run_as` lost access — they
   * would only fail). Runs waiting in a `delay` are always cancelled (T506).
   */
  readonly cancelQueued?: boolean;
  /** Extra keys of the audit entry's `after` (ids and codes only, never values). */
  readonly auditDetail?: JsonObject;
  /** Clock of `finished_at` of the cancelled queued runs. */
  readonly now?: () => Date;
}

/**
 * Turns `row` off for a system reason in `tx` (ADR-25 §5 `run_as_lost_access`,
 * ADR-26 §5 `circuit_breaker`): `enabled = false`, `disabled_reason`,
 * `version + 1`, `run_as` kept (a manager turns it back on: enable or take
 * over); runs waiting in a `delay` — and with `cancelQueued` the `queued`
 * ones — become `cancelled` `automation_disabled`; `automation.disabled`
 * event + audit by the system (`after = { enabled, disabled_reason, … }`,
 * `data.run_as_user_id`, as when a person turns it off, CONTRACTS §21);
 * notification `automation.disabled` to `run_as` + base admins (T511).
 * Returns the updated row; `undefined` when it was already off.
 */
export async function disableAutomationBySystem(
  db: Db,
  tx: Tx,
  scope: OrgScope,
  row: AutomationRow,
  reason: AutomationDisabledReasonKind,
  options: SystemDisableOptions = {},
): Promise<AutomationRow | undefined> {
  const txScope = withTxScope(scope, tx);
  const updated = await new AutomationsRepository(db).disableBySystem(txScope, row.id, reason);
  if (updated === undefined) return undefined;
  await cancelWaitingRuns(db, txScope, updated.id, 'automation_disabled');
  if (options.cancelQueued === true) {
    await new AutomationRunsRepository(db).cancelQueuedOf(txScope, updated.id, {
      at: options.now?.() ?? new Date(),
      error: { code: 'automation_disabled' },
    });
  }
  const context = systemAuditContext();
  const tableId = updated.trigger_table_id;
  await emit(tx, {
    type: 'automation.disabled',
    organizationId: scope.organizationId,
    entityType: 'automation',
    entityId: updated.id,
    actor: context.actor,
    baseId: updated.base_id,
    ...(tableId === null ? {} : { tableId }),
    data: { run_as_user_id: updated.run_as_user_id, disabled_reason: reason },
  });
  await audit.write(tx, {
    action: 'automation.disabled',
    organizationId: scope.organizationId,
    baseId: updated.base_id,
    ...(tableId === null ? {} : { tableId }),
    entityType: 'automation',
    entityId: updated.id,
    before: { enabled: true },
    after: { enabled: false, disabled_reason: reason, ...options.auditDetail },
    context,
  });
  await (options.notifier ?? AUTOMATION_NOTIFICATIONS).automationDisabled(tx, {
    organizationId: scope.organizationId,
    baseId: updated.base_id,
    automationId: updated.id,
    automationName: updated.name,
    runAsUserId: updated.run_as_user_id,
    reason,
    version: updated.version,
  });
  return updated;
}
