import type { ComputedRecomputeService } from './recompute.service.js';
import type { TablePurgeHooks } from '../../schema/table-purge.js';

/**
 * Table purge hooks of the incremental recompute (BACKLOG T458, T461): in
 * the purge transaction, the computed fields reading a field of the purged
 * table, or one of the link fields of other tables that pointed at it (now
 * in the trash for good), are recomputed for every record by the
 * `computed.recompute` job. Their `#REF` (`compute_error`, T460) is set by
 * `SchemaService` in the same transaction, before these hooks run (fields
 * in error are not recomputed).
 */
export function computedTablePurgeHooks(recompute: ComputedRecomputeService): TablePurgeHooks {
  return {
    async onTablePurged(tx, input) {
      const { table } = input;
      const byTable = new Map<string, string[]>();
      for (const field of [...input.fields, ...input.partnerFields]) {
        const list = byTable.get(field.table_id) ?? [];
        list.push(field.id);
        byTable.set(field.table_id, list);
      }
      await recompute.enqueue(tx, {
        organizationId: table.organization_id,
        changes: [...byTable].map(([tableId, fieldIds]) => ({
          kind: 'fields' as const,
          baseId: table.base_id,
          tableId: tableId as typeof table.id,
          fieldIds,
        })),
      });
    },
  };
}
