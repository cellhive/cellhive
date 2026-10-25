import { sql } from 'kysely';

import { numOr, txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** FIND (SPEC §9.3): Position of a text in another from `start`, -1 when absent (`fx.find`). */
export const FIND: SqlFunction = (call) =>
  sql`fx.find(${txt(call, 0)}, ${txt(call, 1)}, ${numOr(call, 2, '1')})`;
