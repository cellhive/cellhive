import { withTxScope, type OrgScope } from '../../db/repository.js';
import { disableAutomationBySystem } from '../engine/system-disable.js';
import { AutomationRunsRepository } from '../repository/automation-runs.repository.js';
import { AutomationsRepository } from '../repository/automations.repository.js';

import { AUTOMATION_NOTIFICATIONS, type AutomationNotifier } from './notifier.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { AutomationRow } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/** More distinct trigger units than this within one minute trips the breaker (ADR-26 §5). */
export const BREAKER_MAX_UNITS_PER_MINUTE = 100;
/** This many trigger units failing in a row trips the breaker (ADR-26 §5). */
export const BREAKER_MAX_FAILED_UNITS = 50;
/** The breaker's rate window. */
export const BREAKER_WINDOW_SECONDS = 60;

/**
 * Turns `row` off with `disabled_reason = circuit_breaker` (ADR-26 §5) in
 * `tx`: `automation.disabled` event + audit by the system (`after` =
 * `{ enabled, disabled_reason }`, `data.run_as_user_id`, as when a person
 * turns it off, CONTRACTS §21), then tells `run_as` + base admins through
 * `notifier`. `run_as` is kept, so a manager turns it back on (enable or
 * take over). Returns the updated row; `undefined` when it was already off.
 */
export async function tripCircuitBreaker(
  db: Db,
  tx: Tx,
  scope: OrgScope,
  row: AutomationRow,
  notifier: AutomationNotifier = AUTOMATION_NOTIFICATIONS,
): Promise<AutomationRow | undefined> {
  return disableAutomationBySystem(db, tx, scope, row, 'circuit_breaker', { notifier });
}

/**
 * The second breaker rule (ADR-26 §5), for the run engine (T505) to call
 * in the transaction that marks a run `failed`: when the latest
 * {@link BREAKER_MAX_FAILED_UNITS} trigger units of the automation all
 * failed (each has a `failed` run and no `succeeded` one), the automation
 * is turned off as by {@link tripCircuitBreaker}. Returns whether it was.
 */
export async function tripOnConsecutiveFailures(
  db: Db,
  tx: Tx,
  scope: OrgScope,
  automationId: Id<'aut'>,
  notifier: AutomationNotifier = AUTOMATION_NOTIFICATIONS,
): Promise<boolean> {
  const txScope = withTxScope(scope, tx);
  const row = await new AutomationsRepository(db).lockEnabled(txScope, automationId);
  if (row === undefined) return false;
  const units = await new AutomationRunsRepository(db).latestUnitOutcomes(
    txScope,
    automationId,
    BREAKER_MAX_FAILED_UNITS,
  );
  if (units.length < BREAKER_MAX_FAILED_UNITS || !units.every((unit) => unit.failed)) return false;
  return (await tripCircuitBreaker(db, tx, scope, row, notifier)) !== undefined;
}
