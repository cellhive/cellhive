import { sql } from 'kysely';

import { argsFrom } from '../call.js';
import { nonNullList } from '../values.js';

import type { SqlFunction } from '../call.js';

/** COUNTA (SPEC §9.3): Non-empty values; a list counts each non-empty element. */
export const COUNTA: SqlFunction = (call) => {
  const counts = argsFrom(call, 0).map((value) => {
    if (value.type.kind !== 'list') {
      return sql`(CASE WHEN ${call.compiler.blank(value)} THEN 0 ELSE 1 END)`;
    }
    const element = { sql: sql`u.v`, type: value.type.element };
    return sql`(SELECT count(*) FROM unnest(${nonNullList(value)}) AS u(v) WHERE NOT ${call.compiler.blank(element)})`;
  });
  return sql`CAST(${sql.join(counts, sql` + `)} AS numeric)`;
};
