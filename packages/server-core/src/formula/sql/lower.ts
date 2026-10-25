import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** LOWER (SPEC §9.3): simple Unicode lowercase mapping, whatever the collation (`fx.lower`, T473). */
export const LOWER: SqlFunction = (call) => sql`fx.lower(${txt(call, 0)})`;
