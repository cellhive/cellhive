import { toWallTime, type WallTime } from '../time-zone.js';

const MAX_EPOCH_MS = 8.64e15;

export function isValidEpochMs(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_EPOCH_MS;
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/** Range-checks calendar and clock fields (month 1–12, day within month, 00:00–23:59:59). */
export function isValidWallTime(wall: WallTime): boolean {
  return (
    wall.month >= 1 &&
    wall.month <= 12 &&
    wall.day >= 1 &&
    wall.day <= daysInMonth(wall.year, wall.month) &&
    wall.hour <= 23 &&
    wall.minute <= 59 &&
    wall.second <= 59
  );
}

function wallOf(
  year: string,
  month: string,
  day: string,
  hour = '0',
  minute = '0',
  second = '0',
  fraction = '',
): WallTime | null {
  const wall: WallTime = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(fraction.slice(0, 3).padEnd(3, '0')),
  };
  return isValidWallTime(wall) ? wall : null;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** `YYYY-MM-DD` of a wall time. */
export function isoDateOf(wall: WallTime): string {
  return `${String(wall.year).padStart(4, '0')}-${pad2(wall.month)}-${pad2(wall.day)}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a strict `YYYY-MM-DD` calendar date. */
export function parseIsoDate(text: string): WallTime | null {
  const match = ISO_DATE.exec(text);
  if (match === null) return null;
  const [, year = '', month = '', day = ''] = match;
  return wallOf(year, month, day);
}

// `2026-09-25T09:00:00.000+07:00`, `2026-09-25 02:00:00+00` (PostgreSQL text), `…Z`.
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-])(\d{2})(?::?(\d{2}))?)$/i;

/** Parses an ISO 8601 date-time that carries `Z` or a numeric offset; returns epoch ms. */
export function parseIsoInstant(text: string): number | null {
  const match = ISO_INSTANT.exec(text);
  if (match === null) return null;
  const [, y = '', mo = '', d = '', h = '', mi = '', s, fraction, zulu, sign, oh = '', om] = match;
  const wall = wallOf(y, mo, d, h, mi, s, fraction);
  if (wall === null) return null;
  const offsetMinutes =
    zulu === undefined ? (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om ?? '0')) : 0;
  const utc = new Date(0);
  utc.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  utc.setUTCHours(wall.hour, wall.minute, wall.second, wall.millisecond);
  const epoch = utc.getTime() - offsetMinutes * 60_000;
  return isValidEpochMs(epoch) ? epoch : null;
}

/** A free-text date parsed by typecast: an absolute instant, or a wall time in the field zone. */
export type ParsedDateText =
  | { readonly kind: 'instant'; readonly epochMs: number }
  | { readonly kind: 'wall'; readonly wall: WallTime };

const TIME = String.raw`(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?`;
const YEAR_FIRST = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})${TIME}$`);
const YEAR_LAST = new RegExp(String.raw`^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})${TIME}$`);

const monthFirstCache = new Map<string, boolean>();

/** Whether the locale writes numeric dates month-first (en-US) rather than day-first (vi, en-GB). */
export function isMonthFirstLocale(locale: string): boolean {
  let monthFirst = monthFirstCache.get(locale);
  if (monthFirst === undefined) {
    const order = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    })
      .formatToParts(0)
      .map((part) => part.type);
    monthFirst = order.indexOf('month') < order.indexOf('day');
    monthFirstCache.set(locale, monthFirst);
  }
  return monthFirst;
}

/**
 * Parses the free-text forms accepted by `typecast=true` (CONTRACTS §2, §4.1):
 * ISO 8601 with offset, ISO local `yyyy-MM-dd[ HH:mm[:ss]]`, and
 * `dd/MM/yyyy[ HH:mm[:ss]]` or `MM/dd/yyyy[ …]` depending on the locale's
 * numeric date order. `/`, `-` and `.` are accepted as date separators.
 */
export function parseDateText(text: string, locale: string): ParsedDateText | null {
  const instant = parseIsoInstant(text);
  if (instant !== null) return { kind: 'instant', epochMs: instant };

  const yearFirst = YEAR_FIRST.exec(text);
  if (yearFirst !== null) {
    const [, y = '', mo = '', d = '', h, mi, s, fraction] = yearFirst;
    const wall = wallOf(y, mo, d, h, mi, s, fraction);
    return wall === null ? null : { kind: 'wall', wall };
  }

  const yearLast = YEAR_LAST.exec(text);
  if (yearLast !== null) {
    const [, first = '', second = '', y = '', h, mi, s, fraction] = yearLast;
    const [mo, d] = isMonthFirstLocale(locale) ? [first, second] : [second, first];
    const wall = wallOf(y, mo, d, h, mi, s, fraction);
    return wall === null ? null : { kind: 'wall', wall };
  }
  return null;
}

/** Tokens of the fixed display formats (SPEC §5.5 `style.format`, auto_number `date_format`). */
const FORMAT_TOKENS = /yyyy|yy|MM|dd|HH|mm/g;

/** Renders a wall time with a fixed pattern made of `yyyy yy MM dd HH mm` and literals. */
export function formatWallTime(wall: WallTime, pattern: string): string {
  return pattern.replace(FORMAT_TOKENS, (token) => {
    switch (token) {
      case 'yyyy':
        return String(wall.year).padStart(4, '0');
      case 'yy':
        return pad2(wall.year % 100);
      case 'MM':
        return pad2(wall.month);
      case 'dd':
        return pad2(wall.day);
      case 'HH':
        return pad2(wall.hour);
      default:
        return pad2(wall.minute);
    }
  });
}

/** Normalizes a stored timestamp (`Date` from the driver, or text) to epoch ms. */
export function storedInstant(stored: unknown): number | null {
  if (stored instanceof Date) {
    const epoch = stored.getTime();
    return Number.isNaN(epoch) ? null : epoch;
  }
  if (typeof stored === 'string') return parseIsoInstant(stored);
  return null;
}

/** `YYYY-MM-DD` of an instant as seen in `timeZone`. */
export function isoDateInZone(epochMs: number, timeZone: string): string {
  return isoDateOf(toWallTime(epochMs, timeZone));
}
