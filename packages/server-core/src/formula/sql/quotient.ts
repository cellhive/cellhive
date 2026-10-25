import { sql } from 'kysely';

import { num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** QUOTIENT (SPEC §9.3): Integer part of a division; NULL when dividing by zero (`fx.quotient`). */
export const QUOTIENT: SqlFunction = (call) => sql`fx.quotient(${num(call, 0)}, ${num(call, 1)})`;
