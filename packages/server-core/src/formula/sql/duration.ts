import { sql } from 'kysely';

import { has, num } from '../call.js';
import { numberParam } from '../values.js';

import type { SqlFunction } from '../call.js';

/** DURATION (SPEC §9.3): A number of days from days, hours, minutes, seconds (empty parts count as 0). */
export const DURATION: SqlFunction = (call) => {
  const part = (index: number, per: string) =>
    has(call, index) ? sql` + coalesce(${num(call, index)}, 0) / ${numberParam(per)}` : sql``;
  return sql`(${num(call, 0)}${part(1, '24')}${part(2, '1440')}${part(3, '86400')})`;
};
