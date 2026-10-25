import { sql } from 'kysely';

import type { SqlFunction } from '../call.js';

/** MONTH (SPEC §9.3): Month of a date, or of a datetime in its zone (`fx.month`). */
export const MONTH: SqlFunction = (call) => {
  const value = call.arg(0);
  return value.type.kind === 'datetime'
    ? sql`fx.month(${value.sql}, ${call.compiler.tz(value)})`
    : value.type.kind === 'text'
      ? sql`fx.month(fx.date_text_arg(${value.sql}, ${call.compiler.tz(value)}))`
      : sql`fx.month(${call.compiler.localDate(value)})`;
};
