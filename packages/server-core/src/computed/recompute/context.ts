import {
  analyzeAst,
  fieldValueType,
  type FormulaAnalysis,
  type FormulaType,
} from '@cellhive/formula-engine';

import { withTxScope, type OrgScope } from '../../db/repository.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import { ComputeModel } from '../definition/compute-model.js';
import { isComputedRow } from '../definition/definition.js';
import { loadBaseSchemaRows, snapshotFieldOf, snapshotOfBase } from '../definition/schema-rows.js';
import { FieldDependenciesRepository, type FieldDependencyEdge } from '../graph/index.js';

import {
  anyOf,
  conditionsOver,
  countOver,
  tableReferences,
  type TableCondition,
} from './conditions.js';
import { recomputeOrder } from './order.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { FieldRow, TableRow } from '../../db/schema.js';
import type { LinkFieldModel } from '../../records/links/link-model.js';
import type { Id } from '@cellhive/contracts';

/** How a stored computed field selects the records of a table it reads as `[Table]`. */
export interface SelectionOver {
  readonly conditions: readonly TableCondition[];
  /** The analysed `COUNTIF([Table], c1 || c2 …)` on the formula's table, `null` when it does not typecheck. */
  readonly filter: FormulaAnalysis | null;
}

/**
 * What the incremental recompute (BACKLOG T458) knows of one base, loaded
 * once per transaction: its tables and active fields, the dependency graph
 * (`meta.field_dependencies`), the compile model and the order in which
 * stored computed fields are updated (topological, ties by
 * `db_table_name`). Meta only, no permission: stored values are computed
 * for every record (BACKLOG S4b #1).
 */
export class RecomputeContext {
  /** Stored computed fields that can be recomputed, in update order. */
  readonly order: readonly Id<'fld'>[];
  readonly model: ComputeModel;
  private readonly rank: ReadonlyMap<string, number>;
  private readonly fields: ReadonlyMap<string, FieldRow>;
  private readonly tables: ReadonlyMap<string, TableRow>;
  private readonly readers: ReadonlyMap<string, readonly FieldDependencyEdge[]>;
  private readonly links: ReadonlyMap<string, LinkFieldModel>;
  private readonly selections = new Map<string, SelectionOver | null>();
  private readonly tableRefs = new Map<string, ReadonlySet<string>>();

  private constructor(
    readonly baseId: Id<'bse'>,
    readonly timeZone: string,
    rows: Awaited<ReturnType<typeof loadBaseSchemaRows>>,
    edges: readonly FieldDependencyEdge[],
  ) {
    this.model = new ComputeModel(rows, { timeZone });
    this.fields = new Map(rows.fields.map((field) => [field.id, field]));
    this.tables = new Map(rows.tables.map((table) => [table.id, table]));
    const readers = new Map<string, FieldDependencyEdge[]>();
    for (const edge of edges) {
      const list = readers.get(edge.dependsOnFieldId) ?? [];
      list.push(edge);
      readers.set(edge.dependsOnFieldId, list);
    }
    this.readers = readers;
    const links = new Map<string, LinkFieldModel>();
    for (const table of rows.tables) {
      for (const link of this.model.model(table.id)?.links ?? []) links.set(link.id, link);
    }
    this.links = links;
    const stored = rows.fields.filter((field) => this.isRecomputable(field));
    this.order = recomputeOrder(
      stored.map((field) => ({
        id: field.id,
        tie: this.tables.get(field.table_id)?.db_table_name ?? '',
        position: field.position,
      })),
      edges,
    ) as Id<'fld'>[];
    this.rank = new Map(this.order.map((id, index) => [id, index]));
  }

  /**
   * The context of `baseId` in `tx`; `null` when the base has no computed
   * field (nothing to recompute: one query), else four queries.
   */
  static async load(
    db: Db,
    scope: OrgScope,
    tx: Tx,
    baseId: Id<'bse'>,
    timeZone: string,
  ): Promise<RecomputeContext | null> {
    const txScope = withTxScope(scope, tx);
    if ((await new FieldsRepository(db).countComputedInBase(txScope, baseId)) === 0) return null;
    const rows = await loadBaseSchemaRows(db, txScope, baseId);
    const edges = await new FieldDependenciesRepository(db).listByBase(txScope, baseId);
    return new RecomputeContext(baseId, timeZone, rows, edges);
  }

  /** A stored formula/lookup field with a column, not in error (T460 keeps those empty). */
  private isRecomputable(field: FieldRow): boolean {
    return (
      isComputedRow(field) &&
      field.compute_mode === 'stored' &&
      field.db_column_name !== null &&
      field.compute_state !== 'error' &&
      this.tables.has(field.table_id)
    );
  }

  field(fieldId: string): FieldRow | undefined {
    return this.fields.get(fieldId);
  }

  table(tableId: string): TableRow | undefined {
    return this.tables.get(tableId);
  }

  /** Position of a stored computed field in {@link order}; `undefined` when it is not recomputed. */
  rankOf(fieldId: string): number | undefined {
    return this.rank.get(fieldId);
  }

  /** Active fields of a table (every type), ids only. */
  fieldIdsOf(tableId: string): Id<'fld'>[] {
    return [...this.fields.values()]
      .filter((field) => field.table_id === tableId)
      .map((field) => field.id);
  }

  /** Stored computed fields of a table that are recomputed. */
  storedOf(tableId: string): Id<'fld'>[] {
    return this.order.filter((id) => this.fields.get(id)?.table_id === tableId);
  }

  /** Fields of type `updated_at`/`updated_by` of a table (they change with every record write). */
  updateStampsOf(tableId: string): Id<'fld'>[] {
    return [...this.fields.values()]
      .filter(
        (field) =>
          field.table_id === tableId &&
          (field.type === 'updated_at' || field.type === 'updated_by'),
      )
      .map((field) => field.id);
  }

  /** Dependency edges of fields reading `fieldId`, recomputed readers only. */
  readersOf(fieldId: string): readonly FieldDependencyEdge[] {
    return (this.readers.get(fieldId) ?? []).filter((edge) => this.rank.has(edge.fieldId));
  }

  /** A link field of an active table of the base. */
  link(fieldId: string): LinkFieldModel | undefined {
    return this.links.get(fieldId);
  }

  /** Link fields (both sides, self-links) whose linked table is `tableId`. */
  linksTo(tableId: string): LinkFieldModel[] {
    return [...this.links.values()].filter((link) => link.targetTableId === tableId);
  }

  /** The table owning a link field. */
  tableOfLink(link: LinkFieldModel): Id<'tbl'> {
    return link.row.table_id;
  }

  /** The `parent` field of a table with sub-records, else `null`. */
  parentOf(tableId: string): Id<'fld'> | null {
    return this.model.model(tableId)?.parent?.id ?? null;
  }

  /** Tables a stored computed field reads as `[Table]` (any condition). */
  tableReferencesOf(fieldId: Id<'fld'>): ReadonlySet<string> {
    let refs = this.tableRefs.get(fieldId);
    if (refs === undefined) {
      const field = this.fields.get(fieldId);
      const ast = field === undefined ? null : (this.model.analysis(field)?.ast ?? null);
      refs = ast === null ? new Set() : tableReferences(ast);
      this.tableRefs.set(fieldId, refs);
    }
    return refs;
  }

  /**
   * How the stored computed field `fieldId` selects records of `tableId`
   * (FILTER/COUNTIF/SUMIF/LOOKUP conditions), or `null` when it may read
   * them otherwise (every formula row may be touched).
   */
  selectionOver(fieldId: Id<'fld'>, tableId: string): SelectionOver | null {
    const key = `${fieldId}|${tableId}`;
    if (this.selections.has(key)) return this.selections.get(key) ?? null;
    let selection: SelectionOver | null = null;
    const field = this.fields.get(fieldId);
    const analysis = field === undefined ? null : this.model.analysis(field);
    if (field !== undefined && analysis?.ast != null) {
      const conditions = conditionsOver(analysis.ast, tableId, (id) => this.multiValue(id));
      if (conditions !== null) {
        const condition = anyOf(conditions.map((item) => item.condition));
        let filter: FormulaAnalysis | null = null;
        if (condition !== null) {
          const checked = analyzeAst(
            countOver(tableId, condition),
            snapshotOfBase(this.model.rows, field.table_id),
          );
          filter = checked.errors.length === 0 ? checked : null;
        }
        selection = { conditions, filter };
      }
    }
    this.selections.set(key, selection);
    return selection;
  }

  /** Whether a field holds several values (a list type in formulas). */
  private multiValue(fieldId: string): boolean {
    const field = this.fields.get(fieldId);
    if (field === undefined) return false;
    return fieldValueType(snapshotFieldOf(field)).kind === 'list';
  }

  /** Whether a stored computed field computes with dates (its value may follow the zone). */
  usesCalendar(fieldId: Id<'fld'>): boolean {
    const field = this.fields.get(fieldId);
    const analysis = field === undefined ? null : this.model.analysis(field);
    if (analysis === null) return false;
    const dated = (type: FormulaType): boolean =>
      type.kind === 'date' ||
      type.kind === 'datetime' ||
      (type.kind === 'list' && dated(type.element));
    for (const type of analysis.types.values()) if (dated(type)) return true;
    return false;
  }
}
