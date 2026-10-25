import { sql } from 'kysely';

import { elementOfType, inIteration, valueList } from '../call.js';

import type { SqlFunction } from '../call.js';

/** MAP (SPEC §9.3): Each element of a value list turned into a new value (over records: T455). */
export const MAP: SqlFunction = (call) => {
  const list = valueList(call, 0);
  const mapped = call.compiler.as(inIteration(call, list, 1), elementOfType(call.type));
  return sql`ARRAY(SELECT ${mapped} FROM unnest(${list.sql}) WITH ORDINALITY AS cv(v, i) ORDER BY cv.i)`;
};
