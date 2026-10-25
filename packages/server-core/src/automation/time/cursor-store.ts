import type { OrgScope } from '../../db/repository.js';
import type { AutomationRow } from '../../db/schema.js';
import type { TimeScanCursor, TimeScanCursorStore } from '../../time-scan/cursor-store.js';
import type { AutomationTimeCursorsRepository } from '../repository/time-cursors.repository.js';

/**
 * The cursor store of the automation consumer of the time scan core
 * (ADR-34 §1, BACKLOG T546): `meta.automation_time_cursors`, one cursor per
 * automation (T508, unchanged — no migration), armed at
 * `automations.trigger_armed_at`. A missing cursor starts at the arming
 * moment (else `now`), as in T508. Used by both time triggers (`schedule`
 * and `record.date_reached`).
 */
export class AutomationTimeCursorStore implements TimeScanCursorStore<AutomationRow> {
  constructor(private readonly cursors: AutomationTimeCursorsRepository) {}

  async lock(scope: OrgScope, row: AutomationRow, now: Date): Promise<TimeScanCursor> {
    const armedAt = row.trigger_armed_at;
    const scannedUntil = await this.cursors.lock(scope, row.id, armedAt ?? now);
    return { scannedUntil, armedAt };
  }

  async advance(scope: OrgScope, row: AutomationRow, until: Date): Promise<void> {
    await this.cursors.advance(scope, row.id, until);
  }
}
