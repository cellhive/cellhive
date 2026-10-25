import { sql } from 'kysely';

import type { SqlFunction } from '../call.js';
import type { Sql } from '../values.js';

/** DAYS (SPEC §9.3): Days from the start date to the end date (calendar days in the zone). */
export const DAYS: SqlFunction = (call) => {
  // A text date argument (M4) is read with the TODATE rule in the zone.
  const asLocalDate = (index: number): Sql => {
    const value = call.arg(index);
    return value.type.kind === 'text'
      ? sql`fx.date_text_arg(${value.sql}, ${call.compiler.tz(value)})`
      : call.compiler.localDate(value);
  };
  return sql`CAST(${asLocalDate(0)} - ${asLocalDate(1)} AS numeric)`;
};
