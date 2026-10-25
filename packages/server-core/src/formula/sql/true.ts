import { sql } from 'kysely';

import type { SqlFunction } from '../call.js';

/** TRUE (SPEC §9.3): The boolean TRUE. */
export const TRUE: SqlFunction = () => sql`true`;
