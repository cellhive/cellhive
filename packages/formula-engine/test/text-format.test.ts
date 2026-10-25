import { describe, expect, it } from 'vitest';

import { Dec } from '../src/evaluate/decimal.js';
import { formatDate, formatNumber } from '../src/evaluate/text-format.js';

/**
 * `TEXT` patterns after Lark (BACKLOG T473, research L3/L4; SPEC §9.4):
 * the same rules as `fx.text_number` / `fx.text_date` (migration 0023).
 */
describe('formatNumber (TEXT(number, pattern))', () => {
  const cases: [string, string, string | null][] = [
    // Lark examples (L4).
    ['23.1', '##.##', '23.1'],
    ['23.1', '0.00', '23.10'],
    ['23.1', '000.00', '023.10'],
    ['23100', '0,0', '23,100'],
    ['23', '0%', '2300%'],
    ['7', '0000', '0007'],
    // Integer part: `0` = minimum digits, `#` = optional, `,` groups thousands.
    ['1234.5', '#,##0.00', '1,234.50'],
    ['-1234.567', '#,##0', '-1,235'],
    ['1234567', '#,###', '1,234,567'],
    ['12345678901234567890', '#,##0', '12,345,678,901,234,567,890'],
    ['0', '#', ''],
    ['0', '0', '0'],
    ['0.5', '#.##', '.5'],
    ['0.5', '0.##', '0.5'],
    ['5', '#', '5'],
    ['123', '#', '123'],
    // Decimal part: `0` = always shown, `#` = shown when significant.
    ['23', '##.##', '23.'],
    ['1.5', '0.0#', '1.5'],
    ['1.25', '0.0#', '1.25'],
    ['1.255', '0.0#', '1.26'],
    ['1.2', '0.#0', '1.20'],
    ['1', '0.', '1.'],
    ['2.5', '0', '3'],
    ['-2.5', '0', '-3'],
    ['-0.4', '0', '0'],
    ['-0.5', '#.#', '-.5'],
    ['3.14159', '0.00', '3.14'],
    ['0.256', '0.0%', '25.6%'],
    ['0.5', '0%', '50%'],
    ['0.12345', '0.###%', '12.345%'],
    // Not a number pattern → empty.
    ['1', 'abc', null],
    ['1.5', '0.00 đ', null],
    ['1', '%', null],
    ['1', '.', null],
    ['1', '', null],
    ['1', ',0', null],
    ['1', '0,', null],
    ['1', '0.0.0', null],
    ['1', '0%%', null],
    ['1', '0'.repeat(41), null],
    ['1', `0.${'0'.repeat(21)}`, null],
  ];
  it.each(cases)('TEXT(%s, "%s") = %j', (value, pattern, expected) => {
    expect(formatNumber(Dec.parse(value) as Dec, pattern)).toBe(expected);
  });
});

describe('formatDate (TEXT(date, pattern))', () => {
  // Friday 2021-04-09 17:05:03.
  const wall = { year: 2021, month: 4, day: 9, hour: 17, minute: 5, second: 3 };
  const cases: [string, string | null][] = [
    ['YYYY/MM/DD', '2021/04/09'],
    ['yyyy/mm/dd', '2021/04/09'],
    ['YYMMDD', '210409'],
    ['MM/DD/YYYY', '04/09/2021'],
    ['M/D/YY', '4/9/21'],
    ['MMMM', 'April'],
    ['mmm', 'Apr'],
    ['DDDD', 'Friday'],
    ['ddd', 'Fri'],
    ['DDDD, D MMMM YYYY', 'Friday, 9 April 2021'],
    ['hh:mm', '17:05'],
    ['HH:MM', '17:05'],
    ['h:m', '17:5'],
    ['hh:mm:ss', '17:05:03'],
    ['mm:ss', '05:03'],
    ['MM ss', '05 03'],
    ['hh', '17'],
    ['H', '17'],
    ['SS', '03'],
    ['YYYY-MM-DD hh:mm', '2021-04-09 17:05'],
    ['DD/MM hh:mm', '09/04 17:05'],
    ['MM hh', '04 17'],
    ['hh DD MM', '17 09 04'],
    ['YYYY-MM-DDThh:mm:ss', '2021-04-09T17:05:03'],
    ['YYYY年MM月DD日', '2021年04月09日'],
    ['Y s', 'Y s'],
    ['YYYYY', '2021Y'],
    ['DDDDD', 'Friday9'],
    ['MMMMM', 'April4'],
    ['ſſ ı', 'ſſ ı'],
    ['[h]:mm', null],
    ['[MM]', null],
    ['[ss]', null],
    ['[x]', '[x]'],
    ['', ''],
  ];
  it.each(cases)('TEXT(date, "%s") = %j', (pattern, expected) => {
    expect(formatDate(pattern, wall)).toBe(expected);
  });

  it('pads years and names every month and weekday in English', () => {
    expect(formatDate('YYYY YY', { ...wall, year: 7 })).toBe('0007 07');
    const months: string[] = [];
    for (let month = 1; month <= 12; month += 1) {
      months.push(formatDate('MMM MMMM', { ...wall, month, day: 1 }) ?? '');
    }
    expect(months).toEqual([
      'Jan January',
      'Feb February',
      'Mar March',
      'Apr April',
      'May May',
      'Jun June',
      'Jul July',
      'Aug August',
      'Sep September',
      'Oct October',
      'Nov November',
      'Dec December',
    ]);
    const days: string[] = [];
    // 2021-04-04 is a Sunday.
    for (let day = 4; day <= 10; day += 1)
      days.push(formatDate('ddd dddd', { ...wall, day }) ?? '');
    expect(days).toEqual([
      'Sun Sunday',
      'Mon Monday',
      'Tue Tuesday',
      'Wed Wednesday',
      'Thu Thursday',
      'Fri Friday',
      'Sat Saturday',
    ]);
  });
});
