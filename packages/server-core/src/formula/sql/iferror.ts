import { sql } from 'kysely';

import { as } from '../call.js';

import type { SqlFunction } from '../call.js';

/** IFERROR (SPEC §9.3): COALESCE: errors are NULL in SQL, so errors and empty values get the fallback (SPEC §9.4). */
export const IFERROR: SqlFunction = (call) =>
  sql`coalesce(${as(call, 0, call.type)}, ${as(call, 1, call.type)})`;
