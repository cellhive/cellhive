import { sql } from 'kysely';

import { inIteration, valueList } from '../call.js';
import { truthy } from '../values.js';

import type { SqlFunction } from '../call.js';

/** FILTER (SPEC §9.3): Elements of a value list for which the condition holds (over records: T455). */
export const FILTER: SqlFunction = (call) => {
  const list = valueList(call, 0);
  const condition = truthy(inIteration(call, list, 1).sql);
  return sql`ARRAY(SELECT cv.v FROM unnest(${list.sql}) WITH ORDINALITY AS cv(v, i) WHERE ${condition} ORDER BY cv.i)`;
};
