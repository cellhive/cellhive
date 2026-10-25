import { sql } from 'kysely';

import { numbers } from '../call.js';

import type { SqlFunction } from '../call.js';

/** AVERAGE (SPEC §9.3): Average of the numbers (empty values skipped; NULL when none). */
export const AVERAGE: SqlFunction = (call) =>
  sql`(SELECT avg(u.v) FROM unnest(${numbers(call)}) AS u(v))`;
