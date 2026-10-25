import { sql } from 'kysely';

import { argsFrom, elementOfType } from '../call.js';
import { emptyOf, sqlTypeOf } from '../values.js';

import type { SqlFunction } from '../call.js';

/** LIST (SPEC §9.3): A list of the values. */
export const LIST: SqlFunction = (call) => {
  if (call.count === 0) return emptyOf(call.type);
  const element = elementOfType(call.type);
  const values = argsFrom(call, 0).map((value) => call.compiler.as(value, element));
  return sql`ARRAY[${sql.join(values)}]::${sqlTypeOf(call.type)}`;
};
