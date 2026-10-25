import type { SqlFunction } from '../call.js';

/** SORTBY (SPEC §9.3): Sorts records: compiled by the cross-table compiler (T455). */
export const SORTBY: SqlFunction = (call) => call.compiler.crossTable('SORTBY');
