import { sql } from 'kysely';

import type { SqlFunction } from '../call.js';

/** FALSE (SPEC §9.3): The boolean FALSE. */
export const FALSE: SqlFunction = () => sql`false`;
