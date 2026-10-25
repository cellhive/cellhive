import { sql } from 'kysely';

import { num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** SQRT (SPEC §9.3): Square root; NULL for a negative number (`fx.sqrt`). */
export const SQRT: SqlFunction = (call) => sql`fx.sqrt(${num(call, 0)})`;
