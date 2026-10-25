import { sql } from 'kysely';

import { numbers } from '../call.js';

import type { SqlFunction } from '../call.js';

/** STDEV (SPEC §9.3): Sample standard deviation, n − 1 (`fx.stdev`; NULL for fewer than two numbers). */
export const STDEV: SqlFunction = (call) => sql`fx.stdev(${numbers(call)})`;
