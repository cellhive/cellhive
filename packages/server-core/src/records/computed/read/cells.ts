import { attachmentThumbnailUrl, isId } from '@cellhive/contracts';
import {
  attachmentRefOf,
  formatComputedText,
  type LocaleContext,
  type UserRef,
} from '@cellhive/field-types';
import { sql } from 'kysely';

import { titleOf, titleUserIds } from '../../links/link-reader.js';
import {
  dataTableRef,
  LinkTargets,
  relatedAccessContext,
  TARGET_ALIAS,
  targetReadableSql,
  type LinkTarget,
} from '../../links/link-targets.js';
import { MemberDirectoryRepository } from '../../member-directory.repository.js';

import type { ComputedField } from './computed-fields.js';
import type { Db } from '../../../db/create-db.js';
import type { OrgScope } from '../../../db/repository.js';
import type { CellFormat, RecordAccessContext, RecordViewScope } from '../../types.js';
import type { Id } from '@cellhive/contracts';
import type { ResolveContext } from '@cellhive/filter-dsl';

/**
 * Cells of computed fields as reads return them (BACKLOG T457, CONTRACTS §2):
 * the SQL value comes as `to_jsonb(…)` and becomes the result type's form —
 * numbers, texts, booleans, `YYYY-MM-DD` dates, ISO date-times; users like
 * user cells, records like link cells (`{ id, title }`, the title under the
 * reader's access, P20), attachments `{ id, name, size, mime,
 * thumbnail_url }` (S4b open question #4; `null` through a share link); a
 * list is an array, empty → `null`; `cell_format=text` formats with the
 * field's `style`.
 */

/** Display data a page of computed cells needs, read once per page. */
export interface ComputedCellData {
  readonly users: ReadonlyMap<string, UserRef>;
  /** Titles of records by table, then record id (`null`: not readable, P20). */
  readonly titles: ReadonlyMap<string, ReadonlyMap<string, string | null>>;
}

export const EMPTY_COMPUTED_CELL_DATA: ComputedCellData = { users: new Map(), titles: new Map() };

function elementsOf(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? (value as unknown[]) : [value];
}

/** Reads what the computed cells of a page show beyond their value: members and record titles. */
export class ComputedCellReader {
  private readonly members: MemberDirectoryRepository;
  private readonly targets: LinkTargets;

  constructor(db: Db) {
    this.members = new MemberDirectoryRepository(db);
    this.targets = new LinkTargets(db);
  }

  /**
   * `values[i]` holds the raw (`to_jsonb`) values of `fields[i]` on the
   * page; locked fields carry none.
   */
  async read(
    scope: OrgScope,
    fields: readonly ComputedField[],
    values: readonly (readonly unknown[])[],
    access: RecordAccessContext,
    context: ResolveContext,
    locale: LocaleContext,
  ): Promise<ComputedCellData> {
    const userIds = new Set<string>();
    const recordIds = new Map<string, Set<string>>();
    fields.forEach((field, index) => {
      const kind = field.publicType.kind;
      if (kind !== 'user' && kind !== 'record') return;
      for (const value of values[index] ?? []) {
        for (const item of elementsOf(value)) {
          if (typeof item !== 'string') continue;
          if (kind === 'user') userIds.add(item);
          else if (field.recordTableId !== null && isId('rec', item)) {
            const set = recordIds.get(field.recordTableId) ?? new Set<string>();
            set.add(item);
            recordIds.set(field.recordTableId, set);
          }
        }
      }
    });
    const members = await this.members.findMembers(scope, [...userIds]);
    const users = new Map<string, UserRef>(members.map((member) => [member.id, member]));
    const titles = new Map<string, Map<string, string | null>>();
    const cache = new Map<string, LinkTarget | null>();
    for (const [tableId, ids] of recordIds) {
      titles.set(
        tableId,
        await this.titles(scope, tableId as Id<'tbl'>, [...ids], access, context, locale, cache),
      );
    }
    return { users, titles };
  }

  /** Titles of live records of `tableId` under the reader's access (P20; share links: `relatedAccess`). */
  private async titles(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    ids: readonly string[],
    access: RecordAccessContext,
    context: ResolveContext,
    locale: LocaleContext,
    cache: Map<string, LinkTarget | null>,
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('ComputedCellReader needs a transaction');
    const related = relatedAccessContext(access, tableId);
    const target = await this.targets.load(scope, tableId, related, cache);
    const primary = target?.primary ?? null;
    if (target === null || primary === null || !target.titleReadable) return out;
    const readableSql = targetReadableSql(target, related, context);
    const { rows } = await sql<{ id: string; readable: boolean; title: unknown }>`
      SELECT ${sql.id(TARGET_ALIAS, '__id')} AS id, (${readableSql}) AS readable,
             CASE WHEN ${readableSql} THEN ${sql.id(TARGET_ALIAS, primary.column)} END AS title
        FROM ${dataTableRef(target.table)} AS ${sql.id(TARGET_ALIAS)}
       WHERE ${sql.id(TARGET_ALIAS, '__id')} = ANY(${sql.val(ids)}::text[])
         AND ${sql.id(TARGET_ALIAS, '__deleted_at')} IS NULL
    `.execute(tx);
    const readableRows = rows.filter((row) => row.readable);
    const users = new Map<string, UserRef>(
      (
        await this.members.findMembers(
          scope,
          titleUserIds(
            primary,
            readableRows.map((row) => row.title),
          ),
        )
      ).map((member) => [member.id, member]),
    );
    for (const row of rows) {
      out.set(row.id, row.readable ? titleOf(primary, row.title, locale, users) : null);
    }
    return out;
  }
}

/** What turning a raw computed value into its cell needs of the field (realtime uses it too, T459). */
export type ComputedCellField = Pick<
  ComputedField,
  'locked' | 'publicType' | 'recordTableId' | 'style'
>;

function scalarJson(
  field: ComputedCellField,
  item: unknown,
  data: ComputedCellData,
  viewScope: RecordViewScope,
): unknown {
  if (item === null || item === undefined) return null;
  switch (field.publicType.kind) {
    case 'number':
      return typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : null;
    case 'text':
      return typeof item === 'string' ? item : null;
    case 'boolean':
      return typeof item === 'boolean' ? item : null;
    case 'date':
      return typeof item === 'string' ? item.slice(0, 10) : null;
    case 'datetime': {
      if (typeof item !== 'string') return null;
      const date = new Date(item);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    case 'user': {
      if (typeof item !== 'string') return null;
      // Like user cells: an id that is no member any more shows `{ id }` only.
      const user = data.users.get(item);
      return user === undefined
        ? { id: item }
        : { id: user.id, name: user.name, email: user.email };
    }
    case 'record': {
      if (typeof item !== 'string') return null;
      const title =
        field.recordTableId === null
          ? null
          : (data.titles.get(field.recordTableId)?.get(item) ?? null);
      return { id: item, title };
    }
    case 'attachment': {
      // S4b open question #4: never through a share link (S4b).
      if (viewScope === 'share_link') return null;
      const ref = attachmentRefOf(item);
      if (ref === null) return null;
      return {
        id: ref.id,
        name: ref.name,
        size: ref.size,
        mime: ref.mime,
        thumbnail_url: attachmentThumbnailUrl(ref.id, ref.mime, ref.size),
      };
    }
    default:
      return null;
  }
}

/** The cell of `field` from its raw `to_jsonb` value (`null` when empty, locked or in error). */
export function computedCellValue(
  field: ComputedCellField,
  raw: unknown,
  data: ComputedCellData,
  cellFormat: CellFormat,
  locale: LocaleContext,
  viewScope: RecordViewScope,
): unknown {
  let json: unknown = null;
  if (!field.locked && raw !== null && raw !== undefined) {
    if (field.publicType.list) {
      const items = elementsOf(raw)
        .map((item) => scalarJson(field, item, data, viewScope))
        .filter((item) => item !== null);
      json = items.length === 0 ? null : items;
    } else {
      json = scalarJson(field, raw, data, viewScope);
    }
  }
  if (cellFormat === 'json') return json;
  return formatComputedText(json, field.publicType, field.style, locale);
}
