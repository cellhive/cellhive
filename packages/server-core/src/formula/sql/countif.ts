import { sql } from 'kysely';

import { inIteration, valueList } from '../call.js';
import { nonNullList, truthy } from '../values.js';

import type { SqlFunction } from '../call.js';

/** COUNTIF (SPEC §9.3): Elements of a value list for which the condition holds (over records: T455). */
export const COUNTIF: SqlFunction = (call) => {
  const list = valueList(call, 0);
  const condition = truthy(inIteration(call, list, 1).sql);
  return sql`CAST((SELECT count(*) FROM unnest(${nonNullList(list)}) AS cv(v) WHERE ${condition}) AS numeric)`;
};
