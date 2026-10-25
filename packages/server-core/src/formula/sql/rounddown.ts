import { sql } from 'kysely';

import { num, numOr } from '../call.js';

import type { SqlFunction } from '../call.js';

/** ROUNDDOWN (SPEC §9.3): Rounds toward zero to the given decimal places (0 when left out; `fx.rounddown`). */
export const ROUNDDOWN: SqlFunction = (call) =>
  sql`fx.rounddown(${num(call, 0)}, ${numOr(call, 1, '0')})`;
