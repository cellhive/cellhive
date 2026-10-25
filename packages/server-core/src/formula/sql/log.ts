import { sql } from 'kysely';

import { num, numOr } from '../call.js';

import type { SqlFunction } from '../call.js';

/** LOG (SPEC §9.3): Logarithm in a base (10 when left out); NULL out of range (`fx.log`). */
export const LOG: SqlFunction = (call) => sql`fx.log(${num(call, 0)}, ${numOr(call, 1, '10')})`;
