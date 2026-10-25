import { sql } from 'kysely';

import { argsFrom, elementOfType } from '../call.js';

import type { SqlFunction } from '../call.js';

/** UNIQUE (SPEC §9.3): Distinct values in first-seen order. */
export const UNIQUE: SqlFunction = (call) => {
  const values = call.compiler.combine(argsFrom(call, 0), elementOfType(call.type));
  return sql`ARRAY(SELECT u.v FROM unnest(${values}) WITH ORDINALITY AS u(v, i) GROUP BY u.v ORDER BY min(u.i))`;
};
