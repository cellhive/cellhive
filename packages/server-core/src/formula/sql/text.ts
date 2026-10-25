import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/**
 * TEXT (SPEC §9.3): Number or date formatted with a fixed pattern (`fx.text_number`,
 * `fx.text_date` in the zone); a text value through `fx.text_text` (M4); other values as text.
 */
export const TEXT: SqlFunction = (call) => {
  const value = call.arg(0);
  const format = txt(call, 1);
  switch (value.type.kind) {
    case 'number':
      return sql`fx.text_number(${value.sql}, ${format})`;
    case 'date':
    case 'datetime':
      return sql`fx.text_date(${call.compiler.localTimestamp(value)}, ${format})`;
    case 'text':
      // A text value (M4): a date pattern formats the text read with the TODATE rule
      // (or a bare "H:mm[:ss]"), any other pattern passes it through (`fx.text_text`).
      return sql`fx.text_text(${value.sql}, ${format}, ${call.compiler.tz(value)})`;
    default:
      return call.compiler.toText(value);
  }
};
