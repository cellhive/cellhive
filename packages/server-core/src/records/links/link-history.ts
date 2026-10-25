import { sql } from 'kysely';

import { MemberDirectoryRepository } from '../member-directory.repository.js';

import { titleOf, titleUserIds } from './link-reader.js';
import {
  dataTableRef,
  LinkTargets,
  relatedAccessContext,
  TARGET_ALIAS,
  targetReadableSql,
} from './link-targets.js';

import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { RecordAccessContext } from '../types.js';
import type { Id } from '@cellhive/contracts';
import type { LocaleContext, UserRef } from '@cellhive/field-types';
import type { ResolveContext } from '@cellhive/filter-dsl';

/**
 * A record named by a history entry of a link or `parent` field (BACKLOG
 * T465, CONTRACTS §11.1): its id, its title under the viewer's **current**
 * access (P20: `null` when the viewer cannot read the linked table, its
 * primary field or the record), and `deleted: true` when the record is no
 * longer live (in the trash or purged) and the viewer may know it.
 */
export interface HistoryRecordRef {
  readonly id: string;
  readonly title: string | null;
  readonly deleted?: true;
}

interface RefRow {
  readonly id: string;
  readonly trashed: boolean;
  readonly readable: boolean;
  readonly title: unknown;
}

/**
 * Renders the record ids that audit entries keep for link and `parent`
 * cells (ADR-23 §2: storage form) against the current data and the
 * viewer's current access — history never recomputes values "as of then"
 * (BACKLOG S4b open question #3). One statement per linked table for a
 * whole page (no N+1).
 *
 * Whether a record is deleted is only told to viewers who could read it:
 *
 * - a record missing from the table (purged) is `deleted` for anyone who
 *   reads the table;
 * - a record in the trash is `deleted` only when it matches the viewer's
 *   read rule, else it reads like any unreadable record (`title: null`);
 * - a viewer without access to the table (or a table gone or in the trash)
 *   only ever gets `{ id, title: null }`.
 */
export class LinkHistoryRefs {
  private readonly targets: LinkTargets;
  private readonly members: MemberDirectoryRepository;

  constructor(db: Db) {
    this.targets = new LinkTargets(db);
    this.members = new MemberDirectoryRepository(db);
  }

  /** `ids` of `tableId` as history refs, by id; needs a transaction in `scope`. */
  async resolve(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    ids: readonly string[],
    locale: LocaleContext,
    context: ResolveContext,
  ): Promise<Map<string, HistoryRecordRef>> {
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('LinkHistoryRefs.resolve needs a transaction');
    const distinct = [...new Set(ids)];
    const refs = new Map<string, HistoryRecordRef>(distinct.map((id) => [id, { id, title: null }]));
    if (distinct.length === 0) return refs;
    const related = relatedAccessContext(access, tableId);
    const target = await this.targets.load(scope, tableId, related);
    if (target === null || target.access === null) return refs;

    const readable = targetReadableSql(target, related, context);
    const primary = target.titleReadable ? target.primary : null;
    const title =
      primary === null
        ? sql`NULL`
        : sql`CASE WHEN ${readable} THEN ${sql.id(TARGET_ALIAS, primary.column)} END`;
    const { rows } = await sql<RefRow>`
      SELECT ${sql.id(TARGET_ALIAS, '__id')} AS id,
             (${sql.id(TARGET_ALIAS, '__deleted_at')} IS NOT NULL) AS trashed,
             (${readable}) AS readable,
             ${title} AS title
        FROM ${dataTableRef(target.table)} AS ${sql.id(TARGET_ALIAS)}
       WHERE ${sql.id(TARGET_ALIAS, '__id')} = ANY(${sql.val(distinct)}::text[])
    `.execute(tx);

    const users =
      primary === null
        ? new Map<string, UserRef>()
        : new Map<string, UserRef>(
            (
              await this.members.findMembers(
                scope,
                titleUserIds(
                  primary,
                  rows.filter((row) => row.readable && !row.trashed).map((row) => row.title),
                ),
              )
            ).map((member) => [member.id as string, member]),
          );
    const found = new Map(rows.map((row) => [row.id, row]));
    for (const id of distinct) {
      const row = found.get(id);
      if (row === undefined) {
        // Purged: nothing is left to hide.
        refs.set(id, { id, title: null, deleted: true });
      } else if (row.trashed) {
        if (row.readable) refs.set(id, { id, title: null, deleted: true });
      } else if (row.readable && primary !== null) {
        refs.set(id, { id, title: titleOf(primary, row.title, locale, users) });
      }
    }
    return refs;
  }
}

/** `true` for refs the viewer is told are deleted. */
export const isDeletedRef = (ref: HistoryRecordRef | undefined): boolean => ref?.deleted === true;
