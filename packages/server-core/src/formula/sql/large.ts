import { listOf, T } from '@cellhive/formula-engine';
import { sql } from 'kysely';

import { as, num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** LARGE (SPEC §9.3): k-th largest number of a list; NULL when k is out of range (`fx.large`). */
export const LARGE: SqlFunction = (call) =>
  sql`fx.large(${as(call, 0, listOf(T.number))}, ${num(call, 1)})`;
