import { sql } from 'kysely';

import { as } from '../call.js';
import { nullOf, type Sql } from '../values.js';

import type { SqlFunction } from '../call.js';

/** SWITCH (SPEC §9.3): Result of the first pattern equal to the expression (as `=`), else the default. */
export const SWITCH: SqlFunction = (call) => {
  const expression = call.arg(0);
  const hasDefault = call.count % 2 === 0;
  const arms: Sql[] = [];
  for (let index = 1; index + 1 < call.count; index += 2) {
    const match = call.compiler.equals(expression, call.arg(index));
    arms.push(sql`WHEN ${match} THEN ${as(call, index + 1, call.type)}`);
  }
  const fallback = hasDefault ? as(call, call.count - 1, call.type) : nullOf(call.type);
  return sql`(CASE ${sql.join(arms, sql` `)} ELSE ${fallback} END)`;
};
