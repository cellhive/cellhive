import { sql } from 'kysely';

import type { SqlFunction } from '../call.js';

/** PI (SPEC §9.3): π to 50 decimal places (`fx.pi`). */
export const PI: SqlFunction = () => sql`fx.pi()`;
