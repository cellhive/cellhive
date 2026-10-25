import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { FieldsRepository } from '../../schema/fields.repository.js';
import { assertDataTableName, DATA_SCHEMA } from '../../schema/names.js';
import { TablesRepository } from '../../schema/tables.repository.js';
import {
  buildTableModel,
  readable,
  resolveRule,
  ruleSql,
  type FieldModel,
  type TableModel,
} from '../table-model.js';

import { LinkFilterMeta, rulesOf } from './link-filters.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { TableRow } from '../../db/schema.js';
import type { RecordAccessContext } from '../types.js';
import type { Id } from '@cellhive/contracts';
import type { ResolveContext } from '@cellhive/filter-dsl';
import type { TableAccess } from '@cellhive/permissions';

/**
 * The linked table of a link field, as one principal sees it (BACKLOG T401,
 * P20): its fields, its primary field (the title of linked records), and
 * whether the principal reads the table, the primary field and which
 * records (the table's read rule).
 */
export interface LinkTarget {
  readonly table: TableRow;
  /** Model with the principal's field perms (nothing visible without table access). */
  readonly model: TableModel;
  /** The active primary field; `null` if the table has none the record services support. */
  readonly primary: FieldModel | null;
  /** The principal's access to the table; `null` = `no_perm` (or not in the access). */
  readonly access: TableAccess | null;
  /** The principal reads the table and its primary field: titles may be shown. */
  readonly titleReadable: boolean;
}

/** Alias of the linked table in link statements. Code constant, never input. */
export const TARGET_ALIAS = 't';

export function dataTableRef(table: TableRow): RawBuilder<unknown> {
  return sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name));
}

/** Loads linked tables (once per table and call). */
export class LinkTargets {
  private readonly tables: TablesRepository;
  private readonly fields: FieldsRepository;
  private readonly linkFilters: LinkFilterMeta;

  constructor(db: Db) {
    this.tables = new TablesRepository(db);
    this.fields = new FieldsRepository(db);
    this.linkFilters = new LinkFilterMeta(db);
  }

  /**
   * The linked table `tableId` for `access`, or `null` when it does not
   * exist, is in the trash (its link cells read empty, CONTRACTS §13) or
   * belongs to another base.
   */
  async load(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    cache?: Map<string, LinkTarget | null>,
  ): Promise<LinkTarget | null> {
    const cached = cache?.get(tableId);
    if (cached !== undefined) return cached;
    const table = await this.tables.getById(scope, tableId);
    let target: LinkTarget | null = null;
    if (table?.base_id === access.baseId) {
      const tableAccess = accessibleTable(access, tableId);
      const built = buildTableModel(
        table,
        await this.fields.listByTable(scope, tableId),
        tableAccess,
      );
      // A read rule naming link fields (T710) compiles with the link meta.
      const model = await this.linkFilters.forRules(
        scope,
        built,
        rulesOf(built, access.resolved.internal.readFilters),
      );
      const primary = model.fields.find((field) => field.isPrimary) ?? null;
      target = {
        table,
        model,
        primary,
        access: tableAccess,
        titleReadable: primary !== null && readable(tableAccess, primary.id),
      };
    }
    cache?.set(tableId, target);
    return target;
  }
}

/**
 * The access context to read the linked table `tableId` with: the
 * principal's own when the table is in its access, else its
 * `relatedAccess` (share links: the creator's access to other tables).
 */
export function relatedAccessContext(
  access: RecordAccessContext,
  tableId: Id<'tbl'>,
): RecordAccessContext {
  const related = access.relatedAccess;
  if (related === undefined || Object.hasOwn(access.resolved.access.tables, tableId)) {
    return access;
  }
  return { ...access, resolved: related };
}

/** The principal's access to a table, `null` for `no_perm` or a table not in its access. */
export function accessibleTable(
  access: RecordAccessContext,
  tableId: Id<'tbl'>,
): TableAccess | null {
  const tableAccess = access.resolved.access.tables[tableId];
  if (tableAccess === undefined) return null;
  const perm: string = tableAccess.perm;
  return perm === 'no_perm' ? null : tableAccess;
}

/**
 * SQL condition "the principal reads this record of the linked table"
 * (aliased {@link TARGET_ALIAS}): table access AND its read rule (a rule
 * that no longer validates reads nothing, like `RecordQueryService`).
 */
export function targetReadableSql(
  target: LinkTarget,
  access: RecordAccessContext,
  context: ResolveContext,
): RawBuilder<SqlBool> {
  if (target.access === null) return sql<SqlBool>`false`;
  const rule = resolveRule(access.resolved.internal.readFilters, target.model, context);
  return ruleSql(rule, target.model, TARGET_ALIAS);
}

/**
 * How a title (typecast of a link or `parent` cell) matched the live
 * records of the linked table the principal reads: one record, none, or
 * several (`ambiguous`).
 */
export type TitleMatch = { readonly id: string } | 'none' | 'ambiguous';

/**
 * Exact matches of `titles` on the primary field of `target` among its
 * live records the principal reads (CONTRACTS §2 typecast), one grouped
 * statement for all titles. Without a readable text/auto-number primary
 * field every title is `none`.
 */
export async function matchTitles(
  tx: Tx,
  target: LinkTarget | null,
  access: RecordAccessContext,
  context: ResolveContext,
  titles: readonly string[],
): Promise<Map<string, TitleMatch>> {
  const distinct = [...new Set(titles)];
  const found = new Map<string, TitleMatch>(distinct.map((title) => [title, 'none']));
  const primary = target?.primary ?? null;
  if (target === null || primary === null || !target.titleReadable || distinct.length === 0) {
    return found;
  }
  if (primary.type !== 'text' && primary.type !== 'auto_number') return found;
  const column = sql.id(TARGET_ALIAS, primary.column);
  const { rows } = await sql<{ title: string; n: number; id: string }>`
    SELECT ${column} AS title, count(*)::int AS n, min(${sql.id(TARGET_ALIAS, '__id')}) AS id
      FROM ${dataTableRef(target.table)} AS ${sql.id(TARGET_ALIAS)}
     WHERE ${column} = ANY(${sql.val(distinct)}::text[])
       AND ${sql.id(TARGET_ALIAS, '__deleted_at')} IS NULL
       AND (${targetReadableSql(target, access, context)})
     GROUP BY ${column}
  `.execute(tx);
  for (const row of rows) {
    if (!found.has(row.title)) continue;
    found.set(row.title, row.n === 1 ? { id: row.id } : 'ambiguous');
  }
  return found;
}
