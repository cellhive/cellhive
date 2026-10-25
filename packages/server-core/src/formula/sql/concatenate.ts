import { sql } from 'kysely';

import { argsFrom } from '../call.js';

import type { SqlFunction } from '../call.js';

/** CONCATENATE (SPEC §9.3): Texts joined (empty values as empty text). */
export const CONCATENATE: SqlFunction = (call) =>
  sql`(${sql.join(
    argsFrom(call, 0).map((value) => sql`coalesce(${call.compiler.toText(value)}, '')`),
    sql` || `,
  )})`;
