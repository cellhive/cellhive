import type { FieldRow } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/**
 * The `parent` field of a table with sub-records (SPEC §5.7, BACKLOG
 * T405), as the record services see it: its values are the system column
 * `__parent_id` of the same table.
 */
export interface ParentFieldModel {
  readonly id: Id<'fld'>;
  readonly name: string;
  readonly row: FieldRow;
}

/** The model of a `parent` field row; `null` for any other field. */
export function toParentFieldModel(row: FieldRow): ParentFieldModel | null {
  if (row.type !== 'parent') return null;
  return { id: row.id, name: row.name, row };
}
