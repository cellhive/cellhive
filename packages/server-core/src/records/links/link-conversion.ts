import { keptLink, type LinkConversionChange } from '@cellhive/field-types';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { AuditWriter } from '../../audit/audit-writer.js';
import {
  assertDataTableName,
  assertJunctionTableName,
  assertLinkBackupTableName,
  DATA_SCHEMA,
} from '../../schema/names.js';

import { linkStored } from './link-writer.js';

import type { JunctionColumn } from './link-model.js';
import type { AuditContext, AuditEntryInput } from '../../audit/audit-entry.js';
import type { DbExecutor, Tx } from '../../db/create-db.js';
import type { FieldConversionKindValue, TableRow } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/**
 * Data side of link conversions (ADR-28, CONTRACTS §4; BACKLOG T404). A
 * link keeps its values in its junction, so a change of direction touches
 * no data; only `to_single` (`allow_multiple` true → false) does: each cell
 * keeps its first link (live linked records first, then cell order) and
 * the others are removed. The removed rows, with the kept one, are copied
 * to the conversion's backup table (`l_x__old_<ms>`) for the 7-day revert.
 * One audit entry per record whose cell was cut (BACKLOG T404), no record
 * event (BACKLOG S4 open question #7).
 *
 * Reached through `RecordQueryService.scanLinkCells` (preview counts),
 * `RecordMutationService.convertFieldBatch` (the job's batches) and
 * `SchemaService` (revert and failure, in the transaction of the schema
 * change). Identifiers come from meta and pass their pattern before
 * `sql.id`; values are parameters.
 */

/** A conversion kind of `meta.field_conversions` that is a link change. */
export function isLinkConversionKind(
  kind: FieldConversionKindValue,
): kind is LinkConversionChange & FieldConversionKindValue {
  return kind !== 'column';
}

/** Where the cells of a link field live, as a conversion sees them. */
export interface LinkCellsRef {
  readonly junction: string;
  /** Column of the field's own records (`a_id` on the side that created the junction). */
  readonly ownColumn: JunctionColumn;
  readonly otherColumn: JunctionColumn;
  /** Table of the records `otherColumn` points at (may be in the trash); `null` when gone. */
  readonly otherTable: TableRow | null;
  /** Side of the field: its cells are ordered by `position` on `a`, by linked record on `b`. */
  readonly side: 'a' | 'b';
}

const junctionOf = (ref: Pick<LinkCellsRef, 'junction'>) =>
  sql.id(DATA_SCHEMA, assertJunctionTableName(ref.junction));
const tableOf = (table: TableRow) => sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name));
const backupOf = (backup: string) => sql.id(DATA_SCHEMA, assertLinkBackupTableName(backup));
const j = (column: string) => sql.id('j', column);

// ---------------------------------------------------------------------------
// Preview (counts and samples)

/** Alias of the grouped records' table in {@link scanLinkCellCounts} (read rules use it). */
export const LINK_SCAN_ALIAS = 't';

export interface LinkCellCountRequest {
  readonly junction: string;
  /** Cells counted per record of this column. */
  readonly groupColumn: JunctionColumn;
  /** Table of the grouped records (`readable` is compiled on it, aliased `t`). */
  readonly groupTable: TableRow;
  /**
   * Only count links to live records of this table through this column
   * (the size of a reverse cell: linked records in the trash do not count);
   * absent: every junction row counts.
   */
  readonly liveThrough?: { readonly table: TableRow; readonly column: JunctionColumn };
  /** Records with an id greater than this (keyset). */
  readonly after: string | null;
  readonly limit: number;
}

export interface LinkCellCountRow {
  readonly id: Id<'rec'>;
  readonly links: number;
  /** The caller reads the grouped record (live, in its read rule). */
  readonly readable: boolean;
}

/**
 * One keyset page of cell sizes, grouped by one junction column (the
 * junction's primary key or `b_id` index keeps it an index scan).
 * Records without links are not listed.
 */
export async function scanLinkCellCounts(
  executor: DbExecutor,
  request: LinkCellCountRequest,
  readable: RawBuilder<SqlBool>,
): Promise<LinkCellCountRow[]> {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
    throw new RangeError('scanLinkCellCounts: limit must be a positive integer');
  }
  const group = j(request.groupColumn);
  const live = request.liveThrough;
  const join =
    live === undefined
      ? sql``
      : sql`JOIN ${tableOf(live.table)} AS c ON c.__id = ${j(live.column)} AND c.__deleted_at IS NULL`;
  const after = request.after === null ? sql`true` : sql`${group} > ${request.after}`;
  const t = LINK_SCAN_ALIAS;
  const { rows } = await sql<{ id: Id<'rec'>; links: number; readable: boolean | null }>`
    SELECT g.id, g.links, (${readable}) AS readable
      FROM (
        SELECT ${group} AS id, count(*)::int AS links
          FROM ${junctionOf(request)} AS j ${join}
         WHERE ${after}
         GROUP BY ${group}
         ORDER BY ${group}
         LIMIT ${request.limit}
      ) AS g
      LEFT JOIN ${tableOf(request.groupTable)} AS ${sql.id(t)} ON ${sql.id(t, '__id')} = g.id
     ORDER BY g.id
  `.execute(executor);
  return rows.map((row) => ({ id: row.id, links: row.links, readable: row.readable === true }));
}

// ---------------------------------------------------------------------------
// to_single: cut the cells (job batches)

interface JunctionRow {
  readonly a_id: string;
  readonly b_id: string;
  readonly position: number;
  readonly own: string;
  readonly other: string;
  readonly live: boolean;
}

/** Junction rows of `ownIds` in cell order, live linked records first. */
async function cellRows(
  tx: Tx,
  ref: LinkCellsRef,
  ownIds: readonly string[],
): Promise<Map<string, JunctionRow[]>> {
  const cells = new Map<string, JunctionRow[]>();
  if (ownIds.length === 0) return cells;
  const other = ref.otherTable;
  const join =
    other === null
      ? sql``
      : sql`LEFT JOIN ${tableOf(other)} AS o ON o.__id = ${j(ref.otherColumn)}`;
  const live = other === null ? sql`false` : sql`(o.__id IS NOT NULL AND o.__deleted_at IS NULL)`;
  const auto = other === null ? sql`NULL::bigint` : sql`o.__auto`;
  const order =
    ref.side === 'a'
      ? sql`${j('position')}, ${auto}, ${j(ref.otherColumn)}`
      : sql`${auto}, ${j(ref.otherColumn)}`;
  const { rows } = await sql<JunctionRow>`
    SELECT j.a_id, j.b_id, j.position, ${j(ref.ownColumn)} AS own, ${j(ref.otherColumn)} AS other,
           ${live} AS live
      FROM ${junctionOf(ref)} AS j ${join}
     WHERE ${j(ref.ownColumn)} = ANY(${sql.val([...ownIds])}::text[])
     ORDER BY ${j(ref.ownColumn)}, (NOT ${live}), ${order}
  `.execute(tx);
  for (const row of rows) {
    const list = cells.get(row.own) ?? [];
    list.push(row);
    cells.set(row.own, list);
  }
  return cells;
}

export interface CutCellsInput {
  readonly ref: LinkCellsRef;
  readonly backupTable: string;
  /** Cells cut per call; `null`: every cell holding more than one link. */
  readonly limit: number | null;
  /** One audit entry per record whose (live) cell changed. */
  readonly audit: {
    readonly table: TableRow;
    readonly fieldId: Id<'fld'>;
    readonly context: AuditContext;
  };
}

export interface CutCellsResult {
  /** Cells that held more than one link and now hold one. */
  readonly cells: number;
  /** Of those, cells whose visible value changed (audited). */
  readonly changed: number;
}

/**
 * Cuts the next cells holding more than one link to their first link
 * (`to_single`, CONTRACTS §4.2), in `tx`: copies the rows of each cut cell
 * to the backup (`kept` marks the link left in place), deletes the others
 * and writes one `record.updated` audit entry per record whose live links
 * changed (storage form: the ids before/after). Cells cut by an earlier
 * call no longer hold more than one link, so calls repeat until fewer than
 * `limit` cells are cut.
 */
export async function cutLinkCells(tx: Tx, input: CutCellsInput): Promise<CutCellsResult> {
  const { ref } = input;
  const own = j(ref.ownColumn);
  const { rows: targets } = await sql<{ id: string }>`
    SELECT ${own} AS id FROM ${junctionOf(ref)} AS j
     GROUP BY ${own} HAVING count(*) > 1
     ORDER BY ${own}
     ${input.limit === null ? sql`` : sql`LIMIT ${input.limit}`}
  `.execute(tx);
  if (targets.length === 0) return { cells: 0, changed: 0 };
  const cells = await cellRows(
    tx,
    ref,
    targets.map((row) => row.id),
  );
  const backup: { a_id: string; b_id: string; position: number; kept: boolean }[] = [];
  const removed: { a_id: string; b_id: string }[] = [];
  const entries: AuditEntryInput[] = [];
  for (const [recordId, rows] of cells) {
    const kept = keptLink(rows);
    if (kept === null) continue;
    for (const row of rows) {
      backup.push({ a_id: row.a_id, b_id: row.b_id, position: row.position, kept: row === kept });
      if (row !== kept) removed.push({ a_id: row.a_id, b_id: row.b_id });
    }
    const before = rows.filter((row) => row.live).map((row) => row.other);
    const after = kept.live ? [kept.other] : [];
    if (before.length !== after.length) {
      entries.push(auditEntryOf(input.audit, recordId, before, after));
    }
  }
  await sql`
    INSERT INTO ${backupOf(input.backupTable)} (a_id, b_id, position, kept)
    SELECT r.a_id, r.b_id, r.position, r.kept
      FROM jsonb_to_recordset(${JSON.stringify(backup)}::jsonb)
           AS r(a_id text, b_id text, position integer, kept boolean)
    ON CONFLICT (a_id, b_id) DO NOTHING
  `.execute(tx);
  await sql`
    DELETE FROM ${junctionOf(ref)} AS j
     USING jsonb_to_recordset(${JSON.stringify(removed)}::jsonb) AS r(a_id text, b_id text)
     WHERE j.a_id = r.a_id AND j.b_id = r.b_id
  `.execute(tx);
  if (entries.length > 0) await new AuditWriter().writeMany(tx, entries);
  return { cells: cells.size, changed: entries.length };
}

/** Whether some cell of the field holds more than one link (the end re-checks under lock). */
export async function hasMultiLinkCells(tx: Tx, ref: LinkCellsRef): Promise<boolean> {
  const own = j(ref.ownColumn);
  const { rows } = await sql<{ one: number }>`
    SELECT 1 AS one FROM ${junctionOf(ref)} AS j
     GROUP BY ${own} HAVING count(*) > 1
     LIMIT 1
  `.execute(tx);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// to_single: revert and failure (the backup comes back)

export interface RestoreBackupInput {
  readonly ref: LinkCellsRef;
  readonly backupTable: string;
  /** Tables of `a_id` and `b_id`: only links between existing records come back. */
  readonly aTable: TableRow;
  readonly bTable: TableRow;
  /** Cells to restore (own record ids); `null`: every cut cell. */
  readonly ownIds: readonly string[] | null;
  /**
   * `false`: removed links are added back next to what the cell holds now;
   * `true`: the cell gets exactly its links from before the conversion.
   */
  readonly overwrite: boolean;
  /** Audit of the records whose live links changed; absent: no entries (failed job). */
  readonly audit?: {
    readonly table: TableRow;
    readonly fieldId: Id<'fld'>;
    readonly context: AuditContext;
  };
}

/** Own record ids of the cells in the backup. */
export async function backupCellIds(tx: Tx, ref: LinkCellsRef, backupTable: string) {
  const { rows } = await sql<{ id: string }>`
    SELECT DISTINCT ${sql.id('k', ref.ownColumn)} AS id FROM ${backupOf(backupTable)} AS k
     ORDER BY 1
  `.execute(tx);
  return rows.map((row) => row.id);
}

/**
 * Puts the links of the backup back into the junction (revert of
 * `to_single`, or its failed job). The caller dropped the single-value
 * index first. Links to records that no longer exist are skipped.
 */
export async function restoreLinkBackup(
  tx: Tx,
  input: RestoreBackupInput,
): Promise<{ readonly cells: number }> {
  const { ref } = input;
  const ownIds = input.ownIds ?? (await backupCellIds(tx, ref, input.backupTable));
  if (ownIds.length === 0) return { cells: 0 };
  const before = input.audit === undefined ? null : await cellRows(tx, ref, ownIds);
  const own = sql.id('k', ref.ownColumn);
  const ids = sql.val([...ownIds]);
  if (input.overwrite) {
    await sql`
      DELETE FROM ${junctionOf(ref)} AS j WHERE ${j(ref.ownColumn)} = ANY(${ids}::text[])
    `.execute(tx);
  }
  await sql`
    INSERT INTO ${junctionOf(ref)} (a_id, b_id, position)
    SELECT k.a_id, k.b_id, k.position
      FROM ${backupOf(input.backupTable)} AS k
      JOIN ${tableOf(input.aTable)} AS a ON a.__id = k.a_id
      JOIN ${tableOf(input.bTable)} AS b ON b.__id = k.b_id
     WHERE ${own} = ANY(${ids}::text[])
    ON CONFLICT (a_id, b_id) DO NOTHING
  `.execute(tx);
  if (input.audit !== undefined && before !== null) {
    const after = await cellRows(tx, ref, ownIds);
    const entries: AuditEntryInput[] = [];
    for (const id of ownIds) {
      const from = (before.get(id) ?? []).filter((row) => row.live).map((row) => row.other);
      const to = (after.get(id) ?? []).filter((row) => row.live).map((row) => row.other);
      if (from.length !== to.length || from.some((value, index) => value !== to[index])) {
        entries.push(auditEntryOf(input.audit, id, from, to));
      }
    }
    if (entries.length > 0) await new AuditWriter().writeMany(tx, entries);
  }
  return { cells: ownIds.length };
}

function auditEntryOf(
  audit: { readonly table: TableRow; readonly fieldId: Id<'fld'>; readonly context: AuditContext },
  recordId: string,
  before: readonly string[],
  after: readonly string[],
): AuditEntryInput {
  return {
    action: 'record.updated',
    organizationId: audit.table.organization_id,
    baseId: audit.table.base_id,
    tableId: audit.table.id,
    entityType: 'record',
    entityId: recordId,
    before: { [audit.fieldId]: linkStored(before) },
    after: { [audit.fieldId]: linkStored(after) },
    context: audit.context,
  };
}
