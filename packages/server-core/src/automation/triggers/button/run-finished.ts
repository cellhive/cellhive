import { isId, type Id } from '@cellhive/contracts';

import { publishRealtime } from '../../../realtime/bus.js';
import { REALTIME_ENVELOPE_VERSION } from '../../../realtime/envelope.js';

import type { Db, Tx } from '../../../db/create-db.js';
import type { AutomationRunRow } from '../../../db/schema.js';

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Who clicked the button that started `run` (`input.trigger.data.clicked_by`), if any. */
export function clickedByOf(
  run: Pick<AutomationRunRow, 'input'>,
): { userId: Id<'usr'>; tableId: Id<'tbl'> | null; recordId: Id<'rec'> | null } | null {
  const trigger = isObject(run.input) ? run.input['trigger'] : undefined;
  if (!isObject(trigger) || trigger['type'] !== 'button.clicked') return null;
  const data = trigger['data'];
  const userId = isObject(data) ? data['clicked_by'] : undefined;
  if (!isId('usr', userId)) return null;
  const tableId = trigger['table_id'];
  const recordId = trigger['record_id'];
  return {
    userId,
    tableId: isId('tbl', tableId) ? tableId : null,
    recordId: isId('rec', recordId) ? recordId : null,
  };
}

/**
 * `automation.run.finished` (T517, ADR-32 §2, CONTRACTS §7) for a run a
 * button click started, to the clicker only (`user:<clicked_by>`), after
 * `tx` commits. Nothing for other runs.
 */
export async function publishButtonRunFinished(
  db: Db,
  tx: Tx | undefined,
  organizationId: Id<'org'>,
  run: Pick<AutomationRunRow, 'id' | 'automation_id' | 'input'>,
  status: 'succeeded' | 'failed' | 'skipped' | 'cancelled',
): Promise<void> {
  const clicked = clickedByOf(run);
  if (clicked === null) return;
  await publishRealtime(db, tx, {
    v: REALTIME_ENVELOPE_VERSION,
    type: 'automation.run.finished',
    organization_id: organizationId,
    user_id: clicked.userId,
    run_id: run.id,
    automation_id: run.automation_id,
    table_id: clicked.tableId,
    record_id: clicked.recordId,
    status,
  });
}
