import { sql } from 'kysely';

import { num, txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** REPLACE (SPEC §9.3): Replaces `count` characters from `start` (`fx.replace`). */
export const REPLACE: SqlFunction = (call) =>
  sql`fx.replace(${txt(call, 0)}, ${num(call, 1)}, ${num(call, 2)}, ${txt(call, 3)})`;
