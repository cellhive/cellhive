import { sql } from 'kysely';

import { argsFrom } from '../call.js';

import type { SqlFunction } from '../call.js';

/** MAX (SPEC §9.3): Largest number or date (empty values skipped; NULL when none). */
export const MAX: SqlFunction = (call) =>
  sql`(SELECT max(u.v) FROM unnest(${call.compiler.combine(argsFrom(call, 0), call.type)}) AS u(v))`;
