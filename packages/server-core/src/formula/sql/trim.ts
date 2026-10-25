import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** TRIM (SPEC §9.3): Spaces trimmed and collapsed (`fx.trim`). */
export const TRIM: SqlFunction = (call) => sql`fx.trim(${txt(call, 0)})`;
