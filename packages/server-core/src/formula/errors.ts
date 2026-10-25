/**
 * Reasons the SQL compiler refuses an AST. Always a programming error or a
 * later task's feature, never a user error: user formulas are rejected
 * earlier by `analyze` (parse, resolve, typecheck) with `FormulaError`.
 *
 * - `UNTYPED`: a node without a type in the analysis (not typechecked, or
 *   typechecked with errors);
 * - `UNSUPPORTED_TYPE`: a value type with no same-row SQL form (`row`, `table`);
 * - `UNKNOWN_FIELD`: a field missing from the table model;
 * - `CROSS_TABLE`: links, `[Table]`, record iteration and `LOOKUP` — compiled
 *   by T455 through `FormulaSqlContext.extension`;
 * - `UNSUPPORTED_FIELD`: a field type the compiler cannot read (formula
 *   and lookup fields are read through `FormulaSqlContext.computed`, T456);
 * - `UNKNOWN_FUNCTION`: a function without SQL implementation;
 * - `TOO_LARGE`: the SQL would expand past the compile budget
 *   (`FORMULA_SQL_MAX_BYTES` / `FORMULA_SQL_MAX_PARAMETERS`, `params.limit`):
 *   a user error, `422 FORMULA_LIMIT_EXCEEDED` / `MAX_COMPILED_SIZE` on save.
 */
export type FormulaCompileErrorCode =
  | 'UNTYPED'
  | 'UNSUPPORTED_TYPE'
  | 'UNKNOWN_FIELD'
  | 'CROSS_TABLE'
  | 'UNSUPPORTED_FIELD'
  | 'UNKNOWN_FUNCTION'
  | 'TOO_LARGE';

export class FormulaCompileError extends Error {
  override readonly name = 'FormulaCompileError';

  constructor(
    readonly code: FormulaCompileErrorCode,
    message: string,
    readonly params: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}
