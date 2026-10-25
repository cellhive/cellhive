import { T } from '@cellhive/formula-engine';
import { sql } from 'kysely';

import { as, has, valueList } from '../call.js';

import type { SqlFunction } from '../call.js';

/** SORT (SPEC §9.3): Sorted list, ascending unless the second argument is FALSE (empty elements last). */
export const SORT: SqlFunction = (call) => {
  const list = valueList(call, 0);
  const ascending = has(call, 1) ? sql`coalesce(${as(call, 1, T.boolean)}, true)` : sql`true`;
  return sql`ARRAY(SELECT u.v FROM unnest(${list.sql}) WITH ORDINALITY AS u(v, i) ORDER BY CASE WHEN ${ascending} THEN u.v END ASC NULLS LAST, CASE WHEN NOT ${ascending} THEN u.v END DESC NULLS LAST, u.i)`;
};
