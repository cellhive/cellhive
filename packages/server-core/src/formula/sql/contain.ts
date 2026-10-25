import { sql } from 'kysely';

import { members } from '../call.js';

import type { SqlFunction } from '../call.js';

/** CONTAIN (SPEC §9.3): The range (value or list) holds at least one of the values. Elements compare as `=` does (dates with datetimes as instants, users by id). */
export const CONTAIN: SqlFunction = (call) => {
  const { range, values } = members(call);
  return sql`(coalesce(${range} && ${values}, false))`;
};
