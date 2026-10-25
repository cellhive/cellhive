import { sql } from 'kysely';

import { argsFrom } from '../call.js';

import type { SqlFunction } from '../call.js';

/** MIN (SPEC §9.3): Smallest number or date (empty values skipped; NULL when none). */
export const MIN: SqlFunction = (call) =>
  sql`(SELECT min(u.v) FROM unnest(${call.compiler.combine(argsFrom(call, 0), call.type)}) AS u(v))`;
