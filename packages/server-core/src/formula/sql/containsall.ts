import { sql } from 'kysely';

import { members } from '../call.js';

import type { SqlFunction } from '../call.js';

/** CONTAINSALL (SPEC §9.3): The range holds every value. Elements compare as `=` does (dates with datetimes as instants, users by id). */
export const CONTAINSALL: SqlFunction = (call) => {
  const { range, values } = members(call);
  return sql`(coalesce(${range} @> ${values}, false))`;
};
