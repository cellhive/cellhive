import { sql } from 'kysely';

import { numOr, txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** LEFT (SPEC §9.3): First characters (1 when the count is left out; `fx.left`). */
export const LEFT: SqlFunction = (call) => sql`fx.left(${txt(call, 0)}, ${numOr(call, 1, '1')})`;
