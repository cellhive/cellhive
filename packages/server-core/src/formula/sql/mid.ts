import { sql } from 'kysely';

import { num, txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** MID (SPEC §9.3): `count` characters from position `start` (`fx.mid`). */
export const MID: SqlFunction = (call) =>
  sql`fx.mid(${txt(call, 0)}, ${num(call, 1)}, ${num(call, 2)})`;
