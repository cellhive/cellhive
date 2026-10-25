import { sql } from 'kysely';

import { holidays } from '../call.js';

import type { SqlFunction } from '../call.js';
import type { Sql } from '../values.js';

/** NETWORKDAYS (SPEC §9.3): Working days between two dates, both included (`fx.networkdays`). */
export const NETWORKDAYS: SqlFunction = (call) => {
  // A text date argument (M4) is read with the TODATE rule in the zone.
  const asLocalDate = (index: number): Sql => {
    const value = call.arg(index);
    return value.type.kind === 'text'
      ? sql`fx.date_text_arg(${value.sql}, ${call.compiler.tz(value)})`
      : call.compiler.localDate(value);
  };
  return sql`fx.networkdays(${asLocalDate(0)}, ${asLocalDate(1)}, ${holidays(call, 2)})`;
};
