import { sql } from 'kysely';

import { valueList } from '../call.js';

import type { SqlFunction } from '../call.js';

/** LAST (SPEC §9.3): Last element (NULL for an empty list). */
export const LAST: SqlFunction = (call) => {
  const list = valueList(call, 0).sql;
  return sql`(${list})[cardinality(${list})]`;
};
