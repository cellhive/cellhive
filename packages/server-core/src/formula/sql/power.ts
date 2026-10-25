import { sql } from 'kysely';

import { num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** POWER (SPEC §9.3): Power; NULL for 0^negative, negative^fraction or beyond 10^±1000 (`fx.power`). */
export const POWER: SqlFunction = (call) => sql`fx.power(${num(call, 0)}, ${num(call, 1)})`;
