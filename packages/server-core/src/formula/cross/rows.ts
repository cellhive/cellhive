import { sql } from 'kysely';

import { assertDataTableName, DATA_SCHEMA } from '../../schema/names.js';
import { PARENT_COLUMN } from '../../schema/physical.js';

import type { LinkFieldModel } from '../../records/links/link-model.js';
import type { TableModel } from '../../records/table-model.js';
import type { Sql } from '../values.js';

/**
 * A set of records of one table, not materialised (BACKLOG T455): the FROM
 * items, conditions and order of a subquery in which the records are
 * aliased `alias`. `[Table]`, link cells, chains of links, FILTER and SORTBY
 * results are record sets; they become SQL only where a value is needed
 * (`.[Field]`, COUNTIF, SUM of a column…), as one correlated subquery.
 *
 * `where` always holds the live-record condition (`__deleted_at IS NULL`)
 * and the viewer's scope of every table joined in. Aliases are code
 * constants with a counter (`fr1`, `fj2`…); identifiers come from meta
 * through `sql.id` (golden rule 2).
 */
export interface RowSet {
  readonly tableId: string;
  /** `null`: the table is missing or in the trash — no records (then `from` is empty). */
  readonly model: TableModel | null;
  readonly alias: string;
  readonly from: Sql;
  readonly where: readonly Sql[];
  /** ORDER BY items (each may carry `ASC`/`DESC NULLS LAST`); empty: unordered (one record). */
  readonly order: readonly Sql[];
}

export const isEmpty = (rows: RowSet): boolean => rows.model === null;

export function dataTable(model: TableModel): Sql {
  return sql.id(DATA_SCHEMA, assertDataTableName(model.table.db_table_name));
}

/** `sql.id` of the junction of a link (its name was checked by `toLinkFieldModel`). */
export function junctionTable(link: LinkFieldModel): Sql {
  return sql.id(DATA_SCHEMA, link.junction);
}

export function conjunction(items: readonly Sql[]): Sql {
  if (items.length === 0) return sql`true`;
  return sql.join(
    items.map((item) => sql`(${item})`),
    sql` AND `,
  );
}

/** `SELECT <select> FROM … WHERE … [ORDER BY …]<suffix>` over the records of `rows`. */
export function selectOver(
  rows: RowSet,
  select: Sql,
  options: { where?: readonly Sql[]; ordered?: boolean; suffix?: Sql } = {},
): Sql {
  const where = conjunction([...rows.where, ...(options.where ?? [])]);
  const order =
    options.ordered !== false && rows.order.length > 0
      ? sql` ORDER BY ${sql.join(rows.order)}`
      : sql``;
  return sql`SELECT ${select} FROM ${rows.from} WHERE ${where}${order}${options.suffix ?? sql``}`;
}

/** Builds record sets; one per compiled formula (the alias counter). */
export class RowSets {
  private counter: number;

  constructor(
    private readonly tables: (tableId: string) => TableModel | null,
    private readonly scope: ((tableId: string, alias: string) => Sql | null) | undefined,
    aliasBase = 0,
  ) {
    this.counter = aliasBase;
  }

  alias(prefix: 'fr' | 'fj' | 'fu' | 'fe'): string {
    this.counter += 1;
    return `${prefix}${String(this.counter)}`;
  }

  model(tableId: string): TableModel | null {
    return this.tables(tableId);
  }

  empty(tableId: string): RowSet {
    return { tableId, model: null, alias: this.alias('fr'), from: sql``, where: [], order: [] };
  }

  /** Live records of `model` aliased `alias`, in the viewer's scope. */
  private live(model: TableModel, alias: string): Sql[] {
    const out = [sql`${sql.id(alias, '__deleted_at')} IS NULL`];
    const scope = this.scope?.(model.table.id, alias) ?? null;
    if (scope !== null) out.push(scope);
    return out;
  }

  /** `[Table]`: every live record, in creation order. */
  table(tableId: string): RowSet {
    const model = this.tables(tableId);
    if (model === null) return this.empty(tableId);
    const alias = this.alias('fr');
    return {
      tableId,
      model,
      alias,
      from: sql`${dataTable(model)} AS ${sql.id(alias)}`,
      where: this.live(model, alias),
      order: [sql.id(alias, '__auto')],
    };
  }

  /**
   * The link cell of the record `owner` (an `__id` expression): live linked
   * records through the junction, read from the field's side — link order
   * (`position`) on side `a`, creation order on side `b` (SPEC §5.6,
   * `cellOrder` of the link reader).
   */
  link(link: LinkFieldModel, owner: Sql): RowSet {
    const model = this.tables(link.targetTableId);
    if (model === null) return this.empty(link.targetTableId);
    const alias = this.alias('fr');
    const junction = this.alias('fj');
    return {
      tableId: link.targetTableId,
      model,
      alias,
      from: sql`${junctionTable(link)} AS ${sql.id(junction)} JOIN ${dataTable(model)} AS ${sql.id(alias)} ON ${sql.id(alias, '__id')} = ${sql.id(junction, link.otherColumn)}`,
      where: [sql`${sql.id(junction, link.ownColumn)} = ${owner}`, ...this.live(model, alias)],
      order: linkOrder(link, junction, alias),
    };
  }

  /** The `parent` cell of a record whose `__parent_id` is `parentId`. */
  parent(tableId: string, parentId: Sql): RowSet {
    const model = this.tables(tableId);
    if (model === null) return this.empty(tableId);
    const alias = this.alias('fr');
    return {
      tableId,
      model,
      alias,
      from: sql`${dataTable(model)} AS ${sql.id(alias)}`,
      where: [sql`${sql.id(alias, '__id')} = ${parentId}`, ...this.live(model, alias)],
      order: [],
    };
  }

  /** Records of a `text[]` of ids (a list of records as a value), in list order. */
  ids(tableId: string, ids: Sql): RowSet {
    const model = this.tables(tableId);
    if (model === null) return this.empty(tableId);
    const alias = this.alias('fr');
    const list = this.alias('fu');
    return {
      tableId,
      model,
      alias,
      from: sql`unnest(${ids}) WITH ORDINALITY AS ${sql.id(list)}(id, i) JOIN ${dataTable(model)} AS ${sql.id(alias)} ON ${sql.id(alias, '__id')} = ${sql.id(list, 'id')}`,
      where: this.live(model, alias),
      order: [sql.id(list, 'i')],
    };
  }

  /**
   * `rows.[Link]`: the linked records of every record of `rows`, flattened
   * in the order of `rows` then of each cell (a record linked from two
   * records appears twice). One join, no subquery per record.
   */
  chainLink(rows: RowSet, link: LinkFieldModel): RowSet {
    const model = rows.model === null ? null : this.tables(link.targetTableId);
    if (model === null) return this.empty(link.targetTableId);
    const alias = this.alias('fr');
    const junction = this.alias('fj');
    return {
      tableId: link.targetTableId,
      model,
      alias,
      from: sql`${rows.from} JOIN ${junctionTable(link)} AS ${sql.id(junction)} ON ${sql.id(junction, link.ownColumn)} = ${sql.id(rows.alias, '__id')} JOIN ${dataTable(model)} AS ${sql.id(alias)} ON ${sql.id(alias, '__id')} = ${sql.id(junction, link.otherColumn)}`,
      where: [...rows.where, ...this.live(model, alias)],
      order: [...rows.order, ...linkOrder(link, junction, alias)],
    };
  }

  /** `rows.[Parent]`: the parent of every record of `rows` (same table), in the order of `rows`. */
  chainParent(rows: RowSet): RowSet {
    const model = rows.model;
    if (model === null) return this.empty(rows.tableId);
    const alias = this.alias('fr');
    return {
      tableId: rows.tableId,
      model,
      alias,
      from: sql`${rows.from} JOIN ${dataTable(model)} AS ${sql.id(alias)} ON ${sql.id(alias, '__id')} = ${sql.id(rows.alias, PARENT_COLUMN)}`,
      where: [...rows.where, ...this.live(model, alias)],
      order: rows.order,
    };
  }
}

function linkOrder(link: LinkFieldModel, junction: string, alias: string): Sql[] {
  return link.side === 'a'
    ? [sql.id(junction, 'position'), sql.id(alias, '__auto')]
    : [sql.id(alias, '__auto')];
}
