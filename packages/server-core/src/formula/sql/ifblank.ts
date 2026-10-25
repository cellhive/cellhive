import { sql } from 'kysely';

import { as } from '../call.js';

import type { SqlFunction } from '../call.js';

/** IFBLANK (SPEC §9.3): Fallback when the value is empty (NULL, empty text, empty list). */
export const IFBLANK: SqlFunction = (call) => {
  const value = call.compiler.coerce(call.arg(0), call.type);
  return sql`(CASE WHEN ${call.compiler.blank(value)} THEN ${as(call, 1, call.type)} ELSE ${value.sql} END)`;
};
