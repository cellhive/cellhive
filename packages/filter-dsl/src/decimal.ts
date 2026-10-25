/**
 * Exact comparison of decimal numbers, so that the evaluator orders `numeric`
 * values the way PostgreSQL does even when they do not fit a double
 * (`numeric` columns reach the app as strings, SPEC §5.5).
 *
 * A finite value is `sign × 0.digits × 10^exponent` with no leading or
 * trailing zero in `digits`; zero has `sign = 0`. PostgreSQL also stores
 * `NaN` and `±Infinity` in `numeric` and orders them
 * `-Infinity < finite < Infinity < NaN` (and `NaN = NaN`).
 */
export type Decimal =
  | {
      readonly kind: 'finite';
      readonly sign: -1 | 0 | 1;
      readonly digits: string;
      readonly exponent: number;
    }
  | { readonly kind: 'special'; readonly rank: -2 | 2 | 3 };

const DECIMAL_TEXT = /^\s*([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?\s*$/i;
const SPECIAL: Readonly<Record<string, Decimal>> = {
  nan: { kind: 'special', rank: 3 },
  infinity: { kind: 'special', rank: 2 },
  '+infinity': { kind: 'special', rank: 2 },
  inf: { kind: 'special', rank: 2 },
  '+inf': { kind: 'special', rank: 2 },
  '-infinity': { kind: 'special', rank: -2 },
  '-inf': { kind: 'special', rank: -2 },
};

/**
 * Parses a JS number or a decimal string (`numeric` text output, or input
 * such as `1e-7`); `null` for anything else (including non-finite numbers,
 * which PostgreSQL cannot receive as a parameter from a JS number anyway).
 */
export function parseDecimal(value: unknown): Decimal | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'bigint') {
    text = value.toString();
  } else {
    return null;
  }
  const special = SPECIAL[text.trim().toLowerCase()];
  if (special !== undefined) return special;
  const match = DECIMAL_TEXT.exec(text);
  if (match === null) return null;
  const [, signText, intPart, fracPart, fracOnly, expText] = match;
  const integer = intPart ?? '';
  const fraction = fracPart ?? fracOnly ?? '';
  const all = integer + fraction;
  const firstNonZero = all.search(/[1-9]/);
  if (firstNonZero === -1) return { kind: 'finite', sign: 0, digits: '', exponent: 0 };
  const digits = all.slice(firstNonZero).replace(/0+$/, '');
  const exponent = integer.length - firstNonZero + Number(expText ?? '0');
  return { kind: 'finite', sign: signText === '-' ? -1 : 1, digits, exponent };
}

const rankOf = (value: Decimal): number => (value.kind === 'special' ? value.rank : 0);

/** `-1`, `0` or `1` as `a` is less than, equal to or greater than `b`. */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const rankA = rankOf(a);
  const rankB = rankOf(b);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;
  if (a.kind === 'special' || b.kind === 'special') return 0;
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
  if (a.sign === 0) return 0;
  let magnitude: -1 | 0 | 1;
  if (a.exponent !== b.exponent) {
    magnitude = a.exponent < b.exponent ? -1 : 1;
  } else {
    const length = Math.max(a.digits.length, b.digits.length);
    const left = a.digits.padEnd(length, '0');
    const right = b.digits.padEnd(length, '0');
    magnitude = left === right ? 0 : left < right ? -1 : 1;
  }
  return a.sign === 1 ? magnitude : ((-magnitude || 0) as -1 | 0 | 1);
}
