import { sql } from 'kysely';

import { argsFrom, bool } from '../call.js';

import type { SqlFunction } from '../call.js';

/** AND (SPEC §9.3): Every condition true (an empty one counts as FALSE). */
export const AND: SqlFunction = (call) =>
  sql`(${sql.join(
    argsFrom(call, 0).map((_, index) => bool(call, index)),
    sql` AND `,
  )})`;
