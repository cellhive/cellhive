import { sql } from 'kysely';

import { numbers } from '../call.js';

import type { SqlFunction } from '../call.js';

/** SUM (SPEC §9.3): Sum of the numbers and lists of numbers (empty values skipped; 0 when none). */
export const SUM: SqlFunction = (call) =>
  sql`(SELECT coalesce(sum(u.v), 0) FROM unnest(${numbers(call)}) AS u(v))`;
