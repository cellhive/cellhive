import { sql } from 'kysely';

import { numOr } from '../call.js';

import type { SqlFunction } from '../call.js';

/** WEEKNUM (SPEC §9.3): Week of the year, weeks from Sunday (1, default) or Monday (2) (`fx.weeknum`). */
export const WEEKNUM: SqlFunction = (call) => {
  const value = call.arg(0);
  const text =
    value.type.kind === 'text'
      ? sql`fx.date_text_arg(${value.sql}, ${call.compiler.tz(value)})`
      : call.compiler.localDate(value);
  return sql`fx.weeknum(${text}, ${numOr(call, 1, '1')})`;
};
