import { sql } from 'kysely';

import { as, bool, has } from '../call.js';
import { nullOf } from '../values.js';

import type { SqlFunction } from '../call.js';

/** IF (SPEC §9.3): Condition true → second argument, else the third (NULL when left out). */
export const IF: SqlFunction = (call) =>
  sql`(CASE WHEN ${bool(call, 0)} THEN ${as(call, 1, call.type)} ELSE ${
    has(call, 2) ? as(call, 2, call.type) : nullOf(call.type)
  } END)`;
