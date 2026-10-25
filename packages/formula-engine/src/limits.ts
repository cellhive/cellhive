/** SPEC §9.5 limits, checked by the parser and name resolution on client and server alike. */

/** Maximum length of a formula as the user writes it (UTF-16 code units). */
export const MAX_FORMULA_LENGTH = 4000;
/** Maximum nesting depth of the AST; parentheses count as a level while parsing. */
export const MAX_AST_DEPTH = 50;
/** Maximum number of link hops in one chain: `[LinkA].[LinkB].[LinkC].[Field]`. */
export const MAX_LINK_CHAIN = 3;
/** Maximum number of iterations (`FILTER`, `COUNTIF`, …) over another table in one formula. */
export const MAX_CROSS_TABLE_FILTERS = 5;
/** Maximum number of arguments of one function call, a chained receiver included. */
export const MAX_FUNCTION_ARGUMENTS = 255;
/** Maximum number of `LET` variables in one formula, all `LET`s together. */
export const MAX_LET_VARIABLES = 20;
