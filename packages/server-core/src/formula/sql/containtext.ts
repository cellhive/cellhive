import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** CONTAINTEXT (SPEC §9.3): The text contains the other (case-sensitive); FALSE for empty values. */
export const CONTAINTEXT: SqlFunction = (call) =>
  sql`coalesce(strpos(${txt(call, 0)}, ${txt(call, 1)}) > 0, false)`;
