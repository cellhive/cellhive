import { sql } from 'kysely';

import { num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** EOMONTH (SPEC §9.3): Last day of the month n months later (`fx.eomonth`). */
export const EOMONTH: SqlFunction = (call) => {
  const value = call.arg(0);
  const start =
    value.type.kind === 'text'
      ? sql`fx.date_text_arg(${value.sql}, ${call.compiler.tz(value)})`
      : call.compiler.localDate(value);
  return sql`fx.eomonth(${start}, ${num(call, 1)})`;
};
