import { sql } from 'kysely';

import { as, bool } from '../call.js';
import { nullOf, type Sql } from '../values.js';

import type { SqlFunction } from '../call.js';

/** IFS (SPEC §9.3): Value of the first true condition, NULL when none is. */
export const IFS: SqlFunction = (call) => {
  const arms: Sql[] = [];
  for (let index = 0; index + 1 < call.count; index += 2) {
    arms.push(sql`WHEN ${bool(call, index)} THEN ${as(call, index + 1, call.type)}`);
  }
  return sql`(CASE ${sql.join(arms, sql` `)} ELSE ${nullOf(call.type)} END)`;
};
