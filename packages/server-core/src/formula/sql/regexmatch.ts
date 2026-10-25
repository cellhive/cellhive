import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** REGEXMATCH (SPEC §9.3): Regular expression match; NULL for a bad pattern (`fx.regex_match`). */
export const REGEXMATCH: SqlFunction = (call) =>
  sql`fx.regex_match(${txt(call, 0)}, ${txt(call, 1)})`;
