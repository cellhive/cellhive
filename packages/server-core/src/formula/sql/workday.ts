import { sql } from 'kysely';

import { holidays, num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** WORKDAY (SPEC §9.3): n working days later, skipping weekends and holidays (`fx.workday`). */
export const WORKDAY: SqlFunction = (call) => {
  const value = call.arg(0);
  const start =
    value.type.kind === 'text'
      ? sql`fx.date_text_arg(${value.sql}, ${call.compiler.tz(value)})`
      : call.compiler.localDate(value);
  return sql`fx.workday(${start}, ${num(call, 1)}, ${holidays(call, 2)})`;
};
