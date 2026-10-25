import { sql } from 'kysely';

import { checkSqlBudget } from './budget.js';
import { FormulaCompiler } from './compiler.js';
import { FormulaCompileError } from './errors.js';

import type { FormulaSqlContext } from './context.js';
import type { Sql } from './values.js';
import type { TableModel } from '../records/table-model.js';
import type {
  Expr,
  FormulaAnalysis,
  FormulaType,
  SnapshotField,
  SnapshotTable,
} from '@cellhive/formula-engine';

export { FORMULA_SQL_MAX_BYTES, FORMULA_SQL_MAX_PARAMETERS } from './budget.js';
export type { SqlCall, SqlFunction } from './call.js';
export { FormulaCompiler } from './compiler.js';
export type { ComputedFieldSql, FormulaSqlContext, FormulaSqlExtension } from './context.js';
export { FormulaCompileError, type FormulaCompileErrorCode } from './errors.js';
export { getSqlFunction, sqlFunctionNames } from './functions.js';
export { sqlTypeOf, type Compiled, type Sql } from './values.js';

export interface CompiledFormula {
  /** One SQL expression over the formula's row (a Kysely `Expression`). */
  readonly sql: Sql;
  /** Result type; the SQL type is `sqlTypeOf(type)`. */
  readonly type: FormulaType;
}

/**
 * Compiles a typechecked formula AST into one SQL expression (SPEC §9.4,
 * BACKLOG T454) for `SELECT` (virtual fields, previews) and set-based
 * `UPDATE … SET f_x = (<expression>)` (stored fields). The result has the SQL
 * type of the formula's result type; numbers carry no trailing zeros.
 *
 * Throws `FormulaCompileError` for untyped nodes and for what the same-row
 * compiler does not handle (cross-table nodes without `ctx.extension`), and
 * `TOO_LARGE` past the SQL size budget (checked while compiling, `budget.ts`).
 */
export function compileFormula(ast: Expr, ctx: FormulaSqlContext): CompiledFormula {
  const compiler = new FormulaCompiler(ctx);
  const type = compiler.typeOf(ast);
  const value = compiler.coerce(compiler.compile(ast), type);
  const out = type.kind === 'number' ? sql`trim_scale(${value.sql})` : value.sql;
  checkSqlBudget(out);
  return { sql: out, type };
}

/** `compileFormula` on the result of `analyze`/`analyzeAst` (which must have no error). */
export function compileAnalysis(
  analysis: FormulaAnalysis,
  ctx: Omit<FormulaSqlContext, 'types'>,
): CompiledFormula {
  if (analysis.ast === null || analysis.errors.length > 0) {
    throw new FormulaCompileError('UNTYPED', 'Only formulas without errors can be compiled.');
  }
  return compileFormula(analysis.ast, { ...ctx, types: analysis.types });
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The formula-engine view of a table (`SchemaSnapshot` entry) from its
 * model: every field the record services support plus link and parent
 * fields (with their target table), under their current names.
 */
export function snapshotTableOf(model: TableModel): SnapshotTable {
  const fields: SnapshotField[] = model.fields.map((field) => ({
    id: field.id,
    name: field.name,
    type: field.type,
    options: isRecord(field.row.options) ? field.row.options : null,
  }));
  for (const link of model.links) {
    fields.push({ id: link.id, name: link.name, type: 'link', linkTableId: link.targetTableId });
  }
  if (model.parent !== null) {
    fields.push({
      id: model.parent.id,
      name: model.parent.name,
      type: 'parent',
      linkTableId: model.table.id,
    });
  }
  return { id: model.table.id, name: model.table.name, fields };
}
