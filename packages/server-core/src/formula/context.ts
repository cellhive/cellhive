import type { FormulaCompiler } from './compiler.js';
import type { Compiled, Sql } from './values.js';
import type { FieldModel } from '../records/table-model.js';
import type { Expr, FormulaType } from '@cellhive/formula-engine';

/**
 * Hook for what the same-row compiler leaves to T455 (cross-table: link
 * chains `[Link].[Field]`, `[Table]`, iteration over records, `LOOKUP`,
 * `row` comparisons). Called before the compiler gives up on a node with
 * `FormulaCompileError('CROSS_TABLE')`; returns `undefined` to decline.
 */
export interface FormulaSqlExtension {
  compile(node: Expr, compiler: FormulaCompiler): Compiled | undefined;
  /** `=` when a side is a record or a list of records; `undefined` to decline. */
  equals?(left: Compiled, right: Compiled, compiler: FormulaCompiler): Sql | undefined;
  /** Text of a record (its title); `undefined` to decline. */
  toText?(value: Compiled, compiler: FormulaCompiler): Sql | undefined;
}

/**
 * A `formula`/`lookup` field another formula reads (BACKLOG T456): not in
 * `TableModel.fields` (the record services do not read computed fields
 * before T457), so the compiler asks the context. `read` gives its value on
 * the row aliased `alias` (`undefined`: unqualified columns) — the stored
 * column, or the virtual field's own expression inlined.
 */
export interface ComputedFieldSql {
  readonly id: string;
  /** The field's result type (`meta.fields.result_type`). */
  readonly type: FormulaType;
  read(alias: string | undefined, compiler: FormulaCompiler): Compiled;
}

export interface FormulaSqlContext {
  /**
   * Type of every node of the AST, from the typecheck (`analyze(…).types` of
   * the same AST object): the compiler only accepts analysed, error-free ASTs.
   */
  readonly types: ReadonlyMap<Expr, FormulaType>;
  /**
   * Fields of the formula's table as the record services model them
   * (`TableModel.fields`): physical columns come from meta, never from the
   * formula text.
   */
  readonly fields: readonly FieldModel[];
  /**
   * IANA zone of calendar operations (ADR-21): the formula field's own
   * zone, else the organization's. A datetime field with its own
   * `options.timezone` uses that zone for its values.
   */
  readonly timeZone: string;
  /** Qualifies every column (`"<alias>"."f_…"`); from code, never from a request. */
  readonly tableAlias?: string;
  /**
   * Fixed value of `NOW()`/`TODAY()` (previews, tests); `now()` of the
   * statement when absent. Formulas using them are `virtual` (SPEC §5.9).
   */
  readonly now?: Date;
  readonly extension?: FormulaSqlExtension;
  /** Computed fields of the formula's table the formula may read (T456). */
  readonly computed?: ReadonlyMap<string, ComputedFieldSql>;
}
