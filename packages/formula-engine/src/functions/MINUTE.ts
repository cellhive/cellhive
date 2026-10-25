import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { localWall, parseTodateWall } from '../evaluate/dates.js';
import { Dec } from '../evaluate/decimal.js';
import { isDate, isDateTime } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** MINUTE (SPEC §9.3, date). */
export const MINUTE = define({
  name: 'MINUTE',
  group: 'date',
  signatures: [sig('number', [p('date', 'date')])],
  result: fixed(T.number),
  description: { en: 'Minute of a date and time (0–59).', vi: 'Phút của một thời điểm (0–59).' },
  examples: [ex('MINUTE(TODATE("2000-01-01 11:40:59"))', '40')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  const value = args.value(0);
  if (isDate(value)) return Dec.ZERO;
  if (isDateTime(value)) return Dec.int(localWall(value.ms, value.zone ?? args.rt.timeZone).minute);
  // Text at a date parameter (M4): the TODATE rule, or a bare "H:mm[:ss]".
  if (typeof value === 'string') {
    const wall = parseTodateWall(value, args.rt.timeZone);
    return wall === null ? null : Dec.int(wall.minute);
  }
  return null;
};
