import { sql } from 'kysely';

import { compileCrossAnalysis } from '../../formula/cross/index.js';
import { assertDataTableName, DATA_SCHEMA } from '../../schema/names.js';
import { PARENT_COLUMN } from '../../schema/physical.js';

import type { RecomputeContext } from './context.js';
import type { Tx } from '../../db/create-db.js';
import type { FieldRow } from '../../db/schema.js';
import type { LinkFieldModel } from '../../records/links/link-model.js';
import type { DependencyPath } from '../graph/index.js';
import type { Id } from '@cellhive/contracts';
import type { FormulaAnalysis } from '@cellhive/formula-engine';

/** Ids per statement when walking junctions and tables (no N+1: one query per batch). */
export const RECOMPUTE_ID_BATCH = 10_000;
/**
 * Source records a `cross_table` condition without a link key is evaluated
 * for, per step: each formula row checks them (a scan of the formula's
 * table); more → every row (job).
 */
export const KEYED_SCAN_SOURCE_LIMIT = 100;

/** Alias of the formula's row when a condition is evaluated (code constant). */
const ROW_ALIAS = 'rk';
/** First record-set alias of a compilation (`RowSets`, aliasBase 0): the `[Table]` of the COUNTIF. */
const SOURCE_ALIAS = 'fr1';

type Rows = ReadonlySet<string> | 'all';

/** Rows to recompute, by stored computed field. */
export class AffectedRows {
  private readonly map = new Map<Id<'fld'>, Set<string> | 'all'>();

  add(fieldId: Id<'fld'>, rows: Iterable<string> | 'all'): void {
    const current = this.map.get(fieldId);
    if (current === 'all') return;
    if (rows === 'all') {
      this.map.set(fieldId, 'all');
      return;
    }
    const set = current ?? new Set<string>();
    for (const id of rows) set.add(id);
    if (set.size > 0 || current !== undefined) this.map.set(fieldId, set);
  }

  merge(other: ReadonlyMap<Id<'fld'>, Rows>): void {
    for (const [fieldId, rows] of other) this.add(fieldId, rows);
  }

  /** Removes and returns the rows of `fieldId`. */
  take(fieldId: Id<'fld'>): Set<string> | 'all' | undefined {
    const rows = this.map.get(fieldId);
    this.map.delete(fieldId);
    return rows;
  }

  get size(): number {
    return this.map.size;
  }

  entries(): IterableIterator<[Id<'fld'>, Set<string> | 'all']> {
    return this.map.entries();
  }

  snapshot(): ReadonlyMap<Id<'fld'>, Rows> {
    return new Map(this.map);
  }
}

/** A change as the resolver walks it: records of a table and the fields that changed on them. */
export interface ResolvedChange {
  readonly tableId: string;
  readonly ids: readonly string[] | 'all';
  readonly fieldIds: readonly string[];
  /** The records appeared or left (every field of the table changes for readers). */
  readonly event?: 'created' | 'deleted' | 'restored';
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * Finds the rows of stored computed fields a change touches (SPEC §5.9,
 * BACKLOG T458), into `out`:
 *
 * - `same_row` → the changed records themselves;
 * - `via_link` → records linked to them, walking the junctions of
 *   `link_path` backwards, one query per link and batch of ids (both
 *   sides, self-links, chains of 3);
 * - `cross_table` → records of the formula's table whose condition selects
 *   the changed records (reached back through `link_path` first): through
 *   the junction when the condition keys on a link (`CONTAIN(CurrentValue.
 *   [Link], RECORD_ID())`, a lookup through a link), else by evaluating the
 *   condition for those records only; no key (`condition_refs` empty) →
 *   every row.
 *
 * Phase `pre` (before the write) only evaluates `cross_table` conditions on
 * the changed records themselves — the rows that selected their **old**
 * values; phase `post` does everything on the values as written.
 */
export class AffectedResolver {
  private readonly memo = new Map<string, Iterable<string> | 'all'>();

  constructor(
    private readonly ctx: RecomputeContext,
    private readonly tx: Tx,
    private readonly out: AffectedRows,
    private readonly phase: 'pre' | 'post',
  ) {}

  async change(change: ResolvedChange): Promise<void> {
    const { tableId, ids } = change;
    if (ids !== 'all' && ids.length === 0) return;
    let fieldIds = change.fieldIds;
    if (change.event !== undefined) {
      fieldIds = this.ctx.fieldIdsOf(tableId);
      if (this.phase === 'post' && change.event !== 'deleted') {
        // New or restored records: every stored computed field of the table.
        for (const fieldId of this.ctx.storedOf(tableId)) this.out.add(fieldId, ids);
      }
      if (change.event !== 'created') {
        // Link cells of other records show (or no longer show) these records.
        for (const link of this.ctx.linksTo(tableId)) {
          const owners = ids === 'all' ? 'all' : await this.reverse(link, ids);
          await this.change({
            tableId: this.ctx.tableOfLink(link),
            ids: owners,
            fieldIds: [link.id],
          });
        }
        // `parent` cells of their children (a trashed parent reads empty).
        const parent = this.ctx.parentOf(tableId);
        if (parent !== null) {
          const children = ids === 'all' ? 'all' : await this.children(tableId, ids);
          await this.change({ tableId, ids: children, fieldIds: [parent] });
        }
      }
      if (this.phase === 'post') {
        // `[Table]` read with no dependency on a field of it (`COUNTIF([T], TRUE)`).
        const fields = new Set<string>(fieldIds);
        for (const fieldId of this.ctx.order) {
          if (!this.ctx.tableReferencesOf(fieldId).has(tableId)) continue;
          const readsField = [...fields].some((id) =>
            this.ctx.readersOf(id).some((edge) => edge.fieldId === fieldId),
          );
          if (!readsField) this.out.add(fieldId, 'all');
        }
      }
    }
    for (const fieldId of fieldIds) {
      for (const edge of this.ctx.readersOf(fieldId)) {
        for (const path of edge.paths) await this.path(edge.fieldId, tableId, ids, path);
      }
    }
  }

  private async path(
    fieldId: Id<'fld'>,
    tableId: string,
    ids: readonly string[] | 'all',
    path: DependencyPath,
  ): Promise<void> {
    const field = this.ctx.field(fieldId);
    if (field === undefined) return;
    const keyed =
      path.kind === 'cross_table' && path.link_path.length === 0 && path.condition_refs.length > 0;
    if (this.phase === 'pre' && !keyed) return;
    const memoKey = `${fieldId}|${path.kind}|${path.link_path.join('.')}|${String(path.condition_refs.length > 0)}|${tableId}`;
    let rows = this.memo.get(memoKey);
    if (rows === undefined) {
      rows = await this.rowsOf(field, tableId, ids, path);
      this.memo.set(memoKey, rows);
    }
    this.out.add(fieldId, rows);
  }

  private async rowsOf(
    field: FieldRow,
    tableId: string,
    ids: readonly string[] | 'all',
    path: DependencyPath,
  ): Promise<Iterable<string> | 'all'> {
    switch (path.kind) {
      case 'same_row':
        return field.table_id === tableId ? ids : 'all';
      case 'via_link':
        return this.reverseChain(path.link_path, ids);
      case 'cross_table': {
        if (path.condition_refs.length === 0) return 'all';
        const [first] = path.link_path;
        const source = first === undefined ? tableId : this.ctx.link(first)?.row.table_id;
        if (source === undefined) return ids === 'all' ? 'all' : [];
        const selected =
          path.link_path.length === 0 ? ids : await this.reverseChain(path.link_path, ids);
        return this.selecting(field, source, selected);
      }
    }
  }

  /** Records of the first table of `path` linked (through the whole chain) to `ids`. */
  private async reverseChain(
    path: readonly string[],
    ids: readonly string[] | 'all',
  ): Promise<readonly string[] | 'all'> {
    let current = ids;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      if (current !== 'all' && current.length === 0) return [];
      const link = this.ctx.link(path[index] as string);
      // A link gone (field or linked table in the trash, purged): its cells read empty.
      if (link === undefined) return current === 'all' ? 'all' : [];
      if (current !== 'all') current = await this.reverse(link, current);
    }
    return current;
  }

  /** Records whose cell of `link` holds one of `ids` (the junction read backwards). */
  private async reverse(link: LinkFieldModel, ids: readonly string[]): Promise<string[]> {
    return this.junction(link, ids, 'reverse');
  }

  private async junction(
    link: LinkFieldModel,
    ids: readonly string[],
    direction: 'reverse' | 'forward',
  ): Promise<string[]> {
    const out = new Set<string>();
    const junction = sql.id(DATA_SCHEMA, link.junction);
    const [from, to] =
      direction === 'reverse'
        ? [link.otherColumn, link.ownColumn]
        : [link.ownColumn, link.otherColumn];
    for (const batch of chunks([...new Set(ids)], RECOMPUTE_ID_BATCH)) {
      const { rows } = await sql<{ id: string }>`
        SELECT DISTINCT j.${sql.id(to)} AS id FROM ${junction} AS j
         WHERE j.${sql.id(from)} = ANY(${sql.val(batch)}::text[])
      `.execute(this.tx);
      for (const row of rows) out.add(row.id);
    }
    return [...out];
  }

  private async children(tableId: string, ids: readonly string[]): Promise<string[]> {
    const table = this.ctx.table(tableId);
    if (table === undefined) return [];
    const data = sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name));
    const out: string[] = [];
    for (const batch of chunks([...new Set(ids)], RECOMPUTE_ID_BATCH)) {
      const { rows } = await sql<{ id: string }>`
        SELECT c.__id AS id FROM ${data} AS c
         WHERE c.${sql.id(PARENT_COLUMN)} = ANY(${sql.val(batch)}::text[])
      `.execute(this.tx);
      for (const row of rows) out.push(row.id);
    }
    return out;
  }

  /**
   * Rows of `field`'s table whose FILTER/COUNTIF/SUMIF/LOOKUP over `source`
   * selects one of `ids` (records of `source`).
   */
  private async selecting(
    field: FieldRow,
    source: string,
    ids: readonly string[] | 'all',
  ): Promise<Iterable<string> | 'all'> {
    if (ids === 'all') return 'all';
    if (ids.length === 0) return [];
    const selection = this.ctx.selectionOver(field.id, source);
    if (selection === null || selection.conditions.length === 0) return 'all';
    const out = new Set<string>();
    const keyLinks = new Map<string, LinkFieldModel>();
    let unkeyed = false;
    for (const condition of selection.conditions) {
      const link = condition.linkKeys
        .map((id) => this.ctx.link(id))
        .find(
          (candidate) =>
            candidate !== undefined &&
            candidate.row.table_id === source &&
            candidate.targetTableId === field.table_id,
        );
      if (link === undefined) unkeyed = true;
      else keyLinks.set(link.id, link);
    }
    for (const link of keyLinks.values()) {
      for (const id of await this.junction(link, ids, 'forward')) out.add(id);
    }
    if (!unkeyed) return out;
    if (ids.length > KEYED_SCAN_SOURCE_LIMIT || selection.filter === null) return 'all';
    const scanned = await this.scan(field, source, ids, selection.filter);
    if (scanned === 'all') return 'all';
    for (const id of scanned) out.add(id);
    return out;
  }

  /**
   * Rows of `field`'s table for which `COUNTIF([source], conditions)` counts
   * one of `ids`: the count compiled with the record set of `source`
   * narrowed to `ids` (through the compiler's `sourceScope` hook), checked
   * on every row of the formula's table (the trash included, as the
   * backfill: a restored record is up to date).
   */
  private async scan(
    field: FieldRow,
    source: string,
    ids: readonly string[],
    filter: FormulaAnalysis,
  ): Promise<string[] | 'all'> {
    const table = this.ctx.table(field.table_id);
    if (table === undefined) return [];
    const narrowed = { done: false };
    let compiled;
    try {
      compiled = compileCrossAnalysis(
        filter,
        { timeZone: this.ctx.timeZone, tableAlias: ROW_ALIAS },
        {
          ...this.ctx.model.cross(field.table_id),
          sourceScope: (tableId, alias) => {
            if (tableId !== source || alias !== SOURCE_ALIAS) return null;
            narrowed.done = true;
            return sql`${sql.id(alias, '__id')} = ANY(${sql.val([...ids])}::text[])`;
          },
        },
      );
    } catch {
      return 'all';
    }
    if (!narrowed.done) return 'all';
    const data = sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name));
    const { rows } = await sql<{ id: string }>`
      SELECT ${sql.id(ROW_ALIAS, '__id')} AS id FROM ${data} AS ${sql.id(ROW_ALIAS)}
       WHERE (${compiled.sql}) > 0
    `.execute(this.tx);
    return rows.map((row) => row.id);
  }
}
