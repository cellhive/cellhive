import type { AutomationRecordReader } from './evaluator.js';
import type { OrgScope } from '../../db/repository.js';
import type { RecordQueryService } from '../../records/record-query.service.js';
import type { RecordAccessContext } from '../../records/types.js';
import type { Id } from '@cellhive/contracts';

/**
 * The records templates read, through the single read path of SPEC §7.2
 * (`RecordQueryService.getRecords`): with `access` = the effective access of
 * `run_as` at run time (ADR-25 §1), JSON cells keyed by field id. Records
 * outside the read rule, in the trash or missing are left out; fields
 * `run_as` cannot read are absent.
 */
export function recordQueryReader(
  records: RecordQueryService,
  scope: OrgScope,
  access: RecordAccessContext,
): AutomationRecordReader {
  return {
    async read(tableId: Id<'tbl'>, recordIds: readonly string[], fieldIds: readonly string[]) {
      if (recordIds.length === 0) return [];
      const found = await records.getRecords(scope, tableId, recordIds, access, {
        field_key_type: 'id',
        cell_format: 'json',
        fields: [...fieldIds],
      });
      return found.map((record) => ({ id: record.id, fields: record.fields }));
    },
  };
}
