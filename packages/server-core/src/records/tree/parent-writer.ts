import { isId, SUBRECORD_MAX_LEVELS, type Id, type ProblemErrorItem } from '@cellhive/contracts';
import { parentFieldType, SUBRECORD_MAX_DEPTH, type LocaleContext } from '@cellhive/field-types';
import { sql } from 'kysely';

import { AppError } from '../../errors/app-error.js';
import { formatIssuePath } from '../../errors/zod-issues.js';
import {
  dataTableRef,
  matchTitles,
  TARGET_ALIAS,
  targetReadableSql,
  type LinkTarget,
  type TitleMatch,
} from '../links/link-targets.js';
import { matchedId, titleIssue } from '../links/link-writer.js';
import { readable } from '../table-model.js';

import type { Tx } from '../../db/create-db.js';
import type { TableRow } from '../../db/schema.js';
import type { LinkWriteSession } from '../links/link-writer.js';
import type { TableModel } from '../table-model.js';
import type { RecordAccessContext } from '../types.js';

/** `SUBRECORD_MAX_DEPTH` of field-types and the contract agree (a root is level 1). */
const MAX_LEVELS: number = Math.min(SUBRECORD_MAX_DEPTH, SUBRECORD_MAX_LEVELS);

/** A request record as the parent writer sees it. */
export interface ParentWriteItem {
  readonly index: number;
  readonly fields: Readonly<Record<string, unknown>>;
  /** `parent_id` of the request record (`undefined`: not written). */
  readonly parentId?: string | null | undefined;
}

/** The parent a request record writes, validated, titles resolved to ids. */
export interface PreparedParent {
  /** Position of the record in `items`. */
  readonly position: number;
  /** Index of the record in the request (error paths). */
  readonly index: number;
  /** Error path of the value (`records[i].fields.<key>` or `records[i].parent_id`). */
  readonly path: string;
  readonly to: string | null;
}

type Issue = ProblemErrorItem;

const notFoundIssue = (path: string, id?: string): Issue => ({
  path,
  code: 'LINK_TARGET_NOT_FOUND',
  // Same answer whether the parent is missing, in the trash or unreadable.
  message: 'The parent record does not exist',
  ...(id === undefined ? {} : { params: { id } }),
});

/** `422 VALIDATION_FAILED` / `SUBRECORDS_NOT_ENABLED` (tree reads, `parent_id` writes). */
export function subrecordsNotEnabled(path: string): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: 'Sub-records are not turned on for this table.',
    errors: [
      {
        path,
        code: 'SUBRECORDS_NOT_ENABLED',
        message: 'The table has no parent field you can read',
      },
    ],
  });
}

/** The key naming the `parent` field in a request, `null` when the caller cannot read it. */
export function parentKeyOf(model: TableModel, keyType: 'name' | 'id'): string | null {
  const parent = model.visibleParent;
  if (parent === null) return null;
  return keyType === 'id' ? parent.id : parent.name;
}

/**
 * The table itself as the "linked table" of its `parent` field: the
 * machinery of link targets (primary field title, read rule as SQL) reads
 * parents exactly like linked records (P20).
 */
export function selfTarget(model: TableModel, access: RecordAccessContext): LinkTarget {
  const tableAccess = access.resolved.access.tables[model.table.id] ?? null;
  const primary = model.fields.find((field) => field.isPrimary) ?? null;
  return {
    table: model.table,
    model,
    primary,
    access: tableAccess,
    titleReadable: primary !== null && readable(tableAccess, primary.id),
  };
}

/**
 * Writes of the `parent` field (SPEC §5.7, BACKLOG T405) for
 * `RecordMutationService`: the value (`"rec_…"` / `{ id }` / `null`, a title
 * with `typecast`), or `parent_id` of the request record; a new parent must
 * be a live record of the table the writer reads, else `422
 * LINK_TARGET_NOT_FOUND` (not telling why). Cycles and depth are checked
 * on the written rows by {@link assertTreeInvariants}.
 */
export class ParentWriter {
  /** Typecast, validation and title resolution. Throws `VALIDATION_FAILED` on misuse of `parent_id`. */
  async prepare(
    s: LinkWriteSession,
    items: readonly ParentWriteItem[],
    locale: LocaleContext,
  ): Promise<{ cells: PreparedParent[]; issues: Issue[] }> {
    const key = parentKeyOf(s.model, s.keyType);
    const misuse: Issue[] = [];
    const raw: { position: number; index: number; path: string; value: unknown; cast: boolean }[] =
      [];
    items.forEach((item, position) => {
      const inFields = key !== null && Object.hasOwn(item.fields, key);
      const byId = item.parentId !== undefined;
      const idPath = formatIssuePath(['records', item.index, 'parent_id']);
      if (byId && key === null) {
        misuse.push({
          path: idPath,
          code: 'SUBRECORDS_NOT_ENABLED',
          message: 'The table has no parent field you can read',
        });
        return;
      }
      if (byId && inFields) {
        misuse.push({
          path: idPath,
          code: 'NOT_ALLOWED',
          message: 'Give either parent_id or the parent field',
        });
        return;
      }
      if (inFields) {
        raw.push({
          position,
          index: item.index,
          path: formatIssuePath(['records', item.index, 'fields', key]),
          value: item.fields[key],
          cast: s.typecast,
        });
      } else if (byId) {
        raw.push({ position, index: item.index, path: idPath, value: item.parentId, cast: false });
      }
    });
    if (misuse.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'parent_id cannot be written here.',
        errors: misuse,
      });
    }
    const issues: Issue[] = [];
    const entries: {
      position: number;
      index: number;
      path: string;
      entry: { id: string } | { title: string } | null;
    }[] = [];
    for (const cell of raw) {
      let entry: { id: string } | { title: string } | null;
      if (cell.cast) {
        const cast = parentFieldType.typecast(cell.value, {}, locale);
        if (!cast.ok) {
          issues.push(...cast.issues.map((issue) => ({ path: cell.path, ...issue })));
          continue;
        }
        entry = cast.value;
      } else {
        const valid = parentFieldType.validate(cell.value, {});
        if (!valid.ok) {
          issues.push(...valid.issues.map((issue) => ({ path: cell.path, ...issue })));
          continue;
        }
        const id = parentFieldType.toStorage(cell.value, {});
        entry = id === null ? null : { id };
      }
      entries.push({ position: cell.position, index: cell.index, path: cell.path, entry });
    }
    const titles = entries.flatMap((cell) =>
      cell.entry !== null && 'title' in cell.entry ? [cell.entry.title] : [],
    );
    const known =
      titles.length === 0
        ? new Map<string, TitleMatch>()
        : await matchTitles(s.tx, selfTarget(s.model, s.access), s.access, s.resolve, titles);
    const cells: PreparedParent[] = [];
    for (const cell of entries) {
      const { entry } = cell;
      if (entry === null) {
        cells.push({ position: cell.position, index: cell.index, path: cell.path, to: null });
      } else if ('id' in entry) {
        cells.push({ position: cell.position, index: cell.index, path: cell.path, to: entry.id });
      } else {
        const match = known.get(entry.title);
        const id = matchedId(match);
        if (id === null) issues.push(titleIssue(cell.path, match));
        else cells.push({ position: cell.position, index: cell.index, path: cell.path, to: id });
      }
    }
    return { cells, issues };
  }

  /**
   * `LINK_TARGET_NOT_FOUND` issues for new parents that are not live records
   * of the table the writer reads. `current`: the parent each record has now
   * (updates); keeping the current parent needs nothing (P20: it may be
   * unreadable).
   */
  async verify(
    s: LinkWriteSession,
    cells: readonly PreparedParent[],
    current: (position: number) => string | null | undefined,
  ): Promise<Issue[]> {
    const added = cells.filter((cell) => cell.to !== null && cell.to !== current(cell.position));
    if (added.length === 0) return [];
    const target = selfTarget(s.model, s.access);
    const ids = [...new Set(added.map((cell) => cell.to as string))].filter((id) =>
      isId('rec', id),
    );
    const found = new Set<string>();
    if (ids.length > 0) {
      const { rows } = await sql<{ id: string }>`
        SELECT ${sql.id(TARGET_ALIAS, '__id')} AS id
          FROM ${dataTableRef(target.table)} AS ${sql.id(TARGET_ALIAS)}
         WHERE ${sql.id(TARGET_ALIAS, '__id')} = ANY(${sql.val(ids)}::text[])
           AND ${sql.id(TARGET_ALIAS, '__deleted_at')} IS NULL
           AND (${targetReadableSql(target, s.access, s.resolve)})
      `.execute(s.tx);
      for (const row of rows) found.add(row.id);
    }
    return added.flatMap((cell) =>
      found.has(cell.to as string) ? [] : [notFoundIssue(cell.path, cell.to as string)],
    );
  }
}

// ---------------------------------------------------------------------------
// Tree invariants (SPEC §5.7): no cycle, at most 10 levels. Checked on the
// rows as written (inside the mutation's transaction), so several moves of
// one request are judged together. Every row counts, trash included: a
// restore never needs a new check.

interface LevelRow {
  readonly start: string;
  readonly cycle: boolean;
  readonly level: number;
}

/**
 * `422 SUBRECORD_CYCLE` when a record of `moved` is (now) its own ancestor,
 * else `422 SUBRECORD_TOO_DEEP` when a record of `moved` or of its branch
 * is deeper than level 10 (`params.limit`). `pathOf` gives the error path
 * of a moved record. `leaves`: records known to have no children (new
 * records), whose branch is not walked.
 */
export async function assertTreeInvariants(
  tx: Tx,
  table: TableRow,
  moved: readonly string[],
  pathOf: (id: string) => string,
  leaves: ReadonlySet<string> = new Set(),
): Promise<void> {
  const ids = [...new Set(moved)];
  if (ids.length === 0) return;
  const ref = dataTableRef(table);
  // Walk up from each moved record; `level` counts the records of the chain.
  const { rows: ups } = await sql<LevelRow>`
    WITH RECURSIVE up (start, next, level, cycle) AS (
      SELECT x.__id, x.__parent_id, 1, false
        FROM ${ref} AS x
       WHERE x.__id = ANY(${sql.val(ids)}::text[])
      UNION ALL
      SELECT up.start, p.__parent_id, up.level + 1, p.__id = up.start
        FROM up JOIN ${ref} AS p ON p.__id = up.next
       WHERE NOT up.cycle AND up.level <= ${MAX_LEVELS}
    )
    SELECT start, bool_or(cycle) AS cycle, max(level)::int AS level FROM up GROUP BY start
  `.execute(tx);
  const cycles = ups.filter((row) => row.cycle);
  if (cycles.length > 0) {
    throw new AppError('SUBRECORD_CYCLE', {
      detail: 'A record cannot be placed under itself or one of its sub-records.',
      errors: cycles.map((row) => ({
        path: pathOf(row.start),
        code: 'SUBRECORD_CYCLE',
        message: 'The new parent is the record itself or one of its sub-records',
      })),
    });
  }
  const levels = new Map(ups.map((row) => [row.start, row.level]));
  // Height of each moved branch, walked only as deep as it could still fit.
  const walk = ids.filter((id) => !leaves.has(id) && (levels.get(id) ?? 1) <= MAX_LEVELS);
  const heights = new Map<string, number>();
  if (walk.length > 0) {
    const caps = walk.map((id) => MAX_LEVELS - (levels.get(id) ?? 1) + 1);
    const { rows } = await sql<{ start: string; height: number }>`
      WITH RECURSIVE down (start, node, d, cap) AS (
        SELECT x.id, x.id, 0, x.cap
          FROM unnest(${sql.val(walk)}::text[], ${sql.val(caps)}::int[]) AS x (id, cap)
        UNION ALL
        SELECT down.start, c.__id, down.d + 1, down.cap
          FROM down JOIN ${ref} AS c ON c.__parent_id = down.node
         WHERE down.d < down.cap
      )
      SELECT start, max(d)::int AS height FROM down GROUP BY start
    `.execute(tx);
    for (const row of rows) heights.set(row.start, row.height);
  }
  const deep = ids.filter((id) => (levels.get(id) ?? 1) + (heights.get(id) ?? 0) > MAX_LEVELS);
  if (deep.length > 0) {
    throw new AppError('SUBRECORD_TOO_DEEP', {
      detail: `Sub-records can be nested at most ${String(MAX_LEVELS)} levels deep.`,
      params: { limit: MAX_LEVELS },
      errors: deep.map((id) => ({
        path: pathOf(id),
        code: 'SUBRECORD_TOO_DEEP',
        message: `Sub-records can be nested at most ${String(MAX_LEVELS)} levels deep`,
        params: { limit: MAX_LEVELS },
      })),
    });
  }
}

// ---------------------------------------------------------------------------
// Branches (delete / restore, BACKLOG S4 open question #11)

/** Live records whose parent is one of `ids` (children to promote), in `__id` order. */
export async function liveChildrenOf(
  tx: Tx,
  table: TableRow,
  ids: readonly string[],
): Promise<{ id: Id<'rec'>; parent: string }[]> {
  if (ids.length === 0) return [];
  const { rows } = await sql<{ id: Id<'rec'>; parent: string }>`
    SELECT c.__id AS id, c.__parent_id AS parent
      FROM ${dataTableRef(table)} AS c
     WHERE c.__parent_id = ANY(${sql.val([...ids])}::text[]) AND c.__deleted_at IS NULL
     ORDER BY c.__id
  `.execute(tx);
  return rows;
}

/** Live descendants of `ids` (not `ids` themselves) with their parent, nearest first. */
export async function liveDescendantsOf(
  tx: Tx,
  table: TableRow,
  ids: readonly string[],
): Promise<{ id: Id<'rec'>; parent: string }[]> {
  if (ids.length === 0) return [];
  const ref = dataTableRef(table);
  const { rows } = await sql<{ id: Id<'rec'>; parent: string }>`
    WITH RECURSIVE b (id, parent, d) AS (
      SELECT c.__id, c.__parent_id, 1
        FROM ${ref} AS c
       WHERE c.__parent_id = ANY(${sql.val([...ids])}::text[]) AND c.__deleted_at IS NULL
      UNION ALL
      SELECT c.__id, c.__parent_id, b.d + 1
        FROM b JOIN ${ref} AS c ON c.__parent_id = b.id
       WHERE c.__deleted_at IS NULL AND b.d < ${MAX_LEVELS}
    )
    SELECT id, parent FROM b ORDER BY d, id
  `.execute(tx);
  return rows;
}

/**
 * Trashed descendants of the trashed records `ids` deleted together with
 * them (same `__deleted_at`: the same request, "delete whole branch"), with
 * their parent and the root they belong to, nearest first.
 */
export async function trashedBranchOf(
  tx: Tx,
  table: TableRow,
  ids: readonly string[],
): Promise<{ id: Id<'rec'>; parent: string; root: string }[]> {
  if (ids.length === 0) return [];
  const ref = dataTableRef(table);
  const { rows } = await sql<{ id: Id<'rec'>; parent: string; root: string }>`
    WITH RECURSIVE b (id, parent, root, at, d) AS (
      SELECT c.__id, c.__parent_id, r.__id, r.__deleted_at, 1
        FROM ${ref} AS r JOIN ${ref} AS c ON c.__parent_id = r.__id
       WHERE r.__id = ANY(${sql.val([...ids])}::text[])
         AND r.__deleted_at IS NOT NULL AND c.__deleted_at = r.__deleted_at
      UNION ALL
      SELECT c.__id, c.__parent_id, b.root, b.at, b.d + 1
        FROM b JOIN ${ref} AS c ON c.__parent_id = b.id
       WHERE c.__deleted_at = b.at AND b.d < ${MAX_LEVELS}
    )
    SELECT id, parent, root FROM b ORDER BY d, id
  `.execute(tx);
  return rows;
}

/**
 * Keeps the records of a branch reachable from `roots` through records that
 * pass `include` (a record that does not stops the walk there); returns
 * those kept and those stopped.
 */
export function walkBranch<T extends { readonly id: string; readonly parent: string }>(
  roots: ReadonlySet<string>,
  rows: readonly T[],
  include: (row: T) => boolean,
): { kept: T[]; stopped: T[] } {
  const reached = new Set(roots);
  const kept: T[] = [];
  const stopped: T[] = [];
  // Rows come nearest first, so a parent is decided before its children.
  for (const row of rows) {
    if (!reached.has(row.parent)) continue;
    if (include(row)) {
      reached.add(row.id);
      kept.push(row);
    } else {
      stopped.push(row);
    }
  }
  return { kept, stopped };
}
