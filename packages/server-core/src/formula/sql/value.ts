import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** VALUE (SPEC §9.3): Number of a text; NULL when it is not a plain decimal (`fx.value`). */
export const VALUE: SqlFunction = (call) => sql`fx.value(${txt(call, 0)})`;
