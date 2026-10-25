import { sql } from 'kysely';

import { numbers } from '../call.js';

import type { SqlFunction } from '../call.js';

/** MEDIAN (SPEC §9.3): Middle value (`fx.median`). */
export const MEDIAN: SqlFunction = (call) => sql`fx.median(${numbers(call)})`;
