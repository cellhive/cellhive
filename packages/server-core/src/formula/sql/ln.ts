import { sql } from 'kysely';

import { num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** LN (SPEC §9.3): Natural logarithm; NULL for x ≤ 0 (`fx.ln`). */
export const LN: SqlFunction = (call) => sql`fx.ln(${num(call, 0)})`;
