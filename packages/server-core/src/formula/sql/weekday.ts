import { sql } from 'kysely';

import { numOr } from '../call.js';

import type { SqlFunction } from '../call.js';

/** WEEKDAY (SPEC §9.3): Day of the week, type 1 (Sunday = 1, default) or 2 (Monday = 1) (`fx.weekday`). */
export const WEEKDAY: SqlFunction = (call) => {
  const value = call.arg(0);
  const text =
    value.type.kind === 'text'
      ? sql`fx.date_text_arg(${value.sql}, ${call.compiler.tz(value)})`
      : call.compiler.localDate(value);
  return sql`fx.weekday(${text}, ${numOr(call, 1, '1')})`;
};
