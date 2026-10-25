import { sql } from 'kysely';

import { inIteration, valueList } from '../call.js';
import { nonNullList, truthy } from '../values.js';

import type { SqlFunction } from '../call.js';

/** SUMIF (SPEC §9.3): Sum of the numbers of a list for which the condition holds (over records: T455). */
export const SUMIF: SqlFunction = (call) => {
  if (call.count > 2) return call.compiler.crossTable('SUMIF over records');
  const list = valueList(call, 0);
  const condition = truthy(inIteration(call, list, 1).sql);
  return sql`(SELECT coalesce(sum(cv.v), 0) FROM unnest(${nonNullList(list)}) AS cv(v) WHERE ${condition})`;
};
