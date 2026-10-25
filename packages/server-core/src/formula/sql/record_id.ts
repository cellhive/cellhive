import type { SqlFunction } from '../call.js';

/** RECORD_ID (SPEC §9.3): ID of the record (`__id`). */
export const RECORD_ID: SqlFunction = (call) => call.compiler.column('__id');
