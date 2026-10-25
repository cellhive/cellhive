import { isId, SUBRECORD_MAX_LEVELS, type Id, RecordAncestorDto } from '@cellhive/contracts';
import {
  parentFieldType,
  type LinkRef,
  type LocaleContext,
  type UserRef,
} from '@cellhive/field-types';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { titleOf, titleUserIds } from '../links/link-reader.js';
import { dataTableRef, TARGET_ALIAS, targetReadableSql } from '../links/link-targets.js';
import { MemberDirectoryRepository } from '../member-directory.repository.js';

import { selfTarget, trashedBranchOf } from './parent-writer.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { TableRow } from '../../db/schema.js';
import type { TableModel } from '../table-model.js';
import type { CellFormat, RecordAccessContext } from '../types.js';
import type { ResolveContext } from '@cellhive/filter-dsl';

/**
 * Reads of the `parent` field and of the tree around a record (SPEC §5.7,
 * BACKLOG T405). Like a link (P20): the parent's id is always given, its
 * title only when the reader reads the parent record and the primary
 * field; a parent in the trash is no parent (the record reads as a root).
 */
export class ParentCellReader {
  private readonly members: MemberDirectoryRepository;

  constructor(db: Db) {
    this.members = new MemberDirectoryRepository(db);
  }

  /** `{ id, title }` of the live parents `ids` (one statement); trashed or missing ones are absent. */
  async refs(
    scope: OrgScope,
    model: TableModel,
    access: RecordAccessContext,
    context: ResolveContext,
    locale: LocaleContext,
    ids: readonly string[],
  ): Promise<Map<string, LinkRef>> {
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('ParentCellReader.refs needs a transaction');
    const wanted = [...new Set(ids.filter((id) => isId('rec', id)))];
    const refs = new Map<string, LinkRef>();
    if (wanted.length === 0) return refs;
    const target = selfTarget(model, access);
    const primary = target.primary;
    const readableSql =
      target.titleReadable && primary !== null
        ? targetReadableSql(target, access, context)
        : sql<SqlBool>`false`;
    const title =
      primary === null
        ? sql`NULL`
        : sql`CASE WHEN ${readableSql} THEN ${sql.id(TARGET_ALIAS, primary.column)} END`;
    const { rows } = await sql<{ id: string; readable: boolean; title: unknown }>`
      SELECT ${sql.id(TARGET_ALIAS, '__id')} AS id, (${readableSql}) AS readable, ${title} AS title
        FROM ${dataTableRef(model.table)} AS ${sql.id(TARGET_ALIAS)}
       WHERE ${sql.id(TARGET_ALIAS, '__id')} = ANY(${sql.val(wanted)}::text[])
         AND ${sql.id(TARGET_ALIAS, '__deleted_at')} IS NULL
    `.execute(tx);
    const users =
      primary === null
        ? new Map<string, UserRef>()
        : new Map(
            (
              await this.members.findMembers(
                scope,
                titleUserIds(
                  primary,
                  rows.filter((row) => row.readable).map((row) => row.title),
                ),
              )
            ).map((member) => [member.id as string, member]),
          );
    for (const row of rows) {
      refs.set(row.id, {
        id: row.id,
        title: row.readable && primary !== null ? titleOf(primary, row.title, locale, users) : null,
      });
    }
    return refs;
  }

  /**
   * Ancestors of `recordId`, root first (`GET …/ancestors`): readable ones
   * with id and title, unreadable ones as locked placeholders (no id, no
   * title); the walk stops at a parent in the trash (the record reads as
   * a root below it).
   */
  async ancestors(
    scope: OrgScope,
    model: TableModel,
    access: RecordAccessContext,
    context: ResolveContext,
    locale: LocaleContext,
    recordId: Id<'rec'>,
  ): Promise<RecordAncestorDto[]> {
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('ParentCellReader.ancestors needs a transaction');
    const ref = dataTableRef(model.table);
    const { rows } = await sql<{ id: string; d: number }>`
      WITH RECURSIVE up (id, next, d) AS (
        SELECT x.__id, x.__parent_id, 0 FROM ${ref} AS x WHERE x.__id = ${recordId}
        UNION ALL
        SELECT p.__id, p.__parent_id, up.d + 1
          FROM up JOIN ${ref} AS p ON p.__id = up.next
         WHERE p.__deleted_at IS NULL AND up.d < ${SUBRECORD_MAX_LEVELS}
      )
      SELECT id, d FROM up WHERE d > 0 ORDER BY d DESC
    `.execute(tx);
    const refs = await this.refs(
      scope,
      model,
      access,
      context,
      locale,
      rows.map((row) => row.id),
    );
    const readableIds = await readableAmong(
      scope,
      model,
      access,
      context,
      rows.map((r) => r.id),
    );
    return rows.map((row) => {
      if (!readableIds.has(row.id)) return { id: null, title: null, locked: true };
      return { id: row.id as Id<'rec'>, title: refs.get(row.id)?.title ?? null, locked: false };
    });
  }
}

/** Ids among `ids` of live records of the table the principal reads. */
export async function readableAmong(
  scope: OrgScope,
  model: TableModel,
  access: RecordAccessContext,
  context: ResolveContext,
  ids: readonly string[],
): Promise<Set<string>> {
  const tx = scope.tx;
  if (tx === undefined) throw new TypeError('readableAmong needs a transaction');
  if (ids.length === 0) return new Set();
  const target = selfTarget(model, access);
  const { rows } = await sql<{ id: string }>`
    SELECT ${sql.id(TARGET_ALIAS, '__id')} AS id
      FROM ${dataTableRef(model.table)} AS ${sql.id(TARGET_ALIAS)}
     WHERE ${sql.id(TARGET_ALIAS, '__id')} = ANY(${sql.val([...new Set(ids)])}::text[])
       AND ${sql.id(TARGET_ALIAS, '__deleted_at')} IS NULL
       AND (${targetReadableSql(target, access, context)})
  `.execute(tx);
  return new Set(rows.map((row) => row.id));
}

/** The json (or text) value of a parent cell as reads return it; `null` for a root. */
export function parentCellValue(
  ref: LinkRef | undefined,
  cellFormat: CellFormat,
  locale: LocaleContext,
): LinkRef | string | null {
  const json = parentFieldType.fromStorage(ref ?? null, {});
  return cellFormat === 'text' ? parentFieldType.formatText(json, {}, locale) : json;
}

// ---------------------------------------------------------------------------
// Tree query (CONTRACTS §1.4 `records/tree`, BACKLOG S4 open question #10)

/**
 * SQL of one level of the visible tree over the data table aliased `t`.
 *
 * - Without filter/search (`matched === null`): the visible tree is every
 *   live record the principal reads; a record whose parent is not in it
 *   (unreadable, trashed) is a root.
 * - With one: `m` = matching records, `v` = `m` plus, with
 *   `showAncestors`, their ancestors reached through live records the
 *   principal reads (the walk stops at an unreadable one: its descendants
 *   show as roots); rows of `v` not in `m` are `ancestor_only`.
 */
export interface TreeLevelSql {
  /** `WITH RECURSIVE …` prefix (empty without filter). */
  readonly with: RawBuilder<unknown>;
  /** Condition on `t`: the record is in the visible tree, at the requested level. */
  readonly level: RawBuilder<SqlBool>;
  /** Children of `t` in the visible tree. */
  readonly childrenCount: RawBuilder<unknown>;
  /** `t` is only an ancestor of a match. */
  readonly ancestorOnly: RawBuilder<unknown>;
}

export interface TreeLevelInput {
  readonly ref: RawBuilder<unknown>;
  /** Read rule over a data table aliased by the argument. */
  readonly readRule: (alias: string) => RawBuilder<SqlBool>;
  /** Every condition of the request over `t` (live, read rule, view/request filter, search). */
  readonly where: RawBuilder<SqlBool>;
  /** Whether `where` narrows the read beyond live + read rule. */
  readonly filtered: boolean;
  readonly showAncestors: boolean;
  /** `null`: roots; else children of this record. */
  readonly parentId: string | null;
}

const t = (column: string) => sql.id('t', column);

export function treeLevelSql(input: TreeLevelInput): TreeLevelSql {
  const { ref, readRule } = input;
  if (!input.filtered) {
    const visibleParent = sql<SqlBool>`EXISTS (
      SELECT 1 FROM ${ref} AS p
       WHERE p.__id = ${t('__parent_id')} AND p.__deleted_at IS NULL AND (${readRule('p')})
    )`;
    return {
      with: sql``,
      level:
        input.parentId === null
          ? // Also true without a parent (`NULL` matches nothing): a plain anti-join.
            sql<SqlBool>`NOT ${visibleParent}`
          : sql<SqlBool>`${t('__parent_id')} = ${input.parentId}`,
      childrenCount: sql`(
        SELECT count(*) FROM ${ref} AS c
         WHERE c.__parent_id = ${t('__id')} AND c.__deleted_at IS NULL AND (${readRule('c')})
      )`,
      ancestorOnly: sql`false`,
    };
  }
  const ancestors = input.showAncestors
    ? sql`,
      anc (id, parent, d) AS (
        SELECT p.__id, p.__parent_id, 1
          FROM ${ref} AS p JOIN m ON p.__id = m.parent
         WHERE p.__deleted_at IS NULL AND (${readRule('p')})
        UNION
        SELECT p.__id, p.__parent_id, anc.d + 1
          FROM ${ref} AS p JOIN anc ON p.__id = anc.parent
         WHERE p.__deleted_at IS NULL AND (${readRule('p')}) AND anc.d < ${SUBRECORD_MAX_LEVELS}
      ),
      v (id, parent, matched) AS (
        SELECT id, parent, true FROM m
        UNION ALL
        SELECT DISTINCT id, parent, false FROM anc WHERE NOT EXISTS (SELECT 1 FROM m WHERE m.id = anc.id)
      )`
    : sql`,
      v (id, parent, matched) AS (SELECT id, parent, true FROM m)`;
  return {
    with: sql`WITH RECURSIVE m (id, parent) AS MATERIALIZED (
        SELECT ${t('__id')}, ${t('__parent_id')} FROM ${ref} AS t WHERE ${input.where}
      )${ancestors}`,
    level:
      input.parentId === null
        ? sql<SqlBool>`EXISTS (
            SELECT 1 FROM v WHERE v.id = ${t('__id')}
               AND (v.parent IS NULL OR NOT EXISTS (SELECT 1 FROM v AS vp WHERE vp.id = v.parent))
          )`
        : sql<SqlBool>`EXISTS (SELECT 1 FROM v WHERE v.id = ${t('__id')} AND v.parent = ${input.parentId})`,
    childrenCount: sql`(SELECT count(*) FROM v AS c WHERE c.parent = ${t('__id')})`,
    ancestorOnly: sql`NOT EXISTS (SELECT 1 FROM m WHERE m.id = ${t('__id')})`,
  };
}

/**
 * Depth of `parentId` in the visible tree (0 for a root), or `null` when it
 * is not in the visible tree (unreadable, trashed, or — filtered — neither
 * a match nor an ancestor of one). Runs after `level.with`.
 */
export function parentDepthSql(input: TreeLevelInput, parentId: string): RawBuilder<unknown> {
  const { ref, readRule } = input;
  if (!input.filtered) {
    return sql`WITH RECURSIVE up (id, next, d) AS (
        SELECT p.__id, p.__parent_id, 0 FROM ${ref} AS p
         WHERE p.__id = ${parentId} AND p.__deleted_at IS NULL AND (${readRule('p')})
        UNION ALL
        SELECT a.__id, a.__parent_id, up.d + 1
          FROM up JOIN ${ref} AS a ON a.__id = up.next
         WHERE a.__deleted_at IS NULL AND (${readRule('a')}) AND up.d < ${SUBRECORD_MAX_LEVELS}
      )
      SELECT max(d)::int AS depth FROM up`;
  }
  return sql`${treeLevelSql(input).with},
      up (id, next, d) AS (
        SELECT v.id, v.parent, 0 FROM v WHERE v.id = ${parentId}
        UNION ALL
        SELECT v.id, v.parent, up.d + 1 FROM up JOIN v ON v.id = up.next WHERE up.d < ${SUBRECORD_MAX_LEVELS}
      )
      SELECT max(d)::int AS depth FROM up`;
}

/**
 * Trash (CONTRACTS §11.3): for each trashed record of `ids`, how many of
 * its descendants were deleted together with it and are in the caller's
 * trash (`inTrash`: the trash conditions over alias `t`); records without
 * any are absent.
 */
export async function trashedBranchSizes(
  tx: Tx,
  table: TableRow,
  ids: readonly string[],
  inTrash: RawBuilder<SqlBool>,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const branch = await trashedBranchOf(tx, table, ids);
  if (branch.length === 0) return sizes;
  const { rows } = await sql<{ id: string }>`
    SELECT ${t('__id')} AS id FROM ${dataTableRef(table)} AS t
     WHERE ${t('__id')} = ANY(${sql.val(branch.map((row) => row.id))}::text[]) AND ${inTrash}
  `.execute(tx);
  const visible = new Set(rows.map((row) => row.id));
  for (const row of branch) {
    if (visible.has(row.id)) sizes.set(row.root, (sizes.get(row.root) ?? 0) + 1);
  }
  return sizes;
}
