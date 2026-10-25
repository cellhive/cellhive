import { sql } from 'kysely';

import { bool } from '../call.js';

import type { SqlFunction } from '../call.js';

/** NOT (SPEC §9.3): Reverses a condition (an empty one counts as FALSE). */
export const NOT: SqlFunction = (call) => sql`(NOT ${bool(call, 0)})`;
