import { sql } from 'kysely';

import type { SqlFunction } from '../call.js';

/** DAY (SPEC §9.3): Day of a date, or of a datetime in its zone (`fx.day`). */
export const DAY: SqlFunction = (call) => {
  const value = call.arg(0);
  return value.type.kind === 'datetime'
    ? sql`fx.day(${value.sql}, ${call.compiler.tz(value)})`
    : value.type.kind === 'text'
      ? sql`fx.day(fx.date_text_arg(${value.sql}, ${call.compiler.tz(value)}))`
      : sql`fx.day(${call.compiler.localDate(value)})`;
};
