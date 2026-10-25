/**
 * Function names the parser accepts (SPEC §9.3). The full catalogue with
 * signatures, descriptions and implementations (T452) is keyed by these
 * names; a test keeps both in step. Names are upper case; formulas may write
 * them in any case.
 */

/** MVP functions of SPEC §9.3, in the order of the SPEC lists. */
export const MVP_FUNCTION_NAMES = [
  // Logic
  'IF',
  'IFS',
  'SWITCH',
  'IFERROR',
  'IFBLANK',
  'AND',
  'OR',
  'NOT',
  'ISBLANK',
  'ISNULL',
  'ISERROR',
  'ISNUMBER',
  'CONTAIN',
  'CONTAINSALL',
  'CONTAINSONLY',
  'TRUE',
  'FALSE',
  'RECORD_ID',
  // Number
  'SUM',
  'AVERAGE',
  'MAX',
  'MIN',
  'MEDIAN',
  'COUNTA',
  'COUNTIF',
  'SUMIF',
  'ROUND',
  'ROUNDUP',
  'ROUNDDOWN',
  'FLOOR',
  'CEILING',
  'ABS',
  'INT',
  'MOD',
  'POWER',
  'QUOTIENT',
  'VALUE',
  'RANK',
  // Text
  'CONCATENATE',
  'LEN',
  'LEFT',
  'RIGHT',
  'MID',
  'FIND',
  'REPLACE',
  'SUBSTITUTE',
  'UPPER',
  'LOWER',
  'TRIM',
  'TEXT',
  'CONTAINTEXT',
  'SPLIT',
  'TODATE',
  'FORMAT',
  'HYPERLINK',
  'ENCODEURL',
  'REGEXMATCH',
  'REGEXEXTRACT',
  'REGEXREPLACE',
  'UNACCENT',
  // Date
  'NOW',
  'TODAY',
  'DATE',
  'YEAR',
  'MONTH',
  'DAY',
  'HOUR',
  'MINUTE',
  'SECOND',
  'WEEKDAY',
  'WEEKNUM',
  'DAYS',
  'DATEDIF',
  'DURATION',
  'EDATE',
  'EOMONTH',
  'WORKDAY',
  'NETWORKDAYS',
  // List
  'LIST',
  'FIRST',
  'LAST',
  'NTH',
  'FILTER',
  'MAP',
  'SORT',
  'SORTBY',
  'UNIQUE',
  'ARRAYJOIN',
  'LISTCOMBINE',
] as const;

/**
 * Functions added in S4b (SPEC §9.3, `docs/reviews/lark-gap-analysis.md` §4).
 * `LET` has its own syntax node; it is listed so no variable can take its name.
 */
export const S4B_FUNCTION_NAMES = [
  'LET',
  'LOOKUP',
  'PRODUCT',
  'SQRT',
  'EXP',
  'LN',
  'LOG',
  'PI',
  'LARGE',
  'SMALL',
  'STDEV',
] as const;

/** Phase 2 functions (SPEC §9.3): known names that fail with `UNSUPPORTED_FUNCTION`. */
export const PHASE2_FUNCTION_NAMES = [
  'RANDOMBETWEEN',
  'RANDOMITEM',
  'SEQUENCE',
  'REGEXEXTRACTALL',
  'DISTANCE',
  // Trigonometry
  'SIN',
  'COS',
  'TAN',
  'COT',
  'ASIN',
  'ACOS',
  'ATAN',
  'ATAN2',
  'SINH',
  'COSH',
  'TANH',
  'DEGREES',
  'RADIANS',
] as const;

export type FunctionName =
  (typeof MVP_FUNCTION_NAMES)[number] | (typeof S4B_FUNCTION_NAMES)[number];

const SUPPORTED: ReadonlySet<string> = new Set<string>([
  ...MVP_FUNCTION_NAMES,
  ...S4B_FUNCTION_NAMES,
]);
const PHASE2: ReadonlySet<string> = new Set<string>(PHASE2_FUNCTION_NAMES);

/** True for a function the parser accepts; `name` must be upper case. */
export function isSupportedFunction(name: string): name is FunctionName {
  return SUPPORTED.has(name);
}

/** True for a Phase 2 function; `name` must be upper case. */
export function isPhase2Function(name: string): boolean {
  return PHASE2.has(name);
}
