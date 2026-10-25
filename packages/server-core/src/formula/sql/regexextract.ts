import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** REGEXEXTRACT (SPEC §9.3): First match of a regular expression (`fx.regex_extract`). */
export const REGEXEXTRACT: SqlFunction = (call) =>
  sql`fx.regex_extract(${txt(call, 0)}, ${txt(call, 1)})`;
