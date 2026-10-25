import { isId, type Id, type ProblemErrorItem } from '@cellhive/contracts';
import {
  linkCellLimit,
  linkFieldType,
  linkIdsOf,
  parseLinkTitleList,
  type LinkInput,
  type LinkRef,
  type LocaleContext,
  type UserRef,
  type ValueIssue,
} from '@cellhive/field-types';
import { type ResolveContext } from '@cellhive/filter-dsl';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { formatIssuePath } from '../../errors/zod-issues.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import { DDL_LOCK_TIMEOUT_MS, schemaLockKey } from '../../schema/policy.js';
import { MemberDirectoryRepository } from '../member-directory.repository.js';
import { storedValueToJson } from '../storage-values.js';

import { toLinkFieldModel, type LinkFieldModel } from './link-model.js';
import { cellOrder, junctionRef, titleOf, titleUserIds } from './link-reader.js';
import {
  dataTableRef,
  LinkTargets,
  matchTitles,
  relatedAccessContext,
  TARGET_ALIAS,
  targetReadableSql,
  type LinkTarget,
  type TitleMatch,
} from './link-targets.js';
import { recordFilterSql } from './record-filter.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { JsonValue, TableRow } from '../../db/schema.js';
import type { FieldModel, TableModel } from '../table-model.js';
import type { FieldKeyType, RecordAccessContext } from '../types.js';
import type { TableAccess } from '@cellhive/permissions';

/** Alias of the junction / of the linking table in write statements. Code constants. */
const J = 'j';
const SOURCE_ALIAS = 's';

/** What the link writer needs of a `RecordMutationService` session. */
export interface LinkWriteSession {
  readonly tx: Tx;
  readonly scope: OrgScope;
  readonly access: RecordAccessContext;
  readonly tableAccess: TableAccess;
  readonly keyType: FieldKeyType;
  readonly typecast: boolean;
  /**
   * Typecast of import cells (CONTRACTS §19, T411): a link cell given as
   * one string is a title list (`parseLinkTitleList`) unless the whole cell
   * is exactly one title (a title matching several records is
   * `LINK_TARGET_AMBIGUOUS` for every write since T421a).
   */
  readonly importCells?: boolean;
  readonly resolve: ResolveContext;
  readonly model: TableModel;
}

/** A request record as the writer sees it: request index and keyed values. */
export interface LinkWriteItem {
  readonly index: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** One link cell of a request, validated, with titles resolved to ids. */
export interface PreparedLinkCell {
  /** Position of the record in `items`. */
  readonly position: number;
  /** Index of the record in the request (error paths). */
  readonly index: number;
  readonly key: string;
  readonly field: LinkFieldModel;
  /** The new list of linked records, in the given order (distinct). */
  readonly ids: readonly string[];
  /** Ids checked as linkable by `prepare` (live, readable, matching `record_filter`). */
  readonly verified: Set<string>;
}

/** The change of one link cell of one record. */
export interface LinkCellChange {
  readonly field: LinkFieldModel;
  readonly key: string;
  readonly index: number;
  readonly recordId: Id<'rec'>;
  /** Linked records a reader sees (live), before and after, in cell order. */
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Order or membership differs: the record changes. */
  readonly changed: boolean;
}

/** Changes of the request's link cells, before anything is written. */
export interface LinkPlan {
  readonly cells: readonly LinkCellChange[];
  /** Reverse-side cells of two-way links before the write, by partner field. */
  readonly partners: readonly PartnerBefore[];
}

interface PartnerBefore {
  readonly field: LinkFieldModel;
  /** The partner field (the reverse side, active). */
  readonly partner: LinkFieldModel;
  readonly target: LinkTarget;
  readonly before: Map<string, string[]>;
}

/** One record of the linked table whose reverse cell changed (a two-way link). */
export interface PartnerRecordChange {
  readonly recordId: Id<'rec'>;
  /** `__version` after the change. */
  readonly version: number;
  readonly from: readonly string[];
  readonly to: readonly string[];
  /** Storage-form values of `imageFields` before the change (same after: only the link changed). */
  readonly cells: ReadonlyMap<Id<'fld'>, JsonValue>;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAtBefore: Date;
  readonly updatedByBefore: string | null;
}

/** The reverse-side changes of one two-way link field in the linked table. */
export interface PartnerChanges {
  readonly table: TableRow;
  readonly model: TableModel;
  readonly field: LinkFieldModel;
  readonly imageFields: readonly FieldModel[];
  readonly records: readonly PartnerRecordChange[];
}

/** A link cell's storage form (CONTRACTS §8 `changes`): record ids, `null` when empty. */
export function linkStored(ids: readonly string[]): JsonValue {
  return ids.length === 0 ? null : [...ids];
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function toIssues(path: string, issues: readonly ValueIssue[]): ProblemErrorItem[] {
  return issues.map((issue) => ({
    path,
    code: issue.code,
    message: issue.message,
    ...(issue.params === undefined ? {} : { params: { ...issue.params } }),
  }));
}

const cellPath = (index: number, key: string) => formatIssuePath(['records', index, 'fields', key]);

const notFoundIssue = (path: string, id?: string): ProblemErrorItem => ({
  path,
  code: 'LINK_TARGET_NOT_FOUND',
  // Same message whether the record is missing, in the trash or unreadable.
  message: 'The linked record does not exist',
  ...(id === undefined ? {} : { params: { id } }),
});

/** A title matching several records the writer reads (T411 imports; API typecast since T421a). */
export const ambiguousIssue = (path: string): ProblemErrorItem => ({
  path,
  code: 'LINK_TARGET_AMBIGUOUS',
  message: 'Several records have this title',
});

/**
 * The issue of a title that did not match exactly one record:
 * `LINK_TARGET_AMBIGUOUS` when it matched several records the writer reads
 * (import cells, and API typecast since T421a: the problem stays `422
 * LINK_TARGET_NOT_FOUND`, the detail says why), else `LINK_TARGET_NOT_FOUND`
 * (CONTRACTS §2). Only readable records are counted, so nothing leaks.
 */
export function titleIssue(path: string, match: TitleMatch | undefined): ProblemErrorItem {
  return match === 'ambiguous' ? ambiguousIssue(path) : notFoundIssue(path);
}

/** The record id of a title that matched exactly one record, else `null`. */
export function matchedId(match: TitleMatch | undefined): string | null {
  return match !== undefined && typeof match === 'object' ? match.id : null;
}

/**
 * Writes of link cells for `RecordMutationService` (SPEC §5.6, BACKLOG
 * T401; CONTRACTS §2). A write gives the full new list of linked records:
 *
 * - links kept from the current cell need nothing else (even when the
 *   writer cannot read the linked record: resending the cell keeps them);
 *   only **added** records must exist, be outside the trash, be readable
 *   by the writer and match `record_filter`, else `422
 *   LINK_TARGET_NOT_FOUND` (one answer for all three);
 * - links to records in the trash are not part of the cell (reads hide
 *   them): they are kept whatever is written, and come back on restore;
 * - at most `LINK_MAX_PER_CELL` (500) links per cell and, for a two-way
 *   link, per reverse cell (`TOO_MANY_VALUES`, `params.limit`; a cell
 *   already over the limit may only lose links);
 * - on the `a` side the order is stored (`position`); the reverse side
 *   lists records in creation order;
 * - a two-way link changes the reverse cells too: those records get
 *   `__version + 1` and their own `record.updated` (BACKLOG S4 decision 6:
 *   only the written side's permissions are checked).
 */
export class LinkWriter {
  private readonly targets: LinkTargets;
  private readonly fields: FieldsRepository;
  private readonly members: MemberDirectoryRepository;

  constructor(db: Db) {
    this.targets = new LinkTargets(db);
    this.fields = new FieldsRepository(db);
    this.members = new MemberDirectoryRepository(db);
  }

  /** Link fields of the session the caller can see, by request key. */
  keyIndex(model: TableModel, keyType: FieldKeyType): Map<string, LinkFieldModel> {
    return new Map(
      model.visibleLinks.map((field) => [keyType === 'id' ? field.id : field.name, field]),
    );
  }

  /**
   * Typecast (titles → ids), validation and the check of added records, in
   * request order. `current` gives the linked records of existing records
   * (updates); new records link nothing yet.
   */
  async prepare(
    s: LinkWriteSession,
    items: readonly LinkWriteItem[],
    byKey: ReadonlyMap<string, LinkFieldModel>,
    locale: LocaleContext,
    existingIds?: readonly (string | null)[],
  ): Promise<{ cells: PreparedLinkCell[]; issues: ProblemErrorItem[] }> {
    const issues: ProblemErrorItem[] = [];
    const cache = new Map<string, LinkTarget | null>();
    const raw: {
      position: number;
      index: number;
      key: string;
      field: LinkFieldModel;
      entries: LinkInput[];
      /** Import cells: the whole cell as one title, tried before the list (T411). */
      whole: string | null;
      /** Issues of the list typecast, reported only when `whole` does not match. */
      castIssues: readonly ValueIssue[];
    }[] = [];
    items.forEach((item, position) => {
      for (const [key, value] of Object.entries(item.fields)) {
        const field = byKey.get(key);
        if (field === undefined) continue;
        const path = cellPath(item.index, key);
        let entries: LinkInput[];
        let whole: string | null = null;
        let castIssues: readonly ValueIssue[] = [];
        if (s.typecast) {
          let input = value;
          if (s.importCells === true && typeof value === 'string') {
            // A title list (CONTRACTS §19); the whole cell may still be one title.
            const text = value.trim();
            const list = parseLinkTitleList(text);
            input = list;
            if (text !== '' && !isId('rec', text) && !(list.length === 1 && list[0] === text)) {
              whole = text;
            }
          }
          const cast = linkFieldType.typecast(input, field.options, locale);
          if (cast.ok) {
            entries = cast.value ?? [];
          } else if (whole !== null) {
            entries = [];
            castIssues = cast.issues;
          } else {
            issues.push(...toIssues(path, cast.issues));
            continue;
          }
        } else {
          // The count is checked against the current cell later (a cell over
          // the limit may still lose links).
          const result = linkFieldType.validate(value, { ...field.options, allow_multiple: true });
          const structural = result.ok
            ? []
            : result.issues.filter((issue) => issue.code !== 'TOO_MANY_VALUES');
          if (structural.length > 0) {
            issues.push(...toIssues(path, structural));
            continue;
          }
          entries = linkIdsOf(value).map((id) => ({ id }));
        }
        raw.push({ position, index: item.index, key, field, entries, whole, castIssues });
      }
    });

    // Titles (typecast) → ids: exact match of the primary field, unique among
    // live records the writer reads — one query per linked table for the
    // whole request (an import batch has a title cell on every row, T423).
    const titlesByTable = new Map<Id<'tbl'>, Set<string>>();
    for (const cell of raw) {
      const titles = cell.entries.flatMap((entry) => ('title' in entry ? [entry.title] : []));
      if (cell.whole !== null) titles.push(cell.whole);
      if (titles.length === 0) continue;
      const set = titlesByTable.get(cell.field.targetTableId) ?? new Set<string>();
      for (const title of titles) set.add(title);
      titlesByTable.set(cell.field.targetTableId, set);
    }
    const resolved = new Map<string, Map<string, TitleMatch>>();
    for (const [tableId, titles] of titlesByTable) {
      const target = await this.target(s, tableId, cache);
      resolved.set(
        tableId,
        await matchTitles(s.tx, target, relatedAccessContext(s.access, tableId), s.resolve, [
          ...titles,
        ]),
      );
    }

    const cells: PreparedLinkCell[] = [];
    for (const cell of raw) {
      const path = cellPath(cell.index, cell.key);
      const known = resolved.get(cell.field.targetTableId);
      let entries = cell.entries;
      if (cell.whole !== null) {
        const id = matchedId(known?.get(cell.whole));
        if (id !== null) {
          entries = [{ id }];
        } else if (cell.castIssues.length > 0) {
          issues.push(...toIssues(path, cell.castIssues));
          continue;
        }
      }
      const ids: string[] = [];
      let failed = false;
      for (const entry of entries) {
        if ('id' in entry) {
          ids.push(entry.id);
          continue;
        }
        const match = known?.get(entry.title);
        const id = matchedId(match);
        if (id === null) {
          // An import row reports one problem per cell.
          if (!failed || s.importCells !== true) issues.push(titleIssue(path, match));
          failed = true;
        } else {
          ids.push(id);
        }
      }
      if (failed) continue;
      cells.push({
        position: cell.position,
        index: cell.index,
        key: cell.key,
        field: cell.field,
        ids: [...new Set(ids)],
        verified: new Set(),
      });
    }
    if (issues.length > 0) return { cells, issues };

    // Added records must be live, readable and match `record_filter`.
    const current = await this.currentIds(s, cells, existingIds);
    const byField = new Map<LinkFieldModel, { cell: PreparedLinkCell; added: string[] }[]>();
    for (const cell of cells) {
      const recordId = existingIds?.[cell.position] ?? null;
      const linked = recordId === null ? undefined : current.get(cell.field.id)?.get(recordId);
      const added = cell.ids.filter((id) => linked?.has(id) !== true);
      if (added.length === 0) continue;
      const list = byField.get(cell.field) ?? [];
      list.push({ cell, added });
      byField.set(cell.field, list);
    }
    for (const [field, list] of byField) {
      const target = await this.target(s, field.targetTableId, cache);
      const wanted = [...new Set(list.flatMap((entry) => entry.added))];
      const found = await this.linkable(s, field, target, wanted);
      for (const { cell, added } of list) {
        for (const id of added) {
          if (found.has(id)) cell.verified.add(id);
          else issues.push(notFoundIssue(cellPath(cell.index, cell.key), id));
        }
      }
    }
    return { cells, issues };
  }

  /**
   * The request's link cell changes against the current junction rows, with
   * the reverse cells before the write; checks the limits of both sides.
   */
  async plan(
    s: LinkWriteSession,
    cells: readonly PreparedLinkCell[],
    recordIds: readonly Id<'rec'>[],
  ): Promise<{ plan: LinkPlan; issues: ProblemErrorItem[] }> {
    const issues: ProblemErrorItem[] = [];
    const changes: LinkCellChange[] = [];
    const partners: PartnerBefore[] = [];
    const cache = new Map<string, LinkTarget | null>();
    const byField = groupBy(cells, (cell) => cell.field);
    for (const [field, fieldCells] of byField) {
      const target = await this.target(s, field.targetTableId, cache);
      const own = fieldCells.map((cell) => recordIds[cell.position] as Id<'rec'>);
      const current = await this.cellRows(s, field, target, own);
      const autos =
        field.side === 'b' && target !== null
          ? await this.autoOf(s, target, [...new Set(fieldCells.flatMap((cell) => cell.ids))])
          : new Map<string, bigint>();
      // Links removed concurrently since `prepare`: added again only when linkable.
      const unverified = new Map<PreparedLinkCell, string[]>();
      for (const cell of fieldCells) {
        const recordId = recordIds[cell.position] as Id<'rec'>;
        const linked = new Set((current.get(recordId) ?? []).map((row) => row.dst));
        const extra = cell.ids.filter((id) => !linked.has(id) && !cell.verified.has(id));
        if (extra.length > 0) unverified.set(cell, extra);
      }
      if (unverified.size > 0) {
        const found = await this.linkable(s, field, target, [
          ...new Set([...unverified.values()].flat()),
        ]);
        for (const [cell, extra] of unverified) {
          for (const id of extra) {
            if (!found.has(id)) issues.push(notFoundIssue(cellPath(cell.index, cell.key), id));
          }
        }
      }
      const fieldChanges: LinkCellChange[] = [];
      for (const cell of fieldCells) {
        const recordId = recordIds[cell.position] as Id<'rec'>;
        const from = (current.get(recordId) ?? []).filter((row) => row.live).map((row) => row.dst);
        const to =
          field.side === 'a'
            ? [...cell.ids]
            : [...cell.ids].sort((a, b) => compareBig(autos.get(a), autos.get(b)));
        const fromSet = new Set(from);
        const toSet = new Set(to);
        const added = to.filter((id) => !fromSet.has(id));
        const removed = from.filter((id) => !toSet.has(id));
        const limit = linkCellLimit(field.options);
        if (to.length > limit && (added.length > 0 || to.length > from.length)) {
          issues.push({
            path: cellPath(cell.index, cell.key),
            code: 'TOO_MANY_VALUES',
            message:
              limit === 1
                ? 'This link field accepts at most one record'
                : `A link cell holds at most ${String(limit)} records`,
            params: { limit },
          });
          continue;
        }
        fieldChanges.push({
          field,
          key: cell.key,
          index: cell.index,
          recordId,
          from,
          to,
          added,
          removed,
          changed: field.side === 'a' ? !sameOrder(from, to) : !sameSet(from, to),
        });
      }
      changes.push(...fieldChanges);
      if (target === null) continue;

      // The reverse side: its limit, and its cells before the write.
      const partner = await this.partnerOf(s, field);
      const reverseLimit = partner?.limit ?? null;
      const affected = [
        ...new Set(fieldChanges.flatMap((change) => [...change.added, ...change.removed])),
      ];
      if (affected.length === 0) continue;
      if (reverseLimit !== null) {
        const counts = await this.reverseCounts(
          s,
          field,
          fieldChanges.flatMap((c) => c.added),
        );
        const delta = new Map<string, number>();
        for (const change of fieldChanges) {
          for (const id of change.added) delta.set(id, (delta.get(id) ?? 0) + 1);
          for (const id of change.removed) delta.set(id, (delta.get(id) ?? 0) - 1);
        }
        for (const change of fieldChanges) {
          for (const id of change.added) {
            const total = (counts.get(id) ?? 0) + (delta.get(id) ?? 0);
            if (total > reverseLimit) {
              issues.push({
                path: cellPath(change.index, change.key),
                code: 'TOO_MANY_VALUES',
                message: `The linked record ${id} would hold more than ${String(reverseLimit)} links`,
                params: { limit: reverseLimit, record_id: id },
              });
            }
          }
        }
      }
      if (partner?.active === true) {
        partners.push({
          field,
          partner: partner.model,
          target,
          before: await this.reverseCells(s, field, partner.model, affected),
        });
      }
    }
    return { plan: { cells: changes, partners }, issues };
  }

  /**
   * Writes the planned junction changes, then bumps the records whose
   * reverse cells changed (`__version + 1`, `__updated_*`), locked in id
   * order. Returns the reverse-side changes to record and publish.
   */
  async apply(
    s: LinkWriteSession,
    plan: LinkPlan,
    writer: Id<'usr'> | null,
    now: Date,
    imageFieldsOf: (table: TableRow, model: TableModel) => Promise<readonly FieldModel[]>,
  ): Promise<PartnerChanges[]> {
    const byField = groupBy(
      plan.cells.filter((change) => change.changed),
      (change) => change.field,
    );
    for (const [field, changes] of byField) await this.writeJunction(s, field, changes);

    const result: PartnerChanges[] = [];
    for (const entry of plan.partners) {
      const affected = [...entry.before.keys()];
      const after = await this.reverseCells(s, entry.field, entry.partner, affected);
      const changed = affected.filter(
        (id) => !sameReverse(entry.partner, entry.before.get(id) ?? [], after.get(id) ?? []),
      );
      if (changed.length === 0) continue;
      const table = entry.target.table;
      const imageFields = await imageFieldsOf(table, entry.target.model);
      const locked = await this.lockPartnerRows(s, table, changed, imageFields);
      const live = changed.filter((id) => locked.has(id)).sort();
      if (live.length === 0) continue;
      const { rows: bumped } = await sql<{ __id: Id<'rec'>; __version: number }>`
        UPDATE ${dataTableRef(table)} AS ${sql.id(TARGET_ALIAS)}
           SET __version = ${sql.id(TARGET_ALIAS, '__version')} + 1,
               __updated_at = ${now.toISOString()}::timestamptz,
               __updated_by = ${writer}
         WHERE ${sql.id(TARGET_ALIAS, '__id')} = ANY(${sql.val(live)}::text[])
        RETURNING ${sql.id(TARGET_ALIAS, '__id')} AS __id, ${sql.id(TARGET_ALIAS, '__version')} AS __version
      `.execute(s.tx);
      const versions = new Map(bumped.map((row) => [row.__id as string, row.__version]));
      result.push({
        table,
        model: entry.target.model,
        field: entry.partner,
        imageFields,
        records: live.flatMap((id) => {
          const row = locked.get(id);
          const version = versions.get(id);
          if (row === undefined || version === undefined) return [];
          return [
            {
              recordId: id as Id<'rec'>,
              version,
              from: entry.before.get(id) ?? [],
              to: after.get(id) ?? [],
              cells: row.cells,
              createdAt: row.createdAt,
              createdBy: row.createdBy,
              updatedAtBefore: row.updatedAt,
              updatedByBefore: row.updatedBy,
            },
          ];
        }),
      });
    }
    return result;
  }

  /**
   * `[{ id, title }]` of linked records for realtime messages: titles are
   * the primary field of every record whatever the writer may read (the
   * gateway keeps them only for subscribers who read the linked table's
   * primary field without a record rule, CONTRACTS §7).
   */
  async refsOf(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    access: RecordAccessContext,
    ids: readonly string[],
    locale: LocaleContext,
  ): Promise<{ refs: Map<string, LinkRef>; titleFieldId: Id<'fld'> | null }> {
    const tx = scope.tx;
    if (tx === undefined) throw new TypeError('LinkWriter.refsOf needs a transaction');
    const target = await this.targets.load(scope, tableId, access);
    const refs = new Map<string, LinkRef>();
    if (target === null || target.primary === null || ids.length === 0) {
      for (const id of ids) refs.set(id, { id, title: null });
      return { refs, titleFieldId: target?.primary?.id ?? null };
    }
    const primary = target.primary;
    const { rows } = await sql<{ id: string; title: unknown }>`
      SELECT ${sql.id(TARGET_ALIAS, '__id')} AS id, ${sql.id(TARGET_ALIAS, primary.column)} AS title
        FROM ${dataTableRef(target.table)} AS ${sql.id(TARGET_ALIAS)}
       WHERE ${sql.id(TARGET_ALIAS, '__id')} = ANY(${sql.val([...new Set(ids)])}::text[])
    `.execute(tx);
    const users = new Map<string, UserRef>(
      (
        await this.members.findMembers(
          scope,
          titleUserIds(
            primary,
            rows.map((row) => row.title),
          ),
        )
      ).map((member) => [member.id as string, member]),
    );
    const titles = new Map(rows.map((row) => [row.id, titleOf(primary, row.title, locale, users)]));
    for (const id of ids) refs.set(id, { id, title: titles.get(id) ?? null });
    return { refs, titleFieldId: primary.id };
  }

  // -------------------------------------------------------------------------

  /**
   * The linked table, under its schema advisory lock in shared mode (like
   * the written table's), so no DDL or compaction changes it before the
   * write commits; waiting more than 3 s is `409 SCHEMA_LOCKED`.
   */
  private async target(
    s: LinkWriteSession,
    tableId: Id<'tbl'>,
    cache: Map<string, LinkTarget | null>,
  ): Promise<LinkTarget | null> {
    if (!cache.has(tableId) && tableId !== s.model.table.id) {
      await lockSchemaShared(s.tx, tableId);
    }
    // Form links write links with the creator's access to the linked table (T410).
    return this.targets.load(s.scope, tableId, relatedAccessContext(s.access, tableId), cache);
  }

  /** Current linked record ids (trash included) of existing records, by field then record. */
  private async currentIds(
    s: LinkWriteSession,
    cells: readonly PreparedLinkCell[],
    existingIds: readonly (string | null)[] | undefined,
  ): Promise<Map<Id<'fld'>, Map<string, Set<string>>>> {
    const result = new Map<Id<'fld'>, Map<string, Set<string>>>();
    if (existingIds === undefined) return result;
    for (const [field, fieldCells] of groupBy(cells, (cell) => cell.field)) {
      const ids = fieldCells.flatMap((cell) => {
        const id = existingIds[cell.position] ?? null;
        return id === null || !isId('rec', id) ? [] : [id];
      });
      if (ids.length === 0) continue;
      const { rows } = await sql<{ src: string; dst: string }>`
        SELECT ${sql.id(field.ownColumn)} AS src, ${sql.id(field.otherColumn)} AS dst
          FROM ${junctionRef(field)}
         WHERE ${sql.id(field.ownColumn)} = ANY(${sql.val(ids)}::text[])
      `.execute(s.tx);
      const byRecord = new Map<string, Set<string>>();
      for (const row of rows) {
        const set = byRecord.get(row.src) ?? new Set<string>();
        set.add(row.dst);
        byRecord.set(row.src, set);
      }
      result.set(field.id, byRecord);
    }
    return result;
  }

  /** Ids among `ids` of live records of the linked table the writer reads that match `record_filter`. */
  private async linkable(
    s: LinkWriteSession,
    field: LinkFieldModel,
    target: LinkTarget | null,
    ids: readonly string[],
  ): Promise<Set<string>> {
    const wanted = ids.filter((id) => isId('rec', id));
    if (target === null || wanted.length === 0) return new Set();
    const conditions: RawBuilder<SqlBool>[] = [
      sql<SqlBool>`${sql.id(TARGET_ALIAS, '__id')} = ANY(${sql.val(wanted)}::text[])`,
      sql<SqlBool>`${sql.id(TARGET_ALIAS, '__deleted_at')} IS NULL`,
      targetReadableSql(target, relatedAccessContext(s.access, target.table.id), s.resolve),
    ];
    const filter = recordFilterSql(field, target, s.resolve);
    if (filter !== null) conditions.push(filter);
    const { rows } = await sql<{ id: string }>`
      SELECT ${sql.id(TARGET_ALIAS, '__id')} AS id
        FROM ${dataTableRef(target.table)} AS ${sql.id(TARGET_ALIAS)}
       WHERE ${sql.join(conditions, sql` AND `)}
    `.execute(s.tx);
    return new Set(rows.map((row) => row.id));
  }

  /** Junction rows of the records' cells (trash included), in cell order, with the linked record's state. */
  private async cellRows(
    s: LinkWriteSession,
    field: LinkFieldModel,
    target: LinkTarget | null,
    recordIds: readonly string[],
  ): Promise<Map<string, { dst: string; live: boolean }[]>> {
    const result = new Map<string, { dst: string; live: boolean }[]>();
    if (recordIds.length === 0) return result;
    const own = sql.id(J, field.ownColumn);
    const other = sql.id(J, field.otherColumn);
    // A linked table in the trash: every current link is hidden (and kept).
    const { rows } =
      target === null
        ? await sql<{ src: string; dst: string; live: boolean }>`
            SELECT ${own} AS src, ${other} AS dst, false AS live
              FROM ${junctionRef(field)} AS ${sql.id(J)}
             WHERE ${own} = ANY(${sql.val([...recordIds])}::text[])
          `.execute(s.tx)
        : await sql<{ src: string; dst: string; live: boolean }>`
            SELECT ${own} AS src, ${other} AS dst,
                   ${sql.id(TARGET_ALIAS, '__deleted_at')} IS NULL AS live
              FROM ${junctionRef(field)} AS ${sql.id(J)}
              JOIN ${dataTableRef(target.table)} AS ${sql.id(TARGET_ALIAS)}
                ON ${sql.id(TARGET_ALIAS, '__id')} = ${other}
             WHERE ${own} = ANY(${sql.val([...recordIds])}::text[])
             ORDER BY ${own}, ${cellOrder(field)}
          `.execute(s.tx);
    for (const row of rows) {
      const list = result.get(row.src) ?? [];
      list.push({ dst: row.dst, live: row.live });
      result.set(row.src, list);
    }
    return result;
  }

  private async autoOf(
    s: LinkWriteSession,
    target: LinkTarget,
    ids: readonly string[],
  ): Promise<Map<string, bigint>> {
    if (ids.length === 0) return new Map();
    const { rows } = await sql<{ id: string; auto: bigint | string }>`
      SELECT __id AS id, __auto AS auto FROM ${dataTableRef(target.table)}
       WHERE __id = ANY(${sql.val([...ids])}::text[])
    `.execute(s.tx);
    return new Map(rows.map((row) => [row.id, BigInt(row.auto)]));
  }

  /**
   * The other side of `field`'s junction: whether it is an active field,
   * and the most links its cells hold (`null`: no limit, a one-way link seen
   * from its own side). A single-record side (`a`, or `b` since T404) keeps its
   * unique index even in the trash, so it limits reverse writes to 1.
   */
  private async partnerOf(
    s: LinkWriteSession,
    field: LinkFieldModel,
  ): Promise<{ model: LinkFieldModel; active: boolean; limit: number | null } | null> {
    const rows = await this.fields.listByJunction(s.scope, field.junction);
    const row = rows.find((candidate) => candidate.link_side !== field.side);
    const model = row === undefined ? null : toLinkFieldModel(row);
    if (model === null || row === undefined) return null;
    const active = row.deleted_at === null;
    if (active) return { model, active, limit: linkCellLimit(model.options) };
    return { model, active, limit: model.options.allow_multiple ? null : 1 };
  }

  /** Live records of this table linked to each of `ids` (the size of their reverse cells). */
  private async reverseCounts(
    s: LinkWriteSession,
    field: LinkFieldModel,
    ids: readonly string[],
  ): Promise<Map<string, number>> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return new Map();
    const own = sql.id(J, field.ownColumn);
    const other = sql.id(J, field.otherColumn);
    const { rows } = await sql<{ id: string; n: bigint | string }>`
      SELECT ${other} AS id, count(*) AS n
        FROM ${junctionRef(field)} AS ${sql.id(J)}
        JOIN ${dataTableRef(s.model.table)} AS ${sql.id(SOURCE_ALIAS)}
          ON ${sql.id(SOURCE_ALIAS, '__id')} = ${own}
       WHERE ${other} = ANY(${sql.val(wanted)}::text[])
         AND ${sql.id(SOURCE_ALIAS, '__deleted_at')} IS NULL
       GROUP BY ${other}
    `.execute(s.tx);
    return new Map(rows.map((row) => [row.id, Number(row.n)]));
  }

  /**
   * Reverse cells of `ids` (records of the linked table): the live records
   * of this table linked to each, in the partner's cell order.
   */
  private async reverseCells(
    s: LinkWriteSession,
    field: LinkFieldModel,
    partner: LinkFieldModel,
    ids: readonly string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return result;
    const own = sql.id(J, field.ownColumn);
    const other = sql.id(J, field.otherColumn);
    const order =
      partner.side === 'a'
        ? sql`${sql.id(J, 'position')}, ${sql.id(SOURCE_ALIAS, '__auto')}`
        : sql`${sql.id(SOURCE_ALIAS, '__auto')}`;
    const { rows } = await sql<{ id: string; linked: string }>`
      SELECT ${other} AS id, ${own} AS linked
        FROM ${junctionRef(field)} AS ${sql.id(J)}
        JOIN ${dataTableRef(s.model.table)} AS ${sql.id(SOURCE_ALIAS)}
          ON ${sql.id(SOURCE_ALIAS, '__id')} = ${own}
       WHERE ${other} = ANY(${sql.val(wanted)}::text[])
         AND ${sql.id(SOURCE_ALIAS, '__deleted_at')} IS NULL
       ORDER BY ${other}, ${order}
    `.execute(s.tx);
    for (const id of wanted) result.set(id, []);
    for (const row of rows) result.get(row.id)?.push(row.linked);
    return result;
  }

  /** Junction writes of one field's changed cells. */
  private async writeJunction(
    s: LinkWriteSession,
    field: LinkFieldModel,
    changes: readonly LinkCellChange[],
  ): Promise<void> {
    const pairs = (list: readonly { own: string; other: string }[]) => ({
      a: list.map((pair) => (field.side === 'a' ? pair.own : pair.other)),
      b: list.map((pair) => (field.side === 'a' ? pair.other : pair.own)),
    });
    const removed = pairs(
      changes.flatMap((change) =>
        change.removed.map((id) => ({ own: change.recordId, other: id })),
      ),
    );
    const ref = junctionRef(field);
    if (removed.a.length > 0) {
      await sql`
        DELETE FROM ${ref} AS ${sql.id(J)}
         USING unnest(${sql.val(removed.a)}::text[], ${sql.val(removed.b)}::text[]) AS x(a_id, b_id)
         WHERE ${sql.id(J, 'a_id')} = x.a_id AND ${sql.id(J, 'b_id')} = x.b_id
      `.execute(s.tx);
    }
    if (field.side === 'a') {
      // The `a` side stores the order of the cell: every link gets its index.
      const rows = changes.flatMap((change) =>
        change.to.map((id, position) => ({ a: change.recordId, b: id, position })),
      );
      if (rows.length === 0) return;
      await sql`
        INSERT INTO ${ref} AS ${sql.id(J)} (a_id, b_id, position)
        SELECT x.a_id, x.b_id, x.position
          FROM unnest(
                 ${sql.val(rows.map((row) => row.a))}::text[],
                 ${sql.val(rows.map((row) => row.b))}::text[],
                 ${sql.val(rows.map((row) => row.position))}::int[]
               ) AS x(a_id, b_id, position)
        ON CONFLICT (a_id, b_id) DO UPDATE SET position = EXCLUDED.position
         WHERE ${sql.id(J, 'position')} IS DISTINCT FROM EXCLUDED.position
      `.execute(s.tx);
      return;
    }
    // The reverse side appends to the end of each linked record's `a` cell.
    const added = pairs(
      changes.flatMap((change) => change.added.map((id) => ({ own: change.recordId, other: id }))),
    );
    if (added.a.length === 0) return;
    await sql`
      INSERT INTO ${ref} (a_id, b_id, position)
      SELECT x.a_id, x.b_id,
             COALESCE((SELECT max(${sql.id(J, 'position')}) + 1 FROM ${ref} AS ${sql.id(J)}
                        WHERE ${sql.id(J, 'a_id')} = x.a_id), 0) + (x.ord - 1)::int
        FROM unnest(${sql.val(added.a)}::text[], ${sql.val(added.b)}::text[])
             WITH ORDINALITY AS x(a_id, b_id, ord)
      ON CONFLICT (a_id, b_id) DO NOTHING
    `.execute(s.tx);
  }

  /** Locks live records of the linked table (id order) and reads their image columns. */
  private async lockPartnerRows(
    s: LinkWriteSession,
    table: TableRow,
    ids: readonly string[],
    imageFields: readonly FieldModel[],
  ): Promise<
    Map<
      string,
      {
        cells: Map<Id<'fld'>, JsonValue>;
        createdAt: Date;
        createdBy: string | null;
        updatedAt: Date;
        updatedBy: string | null;
      }
    >
  > {
    const owned = imageFields.filter((field) => field.ownsColumn);
    const alias = TARGET_ALIAS;
    const { rows } = await sql<Record<string, unknown>>`
      SELECT ${sql.id(alias, '__id')} AS __id,
             ${sql.id(alias, '__created_at')} AS __created_at,
             ${sql.id(alias, '__updated_at')} AS __updated_at,
             ${sql.id(alias, '__created_by')} AS __created_by,
             ${sql.id(alias, '__updated_by')} AS __updated_by
             ${sql.join(
               owned.map(
                 (field, index) =>
                   sql`, ${sql.id(alias, field.column)} AS ${sql.id(`c${String(index)}`)}`,
               ),
               sql``,
             )}
        FROM ${dataTableRef(table)} AS ${sql.id(alias)}
       WHERE ${sql.id(alias, '__id')} = ANY(${sql.val([...ids])}::text[])
         AND ${sql.id(alias, '__deleted_at')} IS NULL
       ORDER BY ${sql.id(alias, '__id')}
         FOR UPDATE OF ${sql.id(alias)}
    `.execute(s.tx);
    const result = new Map<
      string,
      {
        cells: Map<Id<'fld'>, JsonValue>;
        createdAt: Date;
        createdBy: string | null;
        updatedAt: Date;
        updatedBy: string | null;
      }
    >();
    for (const row of rows) {
      const cells = new Map<Id<'fld'>, JsonValue>();
      owned.forEach((field, index) => {
        cells.set(field.id, storedValueToJson(field.type, row[`c${String(index)}`]));
      });
      result.set(row.__id as string, {
        cells,
        createdAt: row.__created_at as Date,
        createdBy: (row.__created_by as string | null) ?? null,
        updatedAt: row.__updated_at as Date,
        updatedBy: (row.__updated_by as string | null) ?? null,
      });
    }
    return result;
  }
}

/** `pg_advisory_xact_lock_shared` on a table's schema lock key, waiting at most `DDL_LOCK_TIMEOUT_MS`. */
async function lockSchemaShared(tx: Tx, tableId: Id<'tbl'>): Promise<void> {
  const { rows } = await sql<{ previous: string }>`
    SELECT current_setting('lock_timeout') AS previous,
           set_config('lock_timeout', ${`${String(DDL_LOCK_TIMEOUT_MS)}ms`}, true)
  `.execute(tx);
  await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${schemaLockKey(tableId)}, 0))`.execute(
    tx,
  );
  await sql`SELECT set_config('lock_timeout', ${rows[0]?.previous ?? '0'}, true)`.execute(tx);
}

/** Reverse cells compare in order on an `a` side (stored order), as sets on a `b` side. */
function sameReverse(partner: LinkFieldModel, a: readonly string[], b: readonly string[]): boolean {
  return partner.side === 'a' ? sameOrder(a, b) : sameSet(a, b);
}

function compareBig(a: bigint | undefined, b: bigint | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
}

function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return groups;
}
