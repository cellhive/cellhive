import { sql } from 'kysely';

import { num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** ABS (SPEC §9.3): Absolute value. */
export const ABS: SqlFunction = (call) => sql`abs(${num(call, 0)})`;
