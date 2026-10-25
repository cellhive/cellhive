import { describe, expect, it } from 'vitest';

import {
  addMonths,
  civilFromDays,
  datedif,
  daysFromCivil,
  endOfMonth,
  isoDate,
  isoInstant,
  localDay,
  localText,
  makeDate,
  MAX_DAY,
  MIN_DAY,
  networkdays,
  parseDateText,
  startOfDay,
  weekday,
  weeknum,
  workday,
} from '../src/evaluate/dates.js';
import { formatDate } from '../src/evaluate/text-format.js';

const day = (text: string): number => {
  const [y, m, dd] = text.split('-').map(Number);
  return daysFromCivil(y ?? 0, m ?? 0, dd ?? 0);
};

describe('civil day numbers', () => {
  it('round-trips every 97th day from year 1 to 9999', () => {
    for (let n = MIN_DAY; n <= MAX_DAY; n += 97) {
      const { year, month, day: dd } = civilFromDays(n);
      expect(daysFromCivil(year, month, dd)).toBe(n);
    }
    expect(isoDate(MIN_DAY)).toBe('0001-01-01');
    expect(isoDate(MAX_DAY)).toBe('9999-12-31');
    expect(isoDate(0)).toBe('1970-01-01');
    expect(isoDate(-1)).toBe('1969-12-31');
  });

  it.each([
    [2000, 1, 1, '2000-01-01'],
    [2024, 2, 30, '2024-03-01'],
    [2025, 13, 1, '2026-01-01'],
    [2025, 0, 1, '2024-12-01'],
    [2025, 1, 0, '2024-12-31'],
    [2025, 1, -30, '2024-12-01'],
    [2025, -11, 1, '2024-01-01'],
  ])('DATE(%d, %d, %d) = %s', (y, m, dd, expected) => {
    const result = makeDate(y, m, dd);
    expect(result === null ? null : isoDate(result)).toBe(expected);
  });

  it.each([
    [0, 12, 31],
    [10000, 1, 1],
    [9999, 12, 32],
    [1, 1, 0],
    [-5, 1, 1],
    [20000, 1, 1],
  ])('DATE(%d, %d, %d) is out of range', (y, m, dd) => {
    expect(makeDate(y, m, dd)).toBeNull();
  });

  it.each([
    ['2011-01-31', 1, '2011-02-28'],
    ['2024-01-31', 1, '2024-02-29'],
    ['2024-03-31', -1, '2024-02-29'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2024-05-15', -17, '2022-12-15'],
  ])('EDATE(%s, %d) = %s', (start, months, expected) => {
    expect(isoDate(addMonths(day(start), months) ?? 0)).toBe(expected);
  });

  it.each([
    ['2000-01-01', 1, '2000-02-29'],
    ['1900-01-15', 1, '1900-02-28'],
    ['2026-12-15', 0, '2026-12-31'],
    ['2026-01-15', -2, '2025-11-30'],
  ])('EOMONTH(%s, %d) = %s', (start, months, expected) => {
    expect(isoDate(endOfMonth(day(start), months) ?? 0)).toBe(expected);
  });

  it('keeps EDATE/EOMONTH within years 1–9999', () => {
    expect(addMonths(day('9999-12-01'), 1)).toBeNull();
    expect(addMonths(day('0001-01-31'), -1)).toBeNull();
    expect(endOfMonth(day('9999-12-01'), 1)).toBeNull();
  });
});

describe('time zones (explicit, never the machine zone)', () => {
  it.each([
    ['2026-12-31T17:00:00Z', 'Asia/Ho_Chi_Minh', '2027-01-01'],
    ['2026-12-31T17:00:00Z', 'UTC', '2026-12-31'],
    ['2026-03-08T06:59:59Z', 'America/New_York', '2026-03-08'],
    ['2026-03-08T04:59:59Z', 'America/New_York', '2026-03-07'],
    ['2026-09-28T10:00:00Z', 'Pacific/Kiritimati', '2026-09-29'],
  ])('%s is %s in %s', (instant, zone, expected) => {
    expect(isoDate(localDay(Date.parse(instant), zone))).toBe(expected);
  });

  it.each([
    ['2026-09-28', 'Asia/Ho_Chi_Minh', '2026-09-27T17:00:00.000Z'],
    ['2026-03-08', 'America/New_York', '2026-03-08T05:00:00.000Z'],
    ['2026-03-09', 'America/New_York', '2026-03-09T04:00:00.000Z'],
    ['2026-11-01', 'America/New_York', '2026-11-01T04:00:00.000Z'],
  ])('midnight of %s in %s is %s', (date, zone, expected) => {
    expect(isoInstant(startOfDay(day(date), zone))).toBe(expected);
  });

  it('prints instants in UTC and local text in the zone', () => {
    expect(isoInstant(Date.parse('0001-01-01T00:00:00Z'))).toBe('0001-01-01T00:00:00.000Z');
    expect(isoInstant(-1)).toBe('1969-12-31T23:59:59.999Z');
    expect(localText(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York')).toBe(
      '2026-11-01 01:30:00',
    );
  });

  it.each([
    ['2023-6-5', 'date', '2023-06-05'],
    ['2023/06/05', 'date', '2023-06-05'],
    ['2023-06-05 14:30', 'datetime', '2023-06-05T07:30:00.000Z'],
    ['2023-06-05T14:30:15.5', 'datetime', '2023-06-05T07:30:15.500Z'],
    ['2023-06-05T14:30:15.123456', 'datetime', '2023-06-05T07:30:15.123Z'],
    ['2023-06-05 14:30Z', 'datetime', '2023-06-05T14:30:00.000Z'],
    ['2023-06-05 14:30-02', 'datetime', '2023-06-05T16:30:00.000Z'],
    ['2023-06-05T00:00:00+07:00', 'datetime', '2023-06-04T17:00:00.000Z'],
    ['2024-02-29', 'date', '2024-02-29'],
  ])('parses %s as a %s', (text, kind, expected) => {
    const parsed = parseDateText(text, 'Asia/Ho_Chi_Minh');
    expect(parsed?.kind).toBe(kind);
    if (parsed?.kind === 'date') expect(isoDate(parsed.day)).toBe(expected);
    if (parsed?.kind === 'datetime') expect(isoInstant(parsed.ms)).toBe(expected);
  });

  it.each([
    ['2023-13-01'],
    ['2023-02-29'],
    ['0000-01-01'],
    ['2023-01-01 25:00'],
    ['2023-01-01 10:60'],
    ['2023-01-01 10:00:60'],
    ['2023-01-01 10:00+24:00'],
    ['01/02/2023'],
    ['2023-01-01 10'],
    [''],
  ])('rejects %j', (text) => {
    expect(parseDateText(text, 'UTC')).toBeNull();
  });
});

describe('calendar functions', () => {
  it.each([
    ['2000-01-01', '2000-01-08', 'D', 7],
    ['2000-01-31', '2000-03-01', 'M', 1],
    ['2000-02-29', '2001-02-28', 'Y', 0],
    ['2000-02-29', '2004-02-29', 'Y', 4],
    ['2000-01-15', '2001-03-10', 'YM', 1],
    ['2000-01-15', '2001-03-10', 'MD', 23],
    ['2000-01-15', '2001-03-10', 'YD', 54],
    ['2000-01-31', '2000-03-01', 'MD', 1],
    ['2000-01-01', '2000-01-01', 'D', 0],
    ['2000-01-01', '2001-01-01', 'd', 366],
  ])('DATEDIF(%s, %s, %s) = %d', (start, end, unit, expected) => {
    expect(datedif(day(start), day(end), unit)).toBe(expected);
  });

  it('DATEDIF is empty for a reversed range or an unknown unit', () => {
    expect(datedif(day('2001-01-01'), day('2000-01-01'), 'D')).toBeNull();
    expect(datedif(day('2000-01-01'), day('2001-01-01'), 'W')).toBeNull();
  });

  it.each([
    ['2000-01-01', 1, 7],
    ['2000-01-01', 2, 6],
    ['2026-09-28', 1, 2],
    ['2026-09-28', 2, 1],
    ['2026-09-27', 2, 7],
  ])('WEEKDAY(%s, %d) = %d', (date, type, expected) => {
    expect(weekday(day(date), type)).toBe(expected);
  });

  it.each([
    ['2000-01-01', 1, 1],
    ['2000-01-02', 1, 2],
    ['2000-01-02', 2, 1],
    ['2000-01-03', 2, 2],
    ['2026-12-31', 1, 53],
    ['2026-12-31', 2, 53],
    ['2023-01-01', 2, 1],
    ['2023-01-02', 2, 2],
  ])('WEEKNUM(%s, %d) = %d', (date, type, expected) => {
    expect(weeknum(day(date), type)).toBe(expected);
  });

  it('WEEKDAY/WEEKNUM reject other types', () => {
    expect(weekday(0, 3)).toBeNull();
    expect(weeknum(0, 11)).toBeNull();
  });

  /** Brute-force oracles: step one day at a time. */
  const weekend = (n: number) => [0, 6].includes((((n + 4) % 7) + 7) % 7);
  function slowWorkday(start: number, days: number, holidays: readonly number[]): number {
    const skip = new Set(holidays);
    let current = start;
    let left = Math.abs(days);
    while (left > 0) {
      current += Math.sign(days);
      if (!weekend(current) && !skip.has(current)) left -= 1;
    }
    return current;
  }
  function slowNetworkdays(start: number, end: number, holidays: readonly number[]): number {
    const skip = new Set(holidays);
    let count = 0;
    for (let n = Math.min(start, end); n <= Math.max(start, end); n += 1) {
      if (!weekend(n) && !skip.has(n)) count += 1;
    }
    return start <= end ? count : -count;
  }

  it('WORKDAY and NETWORKDAYS agree with day-by-day counting', () => {
    let seed = 451;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const base = day('2026-01-01');
    for (let i = 0; i < 400; i += 1) {
      const start = base + Math.floor(random() * 60) - 30;
      const days = Math.floor(random() * 80) - 40;
      const holidays = Array.from({ length: Math.floor(random() * 8) }, () =>
        Math.floor(base + random() * 120 - 60),
      );
      expect(workday(start, days, holidays)).toBe(
        days === 0 ? start : slowWorkday(start, days, holidays),
      );
      const end = start + Math.floor(random() * 90) - 45;
      expect(networkdays(start, end, holidays)).toBe(slowNetworkdays(start, end, holidays));
    }
  });

  it('WORKDAY stays within years 1–9999', () => {
    expect(workday(day('9999-12-30'), 5, [])).toBeNull();
    expect(workday(day('2000-01-01'), 5_000_000, [])).toBeNull();
  });

  it('formats dates with fixed tokens', () => {
    const wall = { year: 7, month: 3, day: 5, hour: 7, minute: 8, second: 9 };
    expect(formatDate('YYYY-MM-DD HH:mm:ss', wall)).toBe('0007-03-05 07:08:09');
    expect(formatDate('YY/M/D H giờ', wall)).toBe('07/3/5 7 giờ');
    // Tokens are case-insensitive (T473); a lone y is not a token.
    expect(formatDate('ngày DD, yyyy dd', wall)).toBe('ngày 05, 0007 05');
  });
});
