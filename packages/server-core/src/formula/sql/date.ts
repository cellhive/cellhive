import { sql } from 'kysely';

import { num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** DATE (SPEC §9.3): Date of year, month, day; months and days roll over (`fx.date`). */
export const DATE: SqlFunction = (call) =>
  sql`fx.date(${num(call, 0)}, ${num(call, 1)}, ${num(call, 2)})`;
