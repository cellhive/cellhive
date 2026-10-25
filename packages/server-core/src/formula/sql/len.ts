import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** LEN (SPEC §9.3): Length in Unicode code points. */
export const LEN: SqlFunction = (call) => sql`CAST(char_length(${txt(call, 0)}) AS numeric)`;
