import { sql } from 'kysely';

import { members } from '../call.js';

import type { SqlFunction } from '../call.js';

/** CONTAINSONLY (SPEC §9.3): The range is not empty and holds nothing but the values. Elements compare as `=` does (dates with datetimes as instants, users by id). */
export const CONTAINSONLY: SqlFunction = (call) => {
  const { range, values } = members(call);
  return sql`(coalesce(cardinality(${range}) > 0 AND ${values} @> ${range}, false))`;
};
