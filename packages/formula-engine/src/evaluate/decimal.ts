import { parseDecimal } from '@cellhive/filter-dsl';

/**
 * Exact decimal numbers for the TS evaluator (T453), behaving like
 * PostgreSQL `numeric` so that the evaluator and the SQL compiler (T454)
 * agree digit for digit:
 *
 * - a value is `coef × 10^-scale` with `scale ≥ 0`; `scale` is the
 *   `numeric` display scale (`dscale`): `1.50` keeps scale 2;
 * - `+`, `-`, `*` are exact (scale = max / sum of the scales);
 * - `/` rounds half away from zero at PostgreSQL's `select_div_scale`
 *   (at least 16 significant digits, at least the scales of the operands);
 * - `sqrt` rounds at PostgreSQL's `numeric_sqrt` scale;
 * - `NaN`/`±Infinity` are not values (they read as `null`).
 *
 * Parsing reuses `parseDecimal` of `@cellhive/filter-dsl` (the grammar of
 * PostgreSQL `numeric` input).
 */

const POW10: bigint[] = [1n];

export function pow10(exponent: number): bigint {
  for (let index = POW10.length; index <= exponent; index += 1) {
    POW10.push((POW10[index - 1] as bigint) * 10n);
  }
  return POW10[exponent] as bigint;
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

/** Integer division rounding half away from zero. */
function divHalfAway(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = abs(numerator);
  const d = abs(denominator);
  let quotient = n / d;
  if ((n % d) * 2n >= d) quotient += 1n;
  return negative ? -quotient : quotient;
}

/** Integer division rounding toward negative infinity. */
function divFloor(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder !== 0n && remainder < 0n !== denominator < 0n ? quotient - 1n : quotient;
}

/** PostgreSQL limits (`numeric.c`). */
const NUMERIC_MIN_SIG_DIGITS = 16;
const NUMERIC_MAX_DISPLAY_SCALE = 1000;
const DEC_DIGITS = 4;
/** Largest number of digits a result may have before it counts as an overflow (`null`). */
const MAX_DIGITS = 131_072;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const TEXT_SCALE = /^\s*[+-]?(?:\d+(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?\s*$/i;

export type RoundMode = 'half' | 'up' | 'down' | 'floor' | 'ceil';

export class Dec {
  static readonly ZERO = new Dec(0n, 0);
  static readonly ONE = new Dec(1n, 0);

  private constructor(
    readonly coef: bigint,
    readonly scale: number,
  ) {}

  static of(coef: bigint, scale = 0): Dec {
    return new Dec(coef, scale);
  }

  static int(value: number): Dec {
    return new Dec(BigInt(Math.trunc(value)), 0);
  }

  /**
   * A JS number, bigint or decimal text (`numeric` text output, `1e-7`,
   * ` 12 `); `null` for anything else, `NaN` and infinities included.
   */
  static parse(value: unknown): Dec | null {
    if (value instanceof Dec) return value;
    if (typeof value === 'bigint') return new Dec(value, 0);
    let text: string;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      text = String(value);
    } else if (typeof value === 'string') {
      text = value;
    } else {
      return null;
    }
    const parsed = parseDecimal(text);
    if (parsed === null || parsed.kind === 'special') return null;
    const match = TEXT_SCALE.exec(text);
    if (match === null) return null;
    const fraction = (match[1] ?? match[2] ?? '').length;
    const exponent = Number(match[3] ?? '0');
    const dscale = Math.max(0, fraction - exponent);
    if (parsed.sign === 0) return new Dec(0n, Math.min(dscale, NUMERIC_MAX_DISPLAY_SCALE));
    // value = ±0.digits × 10^exponent = ±digits × 10^(exponent - digits.length)
    const minScale = parsed.digits.length - parsed.exponent;
    if (Math.abs(minScale) > MAX_DIGITS) return null;
    const scale = Math.max(minScale, dscale, 0);
    const coef = BigInt(parsed.digits) * pow10(scale - minScale);
    return new Dec(parsed.sign < 0 ? -coef : coef, scale);
  }

  /** A double result of a transcendental function, to 15 significant digits (`float8` precision). */
  static fromDouble(value: number): Dec | null {
    if (!Number.isFinite(value)) return null;
    return Dec.parse(value.toPrecision(15));
  }

  get sign(): -1 | 0 | 1 {
    return this.coef === 0n ? 0 : this.coef < 0n ? -1 : 1;
  }

  isZero(): boolean {
    return this.coef === 0n;
  }

  isInteger(): boolean {
    return this.coef % pow10(this.scale) === 0n;
  }

  neg(): Dec {
    return new Dec(-this.coef, this.scale);
  }

  abs(): Dec {
    return this.coef < 0n ? this.neg() : this;
  }

  /** Coefficients of both at their common scale. */
  private static align(a: Dec, b: Dec): [bigint, bigint, number] {
    if (a.scale === b.scale) return [a.coef, b.coef, a.scale];
    if (a.scale > b.scale) return [a.coef, b.coef * pow10(a.scale - b.scale), a.scale];
    return [a.coef * pow10(b.scale - a.scale), b.coef, b.scale];
  }

  add(other: Dec): Dec {
    const [a, b, scale] = Dec.align(this, other);
    return new Dec(a + b, scale);
  }

  sub(other: Dec): Dec {
    const [a, b, scale] = Dec.align(this, other);
    return new Dec(a - b, scale);
  }

  mul(other: Dec): Dec {
    return new Dec(this.coef * other.coef, this.scale + other.scale);
  }

  cmp(other: Dec): -1 | 0 | 1 {
    let a = this.coef;
    let b = other.coef;
    if (this.scale > other.scale) b *= pow10(this.scale - other.scale);
    else if (this.scale < other.scale) a *= pow10(other.scale - this.scale);
    return a === b ? 0 : a < b ? -1 : 1;
  }

  eq(other: Dec): boolean {
    return this.cmp(other) === 0;
  }

  /** Number of decimal digits of the coefficient. */
  private digitCount(): number {
    return this.coef === 0n ? 1 : abs(this.coef).toString().length;
  }

  /** `numeric` base-10000 weight and first base-10000 digit (`select_div_scale`). */
  private baseWeight(): [number, bigint] {
    if (this.coef === 0n) return [0, 0n];
    const magnitude = abs(this.coef);
    const exponent = magnitude.toString().length - 1 - this.scale;
    const weight = Math.floor(exponent / DEC_DIGITS);
    const shift = this.scale + weight * DEC_DIGITS;
    const first = shift >= 0 ? magnitude / pow10(shift) : magnitude * pow10(-shift);
    return [weight, first];
  }

  /** Result scale of `this / other` in PostgreSQL (`select_div_scale`). */
  private divScale(other: Dec): number {
    const [weight1, first1] = this.baseWeight();
    const [weight2, first2] = other.baseWeight();
    let qweight = weight1 - weight2;
    if (first1 <= first2) qweight -= 1;
    let scale = NUMERIC_MIN_SIG_DIGITS - qweight * DEC_DIGITS;
    scale = Math.max(scale, this.scale, other.scale, 0);
    return Math.min(scale, NUMERIC_MAX_DISPLAY_SCALE);
  }

  /** `this / other` rounded like PostgreSQL `numeric / numeric`; `null` for a zero divisor. */
  div(other: Dec): Dec | null {
    if (other.isZero()) return null;
    return this.divAt(other, this.divScale(other));
  }

  /** `this / other` rounded half away from zero at `scale` decimals. */
  divAt(other: Dec, scale: number): Dec {
    // (a / 10^sa) / (b / 10^sb) × 10^scale = a × 10^(sb + scale) / (b × 10^sa)
    const numerator = this.coef * pow10(other.scale + scale);
    const denominator = other.coef * pow10(this.scale);
    return new Dec(divHalfAway(numerator, denominator), scale);
  }

  /** `floor(this / other)` as an integer; `other` must not be zero. */
  floorDiv(other: Dec): bigint {
    return divFloor(this.coef * pow10(other.scale), other.coef * pow10(this.scale));
  }

  /** `trunc(this / other)` as an integer; `other` must not be zero. */
  truncDiv(other: Dec): bigint {
    return (this.coef * pow10(other.scale)) / (other.coef * pow10(this.scale));
  }

  /**
   * Rounds to `places` decimals (negative: left of the point). `half`
   * rounds halves away from zero (PostgreSQL `round`), `up` away from
   * zero, `down` toward zero (`trunc`), `floor`/`ceil` toward ∓∞.
   */
  round(places: number, mode: RoundMode = 'half'): Dec {
    if (places >= this.scale) return new Dec(this.coef * pow10(places - this.scale), places);
    const factor = pow10(this.scale - places);
    let quotient = this.coef / factor;
    const remainder = this.coef % factor;
    if (remainder !== 0n) {
      const away = this.coef < 0n ? -1n : 1n;
      switch (mode) {
        case 'half':
          if (abs(remainder) * 2n >= factor) quotient += away;
          break;
        case 'up':
          quotient += away;
          break;
        case 'down':
          break;
        case 'floor':
          if (this.coef < 0n) quotient -= 1n;
          break;
        case 'ceil':
          if (this.coef > 0n) quotient += 1n;
          break;
      }
    }
    return places >= 0 ? new Dec(quotient, places) : new Dec(quotient * pow10(-places), 0);
  }

  /** Square root rounded like PostgreSQL `sqrt(numeric)`; `null` for a negative number. */
  sqrt(): Dec | null {
    if (this.coef < 0n) return null;
    const [weight] = this.baseWeight();
    const sweight = ((weight + 1) * DEC_DIGITS) / 2 - 1;
    let scale = NUMERIC_MIN_SIG_DIGITS - Math.trunc(sweight);
    scale = Math.min(Math.max(scale, this.scale, 0), NUMERIC_MAX_DISPLAY_SCALE);
    return this.sqrtAt(scale);
  }

  /** Square root rounded half up at `scale` decimals (non-negative values). */
  sqrtAt(scale: number): Dec {
    // sqrt(c × 10^-s) × 10^(scale + 1) = sqrt(c × 10^(2 × (scale + 1) - s))
    let exponent = 2 * (scale + 1) - this.scale;
    let extra = 0;
    if (exponent < 0) {
      extra = Math.ceil(-exponent / 2);
      exponent += 2 * extra;
    }
    const root = isqrt(this.coef * pow10(exponent));
    // `root` is floor(sqrt(value) × 10^(scale + 1 + extra)).
    const rounded = divHalfAway(root, pow10(1 + extra));
    return new Dec(rounded, scale);
  }

  /** Integer power (exact); `null` when the result would be too large. */
  powInt(exponent: number): Dec | null {
    if (exponent < 0) {
      if (this.isZero()) return null;
      const positive = this.powInt(-exponent);
      return positive === null ? null : Dec.ONE.div(positive);
    }
    if (this.digitCount() * exponent > MAX_DIGITS) {
      // |base| ≤ 1 stays small; anything else overflows.
      if (this.abs().cmp(Dec.ONE) > 0) return null;
    }
    if (this.scale * exponent > MAX_DIGITS) return null;
    return new Dec(this.coef ** BigInt(exponent), this.scale * exponent);
  }

  /** log10 of the absolute value (`-Infinity` for zero), from the digits: no double overflow. */
  log10Abs(): number {
    if (this.coef === 0n) return Number.NEGATIVE_INFINITY;
    const digits = abs(this.coef).toString();
    const lead = Number(`${digits.slice(0, 1)}.${digits.slice(1, 17) || '0'}`);
    return Math.log10(lead) + digits.length - 1 - this.scale;
  }

  /**
   * `10^exponent` for a double exponent, as a decimal of 15 significant
   * digits (EXP, non-integer POWER beyond the double range).
   */
  static pow10Double(exponent: number): Dec | null {
    if (!Number.isFinite(exponent)) return null;
    const whole = Math.floor(exponent);
    const mantissa = Dec.fromDouble(10 ** (exponent - whole));
    if (mantissa === null) return null;
    if (whole >= mantissa.scale) {
      return new Dec(mantissa.coef * pow10(whole - mantissa.scale), 0);
    }
    return new Dec(mantissa.coef, mantissa.scale - whole);
  }

  /** Nearest JS number. */
  toNumber(): number {
    return Number(this.toString());
  }

  /** Integer part as a JS number (toward zero), or `null` beyond ±2^53. */
  toInt(): number | null {
    const value = this.scale === 0 ? this.coef : this.coef / pow10(this.scale);
    return value > MAX_SAFE || value < -MAX_SAFE ? null : Number(value);
  }

  /** Shortest exact decimal text: no exponent, no trailing zeros (`1.50` → `1.5`). */
  toString(): string {
    if (this.coef === 0n) return '0';
    const negative = this.coef < 0n;
    let digits = abs(this.coef).toString();
    let scale = this.scale;
    while (scale > 0 && digits.endsWith('0')) {
      digits = digits.slice(0, -1);
      scale -= 1;
    }
    let text: string;
    if (scale === 0) text = digits;
    else if (digits.length > scale) {
      text = `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
    } else {
      text = `0.${'0'.repeat(scale - digits.length)}${digits}`;
    }
    return negative ? `-${text}` : text;
  }
}

/** floor(sqrt(n)) for n ≥ 0 (Newton's method on bigint). */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  // Start above the root; Newton's steps then decrease to the floor.
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
