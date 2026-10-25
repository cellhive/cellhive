import { TablesRepository } from '../schema/tables.repository.js';

import type { Db } from '../db/create-db.js';
import type { OrgScope } from '../db/repository.js';
import type { RecordQueryService } from '../records/record-query.service.js';
import type { RecordAccessContext } from '../records/types.js';
import type { Id } from '@cellhive/contracts';

/**
 * Titles (primary field as text) of records of one table **as `access`
 * reads them** (CONTRACTS §22): a record the reader cannot read — gone, in
 * the trash, outside the read rule — has no entry; a readable record whose
 * primary field the reader cannot read gets `null` (shown without a title).
 * Reads go through `RecordQueryService` (AGENTS.md rule 1).
 */
export async function readableRecordTitles(
  db: Db,
  query: RecordQueryService,
  scope: OrgScope,
  access: RecordAccessContext,
  tableId: Id<'tbl'>,
  recordIds: readonly string[],
): Promise<Map<string, string | null>> {
  const titles = new Map<string, string | null>();
  const tableAccess = access.resolved.access.tables[tableId];
  if (tableAccess === undefined || recordIds.length === 0) return titles;
  const table = await new TablesRepository(db).getById(scope, tableId);
  if (table === undefined || table.deleted_at !== null) return titles;
  const readable = Object.keys(tableAccess.fields) as Id<'fld'>[];
  const primary = table.primary_field_id;
  const titleField = primary !== null && readable.includes(primary) ? primary : null;
  // Without the primary field, any readable field proves the record is readable.
  const probe = titleField ?? readable[0];
  if (probe === undefined) return titles;
  const records = await query.getRecords(scope, tableId, recordIds, access, {
    field_key_type: 'id',
    cell_format: 'text',
    fields: [probe],
  });
  for (const record of records) {
    const value = titleField === null ? undefined : record.fields[titleField];
    // `cell_format=text` gives a string; an empty cell is absent or `null`.
    titles.set(record.id, titleField === null ? null : typeof value === 'string' ? value : '');
  }
  return titles;
}
