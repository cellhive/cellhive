import * as implementations from './sql/index.js';

import type { SqlFunction } from './call.js';

/**
 * SQL implementations by function name (upper case, as in the AST): a
 * constant table, so SQL function names never come from the formula text.
 */
const SQL_FUNCTIONS: ReadonlyMap<string, SqlFunction> = new Map(Object.entries(implementations));

export function getSqlFunction(name: string): SqlFunction | undefined {
  return SQL_FUNCTIONS.get(name);
}

/** Names of the functions with an SQL implementation (tests compare them with the catalogue). */
export function sqlFunctionNames(): string[] {
  return [...SQL_FUNCTIONS.keys()].sort();
}
