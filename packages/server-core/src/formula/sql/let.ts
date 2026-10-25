import { FormulaCompileError } from '../errors.js';

import type { SqlFunction } from '../call.js';

/**
 * LET (SPEC §9.2): syntax, not a call — the parser gives a `let` node and the
 * compiler inlines each variable's SQL where it is used.
 */
export const LET: SqlFunction = () => {
  throw new FormulaCompileError('UNKNOWN_FUNCTION', 'LET is syntax: it never reaches a call.');
};
