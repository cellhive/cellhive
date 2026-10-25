import { sql } from 'kysely';

import { num, numOr } from '../call.js';

import type { SqlFunction } from '../call.js';

/** ROUNDUP (SPEC §9.3): Rounds away from zero to the given decimal places (0 when left out; `fx.roundup`). */
export const ROUNDUP: SqlFunction = (call) =>
  sql`fx.roundup(${num(call, 0)}, ${numOr(call, 1, '0')})`;
