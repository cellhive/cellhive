import { sql } from 'kysely';

import { numOr, txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** RIGHT (SPEC §9.3): Last characters (1 when the count is left out; `fx.right`). */
export const RIGHT: SqlFunction = (call) => sql`fx.right(${txt(call, 0)}, ${numOr(call, 1, '1')})`;
