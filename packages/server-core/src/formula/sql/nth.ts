import { sql } from 'kysely';

import { num, valueList } from '../call.js';

import type { SqlFunction } from '../call.js';

/** NTH (SPEC §9.3): Element at a 1-based position (NULL out of range). */
export const NTH: SqlFunction = (call) =>
  sql`(${valueList(call, 0).sql})[fx.int_arg(${num(call, 1)})]`;
