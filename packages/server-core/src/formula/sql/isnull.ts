import type { SqlFunction } from '../call.js';

/** ISNULL (SPEC §9.3): Same as ISBLANK. */
export const ISNULL: SqlFunction = (call) => call.compiler.blank(call.arg(0));
