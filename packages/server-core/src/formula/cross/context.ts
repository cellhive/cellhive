import type { TableModel } from '../../records/table-model.js';
import type { ComputedFieldSql } from '../context.js';
import type { Sql } from '../values.js';

/**
 * What the cross-table compiler (BACKLOG T455) needs besides the same-row
 * context: the tables of the base, as meta models, and the viewer's read
 * scope on them.
 */
export interface CrossTableContext {
  /** The formula's table: its link and `parent` fields (`TableModel.links`, `.parent`). */
  readonly self: TableModel;
  /**
   * Model of a table of the formula's base. `null` for a table that is
   * missing, in the trash or purged: it reads as a table without records,
   * and link cells into it read empty (CONTRACTS §13).
   */
  table(tableId: string): TableModel | null;
  /**
   * Permission hook (Câu hỏi mở S4b #1b, T457): the viewer's read scope on a
   * source table as a condition over its rows aliased `alias` (read rule,
   * `false` without access), or `null` for no restriction — the value of a
   * `stored` field, computed for every record. Applied to every table the
   * formula reads records of (links, `[Table]`, lookups; self-links too),
   * never to the formula's own row. The compiler never reads permissions
   * itself, and never uses the field creator's.
   */
  sourceScope?(tableId: string, alias: string): Sql | null;
  /**
   * Computed fields (formula/lookup) of a table of the base, by field id
   * (T456): they are not in `TableModel.fields`. Absent: no computed field
   * can be read.
   */
  computed?(tableId: string): ReadonlyMap<string, ComputedFieldSql>;
  /**
   * First alias number of the record sets of this compilation (default 0):
   * a virtual computed field inlined into another formula's subquery counts
   * from elsewhere so its aliases never shadow the enclosing ones (T456).
   */
  readonly aliasBase?: number;
}
