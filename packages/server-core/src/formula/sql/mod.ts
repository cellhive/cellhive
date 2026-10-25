import { sql } from 'kysely';

import { num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** MOD (SPEC §9.3): Remainder with the sign of the divisor; NULL when dividing by zero (`fx.mod`). */
export const MOD: SqlFunction = (call) => sql`fx.mod(${num(call, 0)}, ${num(call, 1)})`;
