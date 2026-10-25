import { sql } from 'kysely';

import { accessibleTable, relatedAccessContext } from '../../records/links/link-targets.js';
import { resolveRule, ruleSql, type TableModel } from '../../records/table-model.js';

import type { RecordAccessContext } from '../../records/types.js';
import type { Sql } from '../values.js';
import type { Id } from '@cellhive/contracts';
import type { ResolveContext } from '@cellhive/filter-dsl';

/**
 * `CrossTableContext.sourceScope` for a viewer (Câu hỏi mở S4b #1b, P20):
 * on each source table, its read rule (record rule of the viewer's roles,
 * variables resolved for the viewer), `false` when the viewer cannot read
 * the table, `null` (no filter) when every record is readable. Share links
 * read other tables with their creator's access (`relatedAccess`, T409), as
 * link titles do. Never the field creator's access.
 */
export function viewerSourceScope(
  access: RecordAccessContext,
  context: ResolveContext,
  tables: (tableId: string) => TableModel | null,
): (tableId: string, alias: string) => Sql | null {
  return (tableId, alias) => {
    const model = tables(tableId);
    if (model === null) return sql`false`;
    const id = tableId as Id<'tbl'>;
    const related = relatedAccessContext(access, id);
    if (accessibleTable(related, id) === null) return sql`false`;
    const rule = resolveRule(related.resolved.internal.readFilters, model, context);
    return rule === 'all' ? null : ruleSql(rule, model, alias);
  };
}
