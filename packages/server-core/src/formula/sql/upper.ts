import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** UPPER (SPEC §9.3): simple Unicode uppercase mapping, whatever the collation (`fx.upper`, T473). */
export const UPPER: SqlFunction = (call) => sql`fx.upper(${txt(call, 0)})`;
