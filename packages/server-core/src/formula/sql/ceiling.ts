import { sql } from 'kysely';

import { num, numOr } from '../call.js';

import type { SqlFunction } from '../call.js';

/** CEILING (SPEC §9.3): Rounds up to a multiple of |factor| (1 when left out; factor 0 → NULL). */
export const CEILING: SqlFunction = (call) =>
  sql`fx.ceiling(${num(call, 0)}, ${numOr(call, 1, '1')})`;
