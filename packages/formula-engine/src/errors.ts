/**
 * Formula errors. Every failure of the lexer, parser, name resolution and
 * typecheck is a `FormulaError` with a top-level problem code (CONTRACTS §6), a detail code
 * for `errors[].code` and the source span it points at. The detail codes are
 * listed in CONTRACTS §6 (`FORMULA_*_DETAIL_CODES` of `@cellhive/contracts`,
 * T456; `test/contract-codes.test.ts` keeps both equal).
 */

/** Detail codes under `FORMULA_SYNTAX_ERROR`. */
export const FORMULA_SYNTAX_ISSUE_CODES = [
  /** A token that cannot appear here (`1 +* 2`, `f(1,)`, `[A] [B]`). */
  'UNEXPECTED_TOKEN',
  /** The formula ends where more input is needed (`1 +`, `IF(1`). */
  'UNEXPECTED_END',
  /** A character that starts no token (`@`, `$`, `;`). */
  'UNEXPECTED_CHARACTER',
  /** A string literal without its closing `"`. */
  'UNTERMINATED_STRING',
  /** A `[Name]` reference without its closing `]`. */
  'UNTERMINATED_NAME',
  /** `[]` or `[   ]`: a reference needs a name. */
  'EMPTY_NAME',
  /** A stored reference that is not a field/table ID, or a malformed `#REF[…]`. */
  'INVALID_REFERENCE',
  /** A bare word that is neither a `LET` variable, `TRUE`/`FALSE` nor `CurrentValue`. */
  'UNKNOWN_NAME',
  /** `NAME(…)` where NAME is no function of the catalogue. */
  'UNKNOWN_FUNCTION',
  /** A Phase 2 function (SPEC §9.3), not available yet. */
  'UNSUPPORTED_FUNCTION',
  /** `LET` without the `LET(name, value, …, expression)` shape, or chained. */
  'INVALID_LET',
  /** A `LET` variable named like a function, `TRUE`, `FALSE` or `CurrentValue`. */
  'RESERVED_NAME',
  /** The same variable twice in one `LET`. */
  'DUPLICATE_VARIABLE',
  /** No such field in the table the reference is resolved in (or not visible to the author). */
  'UNKNOWN_FIELD',
  /** A stored table ID that does not exist (or is not visible to the author). */
  'UNKNOWN_TABLE',
  /** `[Field].[Other]` where `Field` is not a link. */
  'NOT_A_LINK',
  /** `.[Field]` after an expression that is no table, link or row. */
  'INVALID_MEMBER',
  /** `CurrentValue.[Field]` where `CurrentValue` is not a row of a table. */
  'INVALID_CURRENT_VALUE',
] as const;

/**
 * Detail codes under `FORMULA_TYPE_ERROR` (typecheck, SPEC §9.2, T452).
 * Positions point at the offending argument or operand.
 */
export const FORMULA_TYPE_ISSUE_CODES = [
  /** A value of the wrong type (`params.expected`, `params.actual`). */
  'TYPE_MISMATCH',
  /** A list where one value is needed; `params.suggestions` = `SUM`, `ARRAYJOIN`, `FIRST`. */
  'LIST_AS_SCALAR',
  /** A list of lists (a multi-value field read through a table or link) that needs `LISTCOMBINE`. */
  'NESTED_LIST',
  /** A table, a FILTER over a table or one record used as a value: it needs `.[Field]`. */
  'TABLE_NEEDS_FIELD',
  /** One value where a list (or a table) is needed. */
  'EXPECTED_LIST',
  /** Too few or too many arguments (`params.min`, `params.max`; `max` null when variadic). */
  'WRONG_ARGUMENT_COUNT',
  /** FILTER/MAP/COUNTIF/SUMIF/SORTBY/LOOKUP inside the condition of another of them. */
  'NESTED_ITERATION',
  /** `CurrentValue` outside FILTER/MAP/COUNTIF/SUMIF/SORTBY. */
  'CURRENT_VALUE_OUTSIDE_ITERATION',
  /** `LIST`/`UNIQUE`/`LISTCOMBINE`/… of values of different types (a list holds one type). */
  'MIXED_LIST',
  /** An argument whose value is invalid on its own (`params.allowed` when a fixed set applies). */
  'INVALID_ARGUMENT',
  /** `LOOKUP` whose 2nd and 3rd arguments are not `[Table].[Field]` of one table. */
  'INVALID_LOOKUP',
] as const;

/** Detail codes under `FORMULA_LIMIT_EXCEEDED` (SPEC §9.5); `params.limit` holds the limit. */
export const FORMULA_LIMIT_ISSUE_CODES = [
  'MAX_LENGTH',
  'MAX_DEPTH',
  'MAX_LINK_CHAIN',
  'MAX_CROSS_TABLE_FILTERS',
  'MAX_ARGUMENTS',
  'MAX_LET_VARIABLES',
] as const;

export type FormulaSyntaxIssueCode = (typeof FORMULA_SYNTAX_ISSUE_CODES)[number];
export type FormulaLimitIssueCode = (typeof FORMULA_LIMIT_ISSUE_CODES)[number];
export type FormulaTypeIssueCode = (typeof FORMULA_TYPE_ISSUE_CODES)[number];
export type FormulaIssueCode =
  FormulaSyntaxIssueCode | FormulaLimitIssueCode | FormulaTypeIssueCode;

/** Top-level problem codes this package produces (CONTRACTS §6). */
export type FormulaErrorCode =
  'FORMULA_SYNTAX_ERROR' | 'FORMULA_LIMIT_EXCEEDED' | 'FORMULA_TYPE_ERROR';

const LIMIT_CODES: ReadonlySet<string> = new Set(FORMULA_LIMIT_ISSUE_CODES);
const TYPE_CODES: ReadonlySet<string> = new Set(FORMULA_TYPE_ISSUE_CODES);

/** Top-level problem code for a detail code. */
export function formulaErrorCode(detail: FormulaIssueCode): FormulaErrorCode {
  if (LIMIT_CODES.has(detail)) return 'FORMULA_LIMIT_EXCEEDED';
  if (TYPE_CODES.has(detail)) return 'FORMULA_TYPE_ERROR';
  return 'FORMULA_SYNTAX_ERROR';
}

/** Source span in UTF-16 code units, as JavaScript string indices count them. */
export interface SourceSpan {
  start: number;
  length: number;
}

/** Same shape as `ProblemErrorItem` of `@cellhive/contracts`. */
export interface FormulaProblemError {
  path: string;
  code: FormulaIssueCode;
  /** English; UIs translate by `code` + `params`. */
  message: string;
  params: Record<string, unknown> & { position: SourceSpan };
}

export class FormulaError extends Error {
  override readonly name = 'FormulaError';
  readonly code: FormulaErrorCode;
  readonly detail: FormulaIssueCode;
  readonly start: number;
  readonly length: number;
  readonly params: Readonly<Record<string, unknown>>;

  constructor(
    detail: FormulaIssueCode,
    message: string,
    span: SourceSpan,
    params: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = formulaErrorCode(detail);
    this.detail = detail;
    this.start = span.start;
    this.length = span.length;
    this.params = params;
  }

  /** The `errors[]` item of the problem response; `path` names the request property. */
  toProblemError(path = 'formula'): FormulaProblemError {
    return {
      path,
      code: this.detail,
      message: this.message,
      params: { ...this.params, position: { start: this.start, length: this.length } },
    };
  }
}

export function isFormulaError(error: unknown): error is FormulaError {
  return error instanceof FormulaError;
}
