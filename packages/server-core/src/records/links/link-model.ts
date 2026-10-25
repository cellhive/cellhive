import { linkOptionsSchema, type LinkOptions } from '@cellhive/field-types';

import { assertJunctionTableName } from '../../schema/names.js';

import type { FieldRow, LinkSide } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/** A junction column (SPEC §5.6): `a_id` for the side that created it, `b_id` for the reverse. */
export type JunctionColumn = 'a_id' | 'b_id';

/**
 * A `link` field as the record services see it (BACKLOG T401): its options
 * and where its values live — the junction `data.l_<shortId>`, read from
 * this field's side (`own` column = records of this table, `other` column
 * = linked records).
 */
export interface LinkFieldModel {
  readonly id: Id<'fld'>;
  readonly name: string;
  readonly options: LinkOptions;
  readonly junction: string;
  readonly side: LinkSide;
  readonly ownColumn: JunctionColumn;
  readonly otherColumn: JunctionColumn;
  /** The linked table (`options.link_table`). */
  readonly targetTableId: Id<'tbl'>;
  readonly row: FieldRow;
}

/** The model of a `link` field row; `null` for any other field (or a link without junction). */
export function toLinkFieldModel(row: FieldRow): LinkFieldModel | null {
  if (row.type !== 'link' || row.link_junction === null || row.link_side === null) return null;
  // Meta is trusted and written through the same schema: a parse error is a bug.
  const options = linkOptionsSchema.parse(row.options ?? {});
  const side = row.link_side;
  return {
    id: row.id,
    name: row.name,
    options,
    junction: assertJunctionTableName(row.link_junction),
    side,
    ownColumn: side === 'a' ? 'a_id' : 'b_id',
    otherColumn: side === 'a' ? 'b_id' : 'a_id',
    targetTableId: options.link_table,
    row,
  };
}
