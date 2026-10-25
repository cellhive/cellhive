import { sql } from 'kysely';

import { num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** INT (SPEC §9.3): Rounds down to an integer. */
export const INT: SqlFunction = (call) => sql`floor(${num(call, 0)})`;
