import { listOf, T } from '@cellhive/formula-engine';
import { sql } from 'kysely';

import { as, bool, has, num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** RANK (SPEC §9.3): Rank in a list (1 = largest, or smallest when ascending); -1 when absent (`fx.rank`). */
export const RANK: SqlFunction = (call) =>
  sql`fx.rank(${num(call, 0)}, ${as(call, 1, listOf(T.number))}, ${has(call, 2) ? bool(call, 2) : sql`false`})`;
