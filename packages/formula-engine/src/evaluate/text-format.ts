import { daysFromCivil, weekdayOf } from './dates.js';
import { Dec } from './decimal.js';

import type { WallTime } from '@cellhive/field-types';

/**
 * `TEXT(value, pattern)` after Lark (BACKLOG T473, SPEC §9.4): fixed,
 * locale-free patterns, the same rules as `fx.text_number` / `fx.text_date`
 * (migration 0023). Pattern letters are matched ASCII-only, so no locale
 * case rule (`ı`, `ſ`) can turn a character into a token.
 */

// ---------------------------------------------------------------------------
// Numbers

/**
 * `[#0,]…[.[#0]…][%]`: in the integer part (≤ 40 characters) each `0` is a
 * minimum digit, `#` an optional one and a `,` between placeholders groups
 * thousands; after `.` (≤ 20 placeholders) the number is rounded to as many
 * decimals as placeholders, trailing zeros dropped down to the last `0`;
 * `%` multiplies by 100. Halves round away from zero. Like Excel, a zero
 * integer part without a `0` placeholder is omitted (`TEXT(0.5, "#.##")` →
 * `.5`) and the point stays even with no decimal shown (`TEXT(23, "##.##")` →
 * `23.`). Any other pattern (literal text, trailing `,`, several `%`…) →
 * `null`.
 */
const NUMBER_PATTERN = /^([#0,]{0,40})(?:(\.)([#0]{0,20}))?(%?)$/;

export function formatNumber(value: Dec, pattern: string): string | null {
  const match = NUMBER_PATTERN.exec(pattern);
  if (match === null) return null;
  const integerPattern = match[1] ?? '';
  const point = match[2] !== undefined;
  const fractionPattern = match[3] ?? '';
  const percent = match[4] === '%';
  if (`${integerPattern}${fractionPattern}`.replaceAll(',', '') === '') return null;
  if (integerPattern.startsWith(',') || integerPattern.endsWith(',')) return null;
  const decimals = fractionPattern.length;
  const minDecimals = fractionPattern.lastIndexOf('0') + 1;
  const minInteger = integerPattern.replaceAll(/[^0]/g, '').length;

  const rounded = (percent ? value.mul(Dec.of(100n)) : value).round(decimals, 'half');
  const negative = rounded.sign < 0;
  const digits = (negative ? -rounded.coef : rounded.coef).toString().padStart(decimals + 1, '0');
  let integer = digits.slice(0, digits.length - decimals);
  let fraction = digits.slice(digits.length - decimals);
  while (fraction.length > minDecimals && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  if (integer === '0') integer = '';
  integer = integer.padStart(minInteger, '0');
  if (integerPattern.includes(',')) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${integer}${point ? `.${fraction}` : ''}${percent ? '%' : ''}`;
}

// ---------------------------------------------------------------------------
// Dates

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type DateToken =
  'Y4' | 'Y2' | 'M4' | 'M3' | 'M2' | 'M1' | 'D4' | 'D3' | 'D2' | 'D1' | 'H2' | 'H1' | 'S2';

/** Tokens by first letter, longest first. */
const TOKENS: readonly [string, DateToken][] = [
  ['YYYY', 'Y4'],
  ['YY', 'Y2'],
  ['MMMM', 'M4'],
  ['MMM', 'M3'],
  ['MM', 'M2'],
  ['M', 'M1'],
  ['DDDD', 'D4'],
  ['DDD', 'D3'],
  ['DD', 'D2'],
  ['D', 'D1'],
  ['HH', 'H2'],
  ['H', 'H1'],
  ['SS', 'S2'],
];

/** `[h]`, `[mm]`, `[ss]`… (elapsed time): Phase 2. */
const ELAPSED = /\[[HMS]+\]/;

/** Upper case of ASCII letters only (`upper(fmt COLLATE "C")`). */
const asciiUpper = (text: string): string =>
  text.replace(/[a-z]/g, (letter) => letter.toUpperCase());

/**
 * Whether a `TEXT` pattern formats a date or time (M4): it holds a Y, M, D,
 * H or S letter — the first letters of the tokens `formatDate` matches, and
 * the same test `fx.text_text` makes on the SQL side (`[YMDHS]` after the
 * `C`-collation upper). A pattern without one is a number pattern or plain
 * text: a text value passes through unchanged.
 */
export function hasDateToken(pattern: string): boolean {
  return /[YMDHS]/u.test(asciiUpper(pattern));
}

type Piece = { token: DateToken } | { literal: string };

/**
 * Fixed date pattern, letters case-insensitive: `YYYY`, `YY`, `MMMM`
 * (January), `MMM` (Jan), `MM`, `M`, `DDDD` (Friday), `DDD` (Fri), `DD`, `D`,
 * `HH`/`H` (24-hour), `SS`; `MM`/`M` right after an hour token or right
 * before `SS` (other characters in between allowed) are minutes, as in
 * Excel. English names, never the locale. Any other character is copied.
 * `[h]` and other elapsed-time brackets → `null` (Phase 2).
 */
export function formatDate(pattern: string, wall: Omit<WallTime, 'millisecond'>): string | null {
  const upper = asciiUpper(pattern);
  if (ELAPSED.test(upper)) return null;
  const pieces: Piece[] = [];
  for (let i = 0; i < pattern.length;) {
    const found = TOKENS.find(([text]) => upper.startsWith(text, i));
    if (found === undefined) {
      pieces.push({ literal: pattern.charAt(i) });
      i += 1;
    } else {
      pieces.push({ token: found[1] });
      i += found[0].length;
    }
  }
  const tokenAt = (from: number, step: 1 | -1): DateToken | null => {
    for (let j = from; j >= 0 && j < pieces.length; j += step) {
      const piece = pieces[j];
      if (piece !== undefined && 'token' in piece) return piece.token;
    }
    return null;
  };
  const weekday = weekdayOf(daysFromCivil(wall.year, wall.month, wall.day));
  let out = '';
  pieces.forEach((piece, index) => {
    if ('literal' in piece) {
      out += piece.literal;
      return;
    }
    const { token } = piece;
    if (token === 'M1' || token === 'M2') {
      const previous = tokenAt(index - 1, -1);
      if (previous === 'H1' || previous === 'H2' || tokenAt(index + 1, 1) === 'S2') {
        out += token === 'M2' ? pad(wall.minute) : String(wall.minute);
        return;
      }
    }
    out += datePart(token, wall, weekday);
  });
  return out;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

function datePart(token: DateToken, wall: Omit<WallTime, 'millisecond'>, weekday: number): string {
  switch (token) {
    case 'Y4':
      return pad(wall.year, 4);
    case 'Y2':
      return pad(wall.year % 100);
    case 'M4':
      return MONTHS[wall.month - 1] ?? '';
    case 'M3':
      return (MONTHS[wall.month - 1] ?? '').slice(0, 3);
    case 'M2':
      return pad(wall.month);
    case 'M1':
      return String(wall.month);
    case 'D4':
      return WEEKDAYS[weekday] ?? '';
    case 'D3':
      return (WEEKDAYS[weekday] ?? '').slice(0, 3);
    case 'D2':
      return pad(wall.day);
    case 'D1':
      return String(wall.day);
    case 'H2':
      return pad(wall.hour);
    case 'H1':
      return String(wall.hour);
    case 'S2':
      return pad(wall.second);
  }
}
