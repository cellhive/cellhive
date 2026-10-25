import { sql } from 'kysely';

import { elementOfType, txtOr, valueList } from '../call.js';

import type { SqlFunction } from '../call.js';

/** ARRAYJOIN (SPEC §9.3): Elements as text joined by the separator (", " when left out); empty elements skipped. */
export const ARRAYJOIN: SqlFunction = (call) => {
  const list = valueList(call, 0);
  const element = call.compiler.toText({ sql: sql`u.v`, type: elementOfType(list.type) });
  return sql`coalesce((SELECT string_agg(${element}, ${txtOr(call, 1, ', ')} ORDER BY u.i) FROM unnest(${list.sql}) WITH ORDINALITY AS u(v, i) WHERE u.v IS NOT NULL), '')`;
};
