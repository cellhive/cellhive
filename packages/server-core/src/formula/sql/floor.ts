import { sql } from 'kysely';

import { num, numOr } from '../call.js';

import type { SqlFunction } from '../call.js';

/** FLOOR (SPEC §9.3): Rounds down to a multiple of |factor| (1 when left out; factor 0 → NULL). */
export const FLOOR: SqlFunction = (call) => sql`fx.floor(${num(call, 0)}, ${numOr(call, 1, '1')})`;
