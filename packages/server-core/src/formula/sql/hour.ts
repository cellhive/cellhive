import { sql } from 'kysely';

import type { SqlFunction } from '../call.js';

/** HOUR (SPEC §9.3): Hour of a datetime in its zone (`fx.hour`); 0 for a date. */
export const HOUR: SqlFunction = (call) => {
  const value = call.arg(0);
  const zone = call.compiler.tz(value);
  return value.type.kind === 'datetime'
    ? sql`fx.hour(${value.sql}, ${zone})`
    : value.type.kind === 'text'
      ? sql`fx.hour(fx.wall_time(${value.sql}, ${zone}), ${zone})`
      : sql`(CASE WHEN ${call.compiler.localDate(value)} IS NULL THEN NULL ELSE CAST(0 AS numeric) END)`;
};
