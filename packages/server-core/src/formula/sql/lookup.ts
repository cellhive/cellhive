import type { SqlFunction } from '../call.js';

/** LOOKUP (SPEC §9.3): Short for FILTER over another table: compiled by the cross-table compiler (T455). */
export const LOOKUP: SqlFunction = (call) => call.compiler.crossTable('LOOKUP');
