import { sql } from 'kysely';

import type { SqlFunction } from '../call.js';

/** ISNUMBER (SPEC §9.3): A number that is set (texts are never numbers). */
export const ISNUMBER: SqlFunction = (call) => {
  const value = call.arg(0);
  return value.type.kind === 'number' ? sql`(${value.sql} IS NOT NULL)` : sql`false`;
};
