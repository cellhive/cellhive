import { sql } from 'kysely';

import { argsFrom, bool } from '../call.js';

import type { SqlFunction } from '../call.js';

/** OR (SPEC §9.3): At least one condition true (an empty one counts as FALSE). */
export const OR: SqlFunction = (call) =>
  sql`(${sql.join(
    argsFrom(call, 0).map((_, index) => bool(call, index)),
    sql` OR `,
  )})`;
