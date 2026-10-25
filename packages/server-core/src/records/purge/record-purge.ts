import { sql } from 'kysely';

import { assertDataTableName, DATA_SCHEMA } from '../../schema/names.js';

import type { AuditContext, AuditEntryInput } from '../../audit/audit-entry.js';
import type { Tx } from '../../db/create-db.js';
import type { TableRow } from '../../db/schema.js';
import type { Actor, Causation, EventInput } from '../../events/event.js';
import type { Id } from '@cellhive/contracts';

/** Records permanently deleted per transaction by the `records.purge` job (T408). */
export const RECORD_PURGE_BATCH_SIZE = 500;

/** Why records were purged: from the trash UI/API, or after the 30-day retention. */
export type PurgeReason = 'manual' | 'retention';

export interface PurgeSummaryInput {
  readonly table: TableRow;
  readonly ids: readonly Id<'rec'>[];
  readonly audit: AuditContext;
  readonly causation: Causation | undefined;
  readonly reason: PurgeReason;
}

/**
 * Deletes trashed rows of `table` (ids from locked rows only, never input):
 * junction rows of every link to or from them go with them
 * (`ON DELETE CASCADE`) and their children's `__parent_id` becomes `NULL`
 * (`ON DELETE SET NULL`, SPEC §5.7). A row outside the trash is never
 * deleted. Returns the ids deleted.
 */
export async function deleteTrashedRows(
  tx: Tx,
  table: TableRow,
  ids: readonly Id<'rec'>[],
): Promise<Id<'rec'>[]> {
  if (ids.length === 0) return [];
  const ref = sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name));
  const { rows } = await sql<{ id: Id<'rec'> }>`
    DELETE FROM ${ref}
     WHERE __id = ANY(${sql.val([...ids])}::text[]) AND __deleted_at IS NOT NULL
    RETURNING __id AS id
  `.execute(tx);
  return rows.map((row) => row.id);
}

/**
 * The `record.purged` event and audit entry of one purge of one table
 * (ADR-23 §2: one summary entry, `after = { count, record_ids }`; CONTRACTS
 * §8). The entity is the table: the records no longer exist.
 */
export function purgeSummary(input: PurgeSummaryInput): {
  readonly event: EventInput;
  readonly audit: AuditEntryInput;
} {
  const { table } = input;
  const recordIds = [...input.ids];
  const actor: Actor = input.audit.actor;
  return {
    event: {
      type: 'record.purged',
      organizationId: table.organization_id,
      entityType: 'table',
      entityId: table.id,
      actor,
      baseId: table.base_id,
      tableId: table.id,
      data: { count: recordIds.length, record_ids: recordIds, reason: input.reason },
      ...(input.causation === undefined ? {} : { causation: input.causation }),
    },
    audit: {
      action: 'record.purged',
      organizationId: table.organization_id,
      baseId: table.base_id,
      tableId: table.id,
      entityType: 'table',
      entityId: table.id,
      before: null,
      after: { count: recordIds.length, record_ids: recordIds },
      context: input.audit,
    },
  };
}
