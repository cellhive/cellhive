import { sql } from 'kysely';

import { num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** EXP (SPEC §9.3): e to a power (`fx.exp`). */
export const EXP: SqlFunction = (call) => sql`fx.exp(${num(call, 0)})`;
