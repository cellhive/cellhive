import { sql } from 'kysely';

import { num, numOr } from '../call.js';

import type { SqlFunction } from '../call.js';

/** ROUND (SPEC §9.3): Rounds halves away from zero to the given decimal places (0 when left out; `fx.round`). */
export const ROUND: SqlFunction = (call) => sql`fx.round(${num(call, 0)}, ${numOr(call, 1, '0')})`;
