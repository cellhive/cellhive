import { sql } from 'kysely';

import { num } from '../call.js';

import type { SqlFunction } from '../call.js';

/** EDATE (SPEC §9.3): Same day n months later, clamped to the month end (`fx.edate`); a datetime keeps its wall-clock time. */
export const EDATE: SqlFunction = (call) => {
  const value = call.arg(0);
  return value.type.kind === 'datetime'
    ? sql`fx.edate(${value.sql}, ${num(call, 1)}, ${call.compiler.tz(value)})`
    : value.type.kind === 'text'
      ? sql`fx.edate(fx.todate(${value.sql}, ${call.compiler.tz(value)}), ${num(call, 1)}, ${call.compiler.tz(value)})`
      : sql`fx.edate(${call.compiler.localDate(value)}, ${num(call, 1)})`;
};
