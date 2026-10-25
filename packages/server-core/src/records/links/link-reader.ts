import { isId, type Id } from '@cellhive/contracts';
import {
  linkFieldType,
  type LinkRef,
  type LocaleContext,
  type UserRef,
} from '@cellhive/field-types';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { DATA_SCHEMA } from '../../schema/names.js';
import { MemberDirectoryRepository } from '../member-directory.repository.js';

import {
  dataTableRef,
  LinkTargets,
  relatedAccessContext,
  TARGET_ALIAS,
  targetReadableSql,
  type LinkTarget,
} from './link-targets.js';

import type { LinkFieldModel } from './link-model.js';
import type { Db, Tx } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { FieldModel } from '../table-model.js';
import type { CellFormat, RecordAccessContext } from '../types.js';
import type { ResolveContext } from '@cellhive/filter-dsl';

/** Alias of the junction in link statements. Code constant, never input. */
const JUNCTION_ALIAS = 'j';

/** Link cells by field id, then by record id (records without links are absent). */
export type LinkCells = Map<Id<'fld'>, Map<string, LinkRef[]>>;

export interface LinkReadRequest {
  readonly links: readonly LinkFieldModel[];
  readonly recordIds: readonly string[];
  readonly access: RecordAccessContext;
  readonly context: ResolveContext;
  readonly locale: LocaleContext;
}

interface LinkRow {
  readonly src: string;
  readonly dst: string;
  readonly readable: boolean;
  readonly title: unknown;
}

export const junctionRef = (link: Pick<LinkFieldModel, 'junction'>): RawBuilder<unknown> =>
  sql.id(DATA_SCHEMA, link.junction);

/** `ORDER BY` of a cell: link order on the `a` side, creation order of the linked records on `b`. */
export function cellOrder(link: LinkFieldModel): RawBuilder<unknown> {
  return link.side === 'a'
    ? sql`${sql.id(JUNCTION_ALIAS, 'position')}, ${sql.id(TARGET_ALIAS, '__auto')}`
    : sql`${sql.id(TARGET_ALIAS, '__auto')}`;
}

/** The title (`cell_format=text` of the primary field) of a stored primary value. */
export function titleOf(
  primary: FieldModel,
  raw: unknown,
  locale: LocaleContext,
  users: ReadonlyMap<string, UserRef>,
): string {
  const json = primary.definition.fromStorage(raw, primary.options, {
    resolveUser: (id) => users.get(id),
  });
  return primary.definition.formatText(json, primary.options, locale);
}

/** User ids in stored primary values of user-like types (their titles are member names). */
export function titleUserIds(primary: FieldModel, raws: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const raw of raws) {
    if (primary.type === 'user' && Array.isArray(raw)) {
      for (const id of raw) if (typeof id === 'string') ids.add(id);
    } else if (
      (primary.type === 'created_by' || primary.type === 'updated_by') &&
      typeof raw === 'string'
    ) {
      ids.add(raw);
    }
  }
  return [...ids];
}

/**
 * Reads link cells (BACKLOG T401, CONTRACTS §2): for each link field one
 * statement for the whole page (junction ⋈ linked table, `own = ANY(ids)`,
 * using the junction's primary key or `b_id` index), in link order.
 *
 * - linked records in the trash are left out (a restore brings them back);
 * - a linked table in the trash (or gone) gives empty cells;
 * - `title` is the primary field of the linked record as text, and `null`
 *   when the reader cannot read the linked table, its primary field or the
 *   record (its read rule): the id is still returned (P20).
 */
export class LinkCellReader {
  private readonly targets: LinkTargets;
  private readonly members: MemberDirectoryRepository;

  constructor(db: Db) {
    this.targets = new LinkTargets(db);
    this.members = new MemberDirectoryRepository(db);
  }

  async read(scope: OrgScope, request: LinkReadRequest): Promise<LinkCells> {
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('LinkCellReader.read needs a transaction');
    const cells: LinkCells = new Map();
    const ids = [...new Set(request.recordIds.filter((id) => isId('rec', id)))];
    if (ids.length === 0 || request.links.length === 0) return cells;
    const cache = new Map<string, LinkTarget | null>();
    for (const link of request.links) {
      // Titles of another table under `relatedAccess` (share links: the creator's, T409).
      const access = relatedAccessContext(request.access, link.targetTableId);
      const target = await this.targets.load(scope, link.targetTableId, access, cache);
      const byRecord = new Map<string, LinkRef[]>();
      cells.set(link.id, byRecord);
      if (target === null) continue;
      const rows = await this.rows(tx, link, target, ids, { ...request, access });
      const users =
        target.primary === null
          ? new Map<string, UserRef>()
          : new Map(
              (
                await this.members.findMembers(
                  scope,
                  titleUserIds(
                    target.primary,
                    rows.filter((row) => row.readable).map((row) => row.title),
                  ),
                )
              ).map((member) => [member.id as string, member]),
            );
      for (const row of rows) {
        const title =
          row.readable && target.primary !== null
            ? titleOf(target.primary, row.title, request.locale, users)
            : null;
        const list = byRecord.get(row.src) ?? [];
        list.push({ id: row.dst, title });
        byRecord.set(row.src, list);
      }
    }
    return cells;
  }

  private async rows(
    tx: Tx,
    link: LinkFieldModel,
    target: LinkTarget,
    ids: readonly string[],
    request: LinkReadRequest,
  ): Promise<LinkRow[]> {
    const readableSql =
      target.titleReadable && target.primary !== null
        ? targetReadableSql(target, request.access, request.context)
        : sql<SqlBool>`false`;
    const title =
      target.primary === null
        ? sql`NULL`
        : sql`CASE WHEN ${readableSql} THEN ${sql.id(TARGET_ALIAS, target.primary.column)} END`;
    const own = sql.id(JUNCTION_ALIAS, link.ownColumn);
    const other = sql.id(JUNCTION_ALIAS, link.otherColumn);
    const { rows } = await sql<LinkRow>`
      SELECT ${own} AS src, ${other} AS dst, (${readableSql}) AS readable, ${title} AS title
        FROM ${junctionRef(link)} AS ${sql.id(JUNCTION_ALIAS)}
        JOIN ${dataTableRef(target.table)} AS ${sql.id(TARGET_ALIAS)}
          ON ${sql.id(TARGET_ALIAS, '__id')} = ${other}
       WHERE ${own} = ANY(${sql.val(ids)}::text[])
         AND ${sql.id(TARGET_ALIAS, '__deleted_at')} IS NULL
       ORDER BY ${own}, ${cellOrder(link)}
    `.execute(tx);
    return rows;
  }
}

/** The json (or text) value of a link cell as reads return it; `null` when empty. */
export function linkCellValue(
  link: LinkFieldModel,
  refs: readonly LinkRef[] | undefined,
  cellFormat: CellFormat,
  locale: LocaleContext,
): LinkRef[] | string | null {
  const json = linkFieldType.fromStorage(refs ?? null, link.options);
  return cellFormat === 'text' ? linkFieldType.formatText(json, link.options, locale) : json;
}
