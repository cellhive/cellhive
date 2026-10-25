import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** REGEXREPLACE (SPEC §9.3): Every match replaced (`fx.regex_replace`). */
export const REGEXREPLACE: SqlFunction = (call) =>
  sql`fx.regex_replace(${txt(call, 0)}, ${txt(call, 1)}, ${txt(call, 2)})`;
