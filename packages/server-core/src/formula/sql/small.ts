import { listOf, T } from '@cellhive/formula-engine';
import { sql } from 'kysely';

import { as, num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** SMALL (SPEC §9.3): k-th smallest number of a list; NULL when k is out of range (`fx.small`). */
export const SMALL: SqlFunction = (call) =>
  sql`fx.small(${as(call, 0, listOf(T.number))}, ${num(call, 1)})`;
