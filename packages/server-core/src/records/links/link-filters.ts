import { collectFieldIds, type FilterNode } from '@cellhive/filter-dsl';

import { TablesRepository } from '../../schema/tables.repository.js';

import type { LinkFieldModel } from './link-model.js';
import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { TableRow } from '../../db/schema.js';
import type { SqlFilterFieldMeta } from '../../query/index.js';
import type { TableModel } from '../table-model.js';

/**
 * Filters on `link` fields (SPEC §6.2, BACKLOG T402): `has_any_of`,
 * `has_all_of`, `has_none_of`, `is_exactly`, `is_empty`, `is_not_empty`
 * over the ids of the **live** linked records of a cell, compiled by
 * `compileToSql` as a subquery on the junction (the same semantics as the
 * evaluator on a storage-form cell: an array of record ids).
 *
 * Request filters, saved view filters (and the realtime view scope built
 * from them) and, since T710, record rules of roles (`edit_filter`,
 * `read_filter`, CONTRACTS §14) use link conditions. `TableModel.filterMeta`
 * stays without links (in-memory evaluation of column values);
 * `queryFilterMeta` gets them here.
 */

/** The filter meta of `link` as a field of its own table (`targetTable`: `null` when trashed). */
export function linkFilterFieldMeta(
  link: LinkFieldModel,
  sourceTable: TableRow,
  targetTable: TableRow | null,
): SqlFilterFieldMeta {
  return {
    id: link.id,
    name: link.name,
    type: 'link',
    options: link.row.options,
    link: {
      junction: link.junction,
      ownColumn: link.ownColumn,
      otherColumn: link.otherColumn,
      sourceTable: sourceTable.db_table_name,
      targetTable: targetTable?.db_table_name ?? null,
    },
  };
}

/**
 * `model` with `queryFilterMeta` = its column fields plus every active link
 * field, the linked tables given by `targetOf` (`null`/`undefined`: in the
 * trash, purged or of another base — the field's cells read empty).
 */
export function withLinkFilterMeta(
  model: TableModel,
  targetOf: (tableId: string) => TableRow | null | undefined,
): TableModel {
  if (model.links.length === 0) return model;
  return {
    ...model,
    queryFilterMeta: {
      ...model.filterMeta,
      fields: [
        ...model.filterMeta.fields,
        ...model.links.map((link) => {
          const target =
            link.targetTableId === model.table.id ? model.table : targetOf(link.targetTableId);
          return linkFilterFieldMeta(
            link,
            model.table,
            target !== undefined && target !== null && target.base_id === model.table.base_id
              ? target
              : null,
          );
        }),
      ],
    },
  };
}

/**
 * Whether one of `filters` (record rules of the model's table) names a link
 * field of the table (T710): such a rule needs `queryFilterMeta` with links
 * to validate and compile, and the edit rule is then checked in SQL after
 * the write (`RecordMutationService`).
 */
export function filtersNameLinks(
  model: TableModel,
  filters: readonly (FilterNode | null | undefined)[],
): boolean {
  if (model.links.length === 0) return false;
  const ids = new Set<string>(model.links.map((link) => link.id));
  return filters.some(
    (filter) =>
      filter !== null && filter !== undefined && collectFieldIds(filter).some((id) => ids.has(id)),
  );
}

/** The record rules of `rules` (`internal.readFilters` / `editFilters`) on the model's table. */
export function rulesOf(
  model: TableModel,
  ...rules: readonly Readonly<Record<string, FilterNode | null>>[]
): (FilterNode | null | undefined)[] {
  return rules.map((byTable) =>
    Object.hasOwn(byTable, model.table.id) ? byTable[model.table.id] : undefined,
  );
}

/** Adds the link fields of a table model to its query filter meta (`queryFilterMeta`). */
export class LinkFilterMeta {
  private readonly tables: TablesRepository;

  constructor(db: Db) {
    this.tables = new TablesRepository(db);
  }

  /**
   * `model` with `queryFilterMeta` = its column fields plus every active
   * link field; a linked table in the trash (or of another base) makes the
   * field's cells read empty in filters, like in reads (CONTRACTS §13).
   */
  async withLinks(scope: OrgScope, model: TableModel): Promise<TableModel> {
    if (model.links.length === 0) return model;
    const targets = new Map<string, TableRow | null>();
    for (const link of model.links) {
      if (targets.has(link.targetTableId) || link.targetTableId === model.table.id) continue;
      targets.set(
        link.targetTableId,
        (await this.tables.getById(scope, link.targetTableId)) ?? null,
      );
    }
    return withLinkFilterMeta(model, (tableId) => targets.get(tableId));
  }

  /**
   * `model` with its link fields in `queryFilterMeta` only when one of the
   * record rules `rules` names one (T710), else `model` unchanged — no
   * extra read for the rules of every role that names no link field.
   */
  async forRules(
    scope: OrgScope,
    model: TableModel,
    rules: readonly (FilterNode | null | undefined)[],
  ): Promise<TableModel> {
    return filtersNameLinks(model, rules) ? this.withLinks(scope, model) : model;
  }
}
