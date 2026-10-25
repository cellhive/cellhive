import { sql } from 'kysely';

import type { SqlFunction } from '../call.js';

/** YEAR (SPEC §9.3): Year of a date, or of a datetime in its zone (`fx.year`). */
export const YEAR: SqlFunction = (call) => {
  const value = call.arg(0);
  return value.type.kind === 'datetime'
    ? sql`fx.year(${value.sql}, ${call.compiler.tz(value)})`
    : value.type.kind === 'text'
      ? sql`fx.year(fx.date_text_arg(${value.sql}, ${call.compiler.tz(value)}))`
      : sql`fx.year(${call.compiler.localDate(value)})`;
};
