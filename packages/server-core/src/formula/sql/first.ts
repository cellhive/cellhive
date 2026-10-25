import { sql } from 'kysely';

import { valueList } from '../call.js';

import type { SqlFunction } from '../call.js';

/** FIRST (SPEC §9.3): First element (NULL for an empty list). */
export const FIRST: SqlFunction = (call) => sql`(${valueList(call, 0).sql})[1]`;
