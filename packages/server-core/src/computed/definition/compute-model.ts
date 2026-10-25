import {
  analyze,
  analyzeAst,
  lookupToAst,
  T,
  type FormulaAnalysis,
  type FormulaType,
  type LookupOptions,
} from '@cellhive/formula-engine';
import { sql } from 'kysely';

import { compileCrossAnalysis, type CrossTableContext } from '../../formula/cross/index.js';
import { nullOf, type Compiled, type Sql } from '../../formula/values.js';
import { withLinkFilterMeta } from '../../records/links/link-filters.js';
import { buildTableModel, type TableModel } from '../../records/table-model.js';
import { assertDataTableName, assertFieldColumnName } from '../../schema/names.js';

import { formulaTypeOf, snapshotOfBase, type BaseSchemaRows } from './schema-rows.js';

import type { FieldRow } from '../../db/schema.js';
import type { FormulaCompiler } from '../../formula/compiler.js';
import type { ComputedFieldSql } from '../../formula/context.js';
import type { Id } from '@cellhive/contracts';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Aliases of record sets are numbered per compilation; nested virtual fields count from here up. */
const NESTED_ALIAS_STEP = 1000;

export interface ComputeModelOptions {
  /** IANA zone of calendar operations (ADR-21): the organization's. */
  readonly timeZone: string;
  /** Fixed `NOW()`/`TODAY()` (previews, tests). */
  readonly now?: Date;
  /**
   * The viewer's read scope on source tables (T455 `sourceScope`); absent
   * for stored values, computed for every record (never a person's scope).
   */
  readonly sourceScope?: (tableId: string, alias: string) => Sql | null;
  /**
   * Stored fields read through their expression instead of their column
   * (BACKLOG T457): the stored value was computed over every record, so a
   * reader with a record rule on a table it reads gets it computed again
   * with `sourceScope`. Default: every stored field reads its column.
   */
  readonly inlineStored?: (field: FieldRow) => boolean;
}

/** The analysis of a saved computed field, from its stored options (`null` when it no longer analyses). */
export function analysisOfField(field: FieldRow, rows: BaseSchemaRows): FormulaAnalysis | null {
  const snapshot = snapshotOfBase(rows, field.table_id);
  const options = isRecord(field.options) ? field.options : {};
  if (field.type === 'formula') {
    const expression = options['expression'];
    if (typeof expression !== 'string') return null;
    const analysis = analyze(expression, snapshot);
    return analysis.errors.length === 0 ? analysis : null;
  }
  if (field.type === 'lookup') {
    try {
      const analysis = analyzeAst(
        lookupToAst(options as unknown as LookupOptions, snapshot),
        snapshot,
      );
      return analysis.errors.length === 0 ? analysis : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The value of a stored computed column read on the row aliased `alias`
 * (`undefined`: unqualified): its SQL form of SPEC §9.4 — a list of
 * attachments is kept as a `jsonb` array (like attachment cells) and read
 * back as `jsonb[]`.
 */
export function storedColumnRead(
  column: string,
  type: FormulaType,
  alias: string | undefined,
): Sql {
  const ref =
    alias === undefined
      ? sql.id(assertFieldColumnName(column))
      : sql.id(alias, assertFieldColumnName(column));
  if (type.kind === 'list' && type.element.kind === 'attachment') {
    return sql`(CASE WHEN jsonb_typeof(${ref}) = 'array' THEN ARRAY(SELECT a.e FROM jsonb_array_elements(${ref}) WITH ORDINALITY AS a(e, i) ORDER BY a.i) END)`;
  }
  return ref;
}

/** A compiled value in the form of its stored column (the reverse of {@link storedColumnRead}). */
export function storedColumnValue(value: Sql, type: FormulaType): Sql {
  if (type.kind === 'list' && type.element.kind === 'attachment') {
    return sql`(CASE WHEN ${value} IS NULL OR cardinality(${value}) = 0 THEN NULL ELSE to_jsonb(${value}) END)`;
  }
  if (type.kind === 'list') {
    // An empty list and NULL mean the same (SPEC §9.4): keep NULL.
    return sql`(CASE WHEN cardinality(${value}) = 0 THEN NULL ELSE ${value} END)`;
  }
  return value;
}

/**
 * The compile-time model of a base for computed fields (BACKLOG T456): the
 * table models the cross-table compiler reads, and every formula/lookup
 * field as a `ComputedFieldSql` — a stored one reads its column, a virtual
 * one inlines its own expression (with aliases numbered apart so they never
 * shadow the enclosing query's). Fields in `error` read empty (SPEC §9.4).
 */
export class ComputeModel {
  private readonly models = new Map<string, TableModel>();
  private readonly computedByTable = new Map<string, Map<string, ComputedFieldSql>>();
  private readonly analyses = new Map<string, FormulaAnalysis | null>();

  constructor(
    readonly rows: BaseSchemaRows,
    readonly options: ComputeModelOptions,
  ) {
    const tables = new Map(rows.tables.map((table) => [table.id as string, table]));
    for (const table of rows.tables) {
      const fields = rows.fields.filter((field) => field.table_id === table.id);
      // Link meta for viewers' read rules on source tables (`viewerSourceScope`, T710).
      this.models.set(
        table.id,
        withLinkFilterMeta(buildTableModel(table, fields, null), (id) => tables.get(id)),
      );
    }
  }

  model(tableId: string): TableModel | null {
    return this.models.get(tableId) ?? null;
  }

  field(fieldId: string): FieldRow | undefined {
    return this.rows.fields.find((field) => field.id === fieldId);
  }

  /** Cached analysis of a saved computed field (full snapshot of the base). */
  analysis(field: FieldRow): FormulaAnalysis | null {
    if (!this.analyses.has(field.id))
      this.analyses.set(field.id, analysisOfField(field, this.rows));
    return this.analyses.get(field.id) ?? null;
  }

  /** The cross-table context of a formula of `tableId`. */
  cross(tableId: string, aliasBase = 0): CrossTableContext {
    const self = this.model(tableId);
    if (self === null) throw new TypeError(`Table ${tableId} is not in the base model`);
    const scope = this.options.sourceScope;
    return {
      self,
      table: (id) => this.model(id),
      computed: (id) => this.computed(id, aliasBase),
      aliasBase,
      ...(scope === undefined ? {} : { sourceScope: scope }),
    };
  }

  /** Computed fields of `tableId` as the compiler reads them. */
  computed(tableId: string, aliasBase = 0): ReadonlyMap<string, ComputedFieldSql> {
    const key = `${tableId}:${String(aliasBase)}`;
    let map = this.computedByTable.get(key);
    if (map !== undefined) return map;
    map = new Map();
    for (const field of this.rows.fields) {
      if (field.table_id !== tableId || (field.type !== 'formula' && field.type !== 'lookup')) {
        continue;
      }
      const type = formulaTypeOf(field.result_type) ?? T.any;
      map.set(field.id, {
        id: field.id,
        type: type.kind === 'any' ? T.text : type,
        read: (alias, compiler) => this.read(field, type, alias, compiler, aliasBase),
      });
    }
    this.computedByTable.set(key, map);
    return map;
  }

  private read(
    field: FieldRow,
    type: FormulaType,
    alias: string | undefined,
    compiler: FormulaCompiler,
    aliasBase: number,
  ): Compiled {
    if (field.compute_state === 'error' || type.kind === 'any') {
      return { sql: nullOf(type.kind === 'any' ? T.text : type), type };
    }
    if (
      field.compute_mode === 'stored' &&
      field.db_column_name !== null &&
      this.options.inlineStored?.(field) !== true
    ) {
      return { sql: storedColumnRead(field.db_column_name, type, alias), type };
    }
    const analysis = this.analysis(field);
    if (analysis === null) return { sql: nullOf(type), type };
    const table = this.model(field.table_id);
    if (table === null) return { sql: nullOf(type), type };
    const { timeZone, now } = compiler.ctx;
    const compiled = compileCrossAnalysis(
      analysis,
      {
        timeZone,
        tableAlias: alias ?? assertDataTableName(table.table.db_table_name),
        ...(now === undefined ? {} : { now }),
      },
      this.cross(field.table_id, aliasBase + NESTED_ALIAS_STEP),
    );
    return { sql: compiled.sql, type: compiled.type };
  }

  /**
   * The value of `field` computed on the row aliased `alias`, in the form of
   * its stored column: the `SET` of a backfill (T456) or recompute (T458).
   * `null` when the definition no longer analyses (T460 marks it `REF`).
   */
  storedValue(field: FieldRow, alias: string): Sql | null {
    const analysis = this.analysis(field);
    const type = formulaTypeOf(field.result_type);
    if (analysis === null || type === null) return null;
    const compiled = compileCrossAnalysis(
      analysis,
      {
        timeZone: this.options.timeZone,
        tableAlias: alias,
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      },
      this.cross(field.table_id),
    );
    return storedColumnValue(compiled.sql, type);
  }

  /** The table id of a field of the base. */
  tableOf(fieldId: Id<'fld'>): Id<'tbl'> | undefined {
    return this.field(fieldId)?.table_id;
  }
}
