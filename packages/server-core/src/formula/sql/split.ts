import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** SPLIT (SPEC §9.3): List of the parts between separators (`fx.split`). */
export const SPLIT: SqlFunction = (call) => sql`fx.split(${txt(call, 0)}, ${txt(call, 1)})`;
