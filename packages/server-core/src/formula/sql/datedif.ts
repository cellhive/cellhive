import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';
import type { Sql } from '../values.js';

/** DATEDIF (SPEC §9.3): Whole years/months/days between two dates (`fx.datedif`). */
export const DATEDIF: SqlFunction = (call) => {
  // A text date argument (M4) is read with the TODATE rule in the zone.
  const asLocalDate = (index: number): Sql => {
    const value = call.arg(index);
    return value.type.kind === 'text'
      ? sql`fx.date_text_arg(${value.sql}, ${call.compiler.tz(value)})`
      : call.compiler.localDate(value);
  };
  return sql`fx.datedif(${asLocalDate(0)}, ${asLocalDate(1)}, ${txt(call, 2)})`;
};
