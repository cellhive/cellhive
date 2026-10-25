import type { SqlFunction } from '../call.js';

/** ISBLANK (SPEC §9.3): NULL, empty text or empty list. */
export const ISBLANK: SqlFunction = (call) => call.compiler.blank(call.arg(0));
