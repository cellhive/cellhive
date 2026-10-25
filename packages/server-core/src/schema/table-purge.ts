import { TABLE_TRASH_RETENTION_DAYS, type Id } from '@cellhive/contracts';

import type { AuditContext } from '../audit/audit-entry.js';
import type { Tx } from '../db/create-db.js';
import type { FieldRow, TableRow } from '../db/schema.js';

/**
 * Table purge (BACKLOG T461, CONTRACTS §13, ADR-23 §3): a table in the trash
 * for more than 30 days (`tables.purge` cron) or purged by hand by a base
 * admin leaves for good, together with the link fields of other tables
 * pointing at it.
 */

/** `table.purged` `data.reason`: by a base admin, or by the 30-day retention job. */
export type TablePurgeReason = 'manual' | 'retention';

/** Milliseconds a table stays restorable in the trash. */
export const TABLE_TRASH_RETENTION_MS = TABLE_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface PurgeTableOptions {
  readonly reason: TablePurgeReason;
  /**
   * Manual purge: the table name typed to confirm (`422 VALIDATION_FAILED`
   * / `CONFIRM_NAME_MISMATCH` when it differs).
   */
  readonly confirmName?: string;
  /**
   * Retention: purge only a table deleted before this instant (re-checked
   * under the lock); otherwise nothing happens.
   */
  readonly deletedBefore?: Date;
}

export interface PurgedTable {
  /** The table row, now with `purged_at`. */
  readonly table: TableRow;
  /** Rows of `data.t_x` when it was dropped (trash included). */
  readonly recordCount: number;
  /** Link fields of other tables put in the trash for good (`LINK_TABLE_PURGED`). */
  readonly partnerFieldIds: readonly Id<'fld'>[];
}

/** What the purge of a table hands to {@link TablePurgeHooks.onTablePurged}. */
export interface TablePurgeHookInput {
  readonly table: TableRow;
  /** Fields of the purged table (its primary field included). */
  readonly fields: readonly FieldRow[];
  /** Link fields of other tables that pointed at it (now in the trash for good). */
  readonly partnerFields: readonly FieldRow[];
  readonly context: AuditContext;
}

/**
 * Hooks of a table purge, run in the purge transaction after the drop and
 * before `table.purged` is written. S4b: computed fields reading the table
 * or a link field trashed with it are recomputed through
 * `ComputedRecomputeService.enqueue(tx, …)` (T458: `computedTablePurgeHooks`,
 * the default of `SchemaService`); their `#REF` is set by `SchemaService`
 * itself just before the hooks (T460, `reconcileComputedErrors`).
 */
export interface TablePurgeHooks {
  onTablePurged(tx: Tx, input: TablePurgeHookInput): Promise<void>;
}

export const noopTablePurgeHooks: TablePurgeHooks = {
  onTablePurged: () => Promise.resolve(),
};
