import {
  analyzeAst,
  lookupToAst,
  type Expr,
  type FormulaAnalysis,
  type LookupOptions,
  type SchemaSnapshot,
} from '@cellhive/formula-engine';

import { assertDataTableName } from '../../schema/names.js';
import { FormulaCompileError } from '../errors.js';
import { compileFormula, type CompiledFormula } from '../index.js';

import { CrossTableCompiler } from './extension.js';

import type { CrossTableContext } from './context.js';
import type { FormulaSqlContext } from '../context.js';

export type { CrossTableContext } from './context.js';
export { CrossTableCompiler } from './extension.js';
export { loadBaseTables, snapshotOfBase, type BaseTables } from './models.js';
export type { RowSet } from './rows.js';
export { viewerSourceScope } from './scope.js';

/** Same-row context minus what the cross-table compiler fills in (fields, extension). */
export type CrossFormulaContext = Omit<FormulaSqlContext, 'fields' | 'extension' | 'types'>;

/**
 * Compiles a typechecked formula that may read other tables (SPEC §9.4,
 * BACKLOG T455) into one SQL expression over the formula's row: the
 * same-row compiler (T454) with the cross-table extension.
 *
 * `ctx.tableAlias` is the alias of the formula's table in the enclosing
 * statement; it defaults to the table's name (`FROM data.t_… ` without
 * alias). Columns are always qualified, so correlated subqueries never
 * capture the formula's `__id` or columns.
 */
export function compileCrossFormula(
  ast: Expr,
  types: FormulaSqlContext['types'],
  ctx: CrossFormulaContext,
  cross: CrossTableContext,
): CompiledFormula {
  const computed = cross.computed?.(cross.self.table.id);
  return compileFormula(ast, {
    ...ctx,
    types,
    fields: cross.self.fields,
    tableAlias: ctx.tableAlias ?? assertDataTableName(cross.self.table.db_table_name),
    extension: new CrossTableCompiler(cross),
    ...(computed === undefined ? {} : { computed }),
  });
}

/** `compileCrossFormula` on the result of `analyze`/`analyzeAst` (which must have no error). */
export function compileCrossAnalysis(
  analysis: FormulaAnalysis,
  ctx: CrossFormulaContext,
  cross: CrossTableContext,
): CompiledFormula {
  if (analysis.ast === null || analysis.errors.length > 0) {
    throw new FormulaCompileError('UNTYPED', 'Only formulas without errors can be compiled.');
  }
  return compileCrossFormula(analysis.ast, analysis.types, ctx, cross);
}

export interface CompiledLookup extends CompiledFormula {
  /** The analysis of the lookup's FILTER formula (dependencies, compute mode, style). */
  readonly analysis: FormulaAnalysis;
}

/**
 * A lookup field (SPEC §5.8): its four parts become the equivalent FILTER
 * formula (`lookupToAst`, T452) compiled by the same compiler — one path
 * for lookups and formulas. Throws the `FormulaError` of `lookupToAst`
 * (`INVALID_LOOKUP` for an empty `where`, an operator or value that does
 * not fit — `422` at the API, T456) or of the typecheck.
 */
export function compileLookup(
  options: LookupOptions,
  snapshot: SchemaSnapshot,
  ctx: CrossFormulaContext,
  cross: CrossTableContext,
): CompiledLookup {
  const analysis = analyzeAst(lookupToAst(options, snapshot), snapshot);
  const [error] = analysis.errors;
  if (error !== undefined) throw error;
  return { ...compileCrossAnalysis(analysis, ctx, cross), analysis };
}
