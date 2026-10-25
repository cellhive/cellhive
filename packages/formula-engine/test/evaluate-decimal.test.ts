import { describe, expect, it } from 'vitest';

import { Dec } from '../src/evaluate/decimal.js';

const d = (text: string): Dec => {
  const value = Dec.parse(text);
  if (value === null) throw new Error(`not a decimal: ${text}`);
  return value;
};

describe('Dec.parse (PostgreSQL numeric input, scale kept)', () => {
  it.each([
    ['0', '0', 0],
    ['1.50', '1.5', 2],
    ['-0.0', '0', 1],
    [' 12 ', '12', 0],
    ['+7', '7', 0],
    ['.5', '0.5', 1],
    ['1e3', '1000', 0],
    ['1.5e1', '15', 0],
    ['1e-3', '0.001', 3],
    ['1.25E-2', '0.0125', 4],
    ['000123.4500', '123.45', 4],
  ])('%s → %s (scale %d)', (text, canonical, scale) => {
    const value = d(text);
    expect(value.toString()).toBe(canonical);
    expect(value.scale).toBe(scale);
  });

  it.each([['abc'], [''], ['1,5'], ['NaN'], ['Infinity'], ['-inf'], ['1e'], ['--1']])(
    'rejects %j',
    (text) => {
      expect(Dec.parse(text)).toBeNull();
    },
  );

  it.each([
    [0.1, '0.1'],
    [1e21, '1000000000000000000000'],
    [1e-7, '0.0000001'],
    [-2.5, '-2.5'],
    [12n, '12'],
  ])('reads the JS value %s', (value, expected) => {
    expect(Dec.parse(value)?.toString()).toBe(expected);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [null], [undefined], [true], [{}]])(
    'rejects %s',
    (value) => {
      expect(Dec.parse(value)).toBeNull();
    },
  );

  it('rejects absurd exponents', () => {
    expect(Dec.parse('1e999999')).toBeNull();
  });

  it('reads doubles to 15 significant digits', () => {
    expect(Dec.fromDouble(Math.log(8) / Math.log(2))?.toString()).toBe('3');
    expect(Dec.fromDouble(Math.PI)?.toString()).toBe('3.14159265358979');
    expect(Dec.fromDouble(1e300 * 1e10)).toBeNull();
  });
});

describe('Dec arithmetic', () => {
  it.each([
    ['0.1', '0.2', 'add', '0.3'],
    ['1.50', '2', 'add', '3.5'],
    ['1', '0.001', 'sub', '0.999'],
    ['-1.5', '-1.5', 'sub', '0'],
    ['1.5', '1.5', 'mul', '2.25'],
    ['-0.5', '4', 'mul', '-2'],
  ] as const)('%s %s %s = %s', (a, b, op, expected) => {
    expect(d(a)[op](d(b)).toString()).toBe(expected);
  });

  it('keeps PostgreSQL scales: max for + and -, sum for *', () => {
    expect(d('1.50').add(d('2.125')).scale).toBe(3);
    expect(d('1.50').mul(d('2.125')).scale).toBe(5);
  });

  it.each([
    // select_div_scale: at least 16 significant digits, at least the operand scales.
    ['1', '3', '0.33333333333333333333'],
    ['2', '3', '0.66666666666666666667'],
    ['10', '3', '3.3333333333333333'],
    ['1', '7', '0.14285714285714285714'],
    ['100', '7', '14.2857142857142857'],
    ['1', '30000', '0.000033333333333333333333'],
    ['2', '1', '2'],
    ['-1', '3', '-0.33333333333333333333'],
    ['1', '-3', '-0.33333333333333333333'],
    ['1.0000000000000000000000000', '3', '0.3333333333333333333333333'],
    ['0', '5', '0'],
    ['123456789', '0.001', '123456789000'],
  ])('%s / %s = %s', (a, b, expected) => {
    expect(d(a).div(d(b))?.toString()).toBe(expected);
  });

  it('divides by zero into null', () => {
    expect(d('1').div(Dec.ZERO)).toBeNull();
  });

  it.each([
    ['7', '2', 3n, 3n],
    ['-7', '2', -4n, -3n],
    ['7', '-2', -4n, -3n],
    ['-7', '-2', 3n, 3n],
    ['5.5', '0.5', 11n, 11n],
    ['6', '2', 3n, 3n],
  ])('floor/trunc of %s / %s', (a, b, floor, trunc) => {
    expect(d(a).floorDiv(d(b))).toBe(floor);
    expect(d(a).truncDiv(d(b))).toBe(trunc);
  });

  it('compares across scales', () => {
    expect(d('1.0').cmp(d('1'))).toBe(0);
    expect(d('-2').cmp(d('1'))).toBe(-1);
    expect(d('0.11').cmp(d('0.1'))).toBe(1);
    expect(d('1.0').eq(d('1.00'))).toBe(true);
  });

  it.each([
    ['2.5', 0, 'half', '3'],
    ['-2.5', 0, 'half', '-3'],
    ['2.49', 0, 'half', '2'],
    ['1.005', 2, 'half', '1.01'],
    ['1234', -2, 'half', '1200'],
    ['1250', -2, 'half', '1300'],
    ['1.21', 1, 'up', '1.3'],
    ['-1.21', 1, 'up', '-1.3'],
    ['1.29', 1, 'down', '1.2'],
    ['-1.29', 1, 'down', '-1.2'],
    ['-1.21', 0, 'floor', '-2'],
    ['1.21', 0, 'floor', '1'],
    ['-1.21', 0, 'ceil', '-1'],
    ['1.21', 0, 'ceil', '2'],
    ['1.2', 3, 'half', '1.2'],
    ['5', -1, 'up', '10'],
  ] as const)('round(%s, %d, %s) = %s', (value, places, mode, expected) => {
    expect(d(value).round(places, mode).toString()).toBe(expected);
  });

  it('pads the scale when rounding to more places', () => {
    expect(d('1.2').round(3).scale).toBe(3);
  });

  it.each([
    // numeric_sqrt scale: 16 significant digits, at least the input scale.
    ['16', '4'],
    ['2', '1.414213562373095'],
    ['0.0001', '0.01'],
    ['0', '0'],
    ['1000000', '1000'],
    ['0.5', '0.70710678118654752'],
    ['12345678901234567890', '3513641828.8201443'],
  ])('sqrt(%s) = %s', (value, expected) => {
    expect(d(value).sqrt()?.toString()).toBe(expected);
  });

  it('has no square root of a negative number', () => {
    expect(d('-1').sqrt()).toBeNull();
  });

  it.each([
    ['2', 10, '1024'],
    ['1.1', 2, '1.21'],
    ['-2', 3, '-8'],
    ['2', -2, '0.25'],
    ['7', 0, '1'],
    ['0', 0, '1'],
  ])('%s ^ %d = %s', (base, exponent, expected) => {
    expect(d(base).powInt(exponent)?.toString()).toBe(expected);
  });

  it('powInt: zero to a negative power and overflow are null; small bases stay small', () => {
    expect(Dec.ZERO.powInt(-1)).toBeNull();
    expect(d('10').powInt(200_000)).toBeNull();
    expect(d('0.5').powInt(10)?.toString()).toBe('0.0009765625');
    expect(d('1').powInt(200_000)?.toString()).toBe('1');
    expect(d('0.1').powInt(200_000)).toBeNull();
  });

  it('converts to JS numbers', () => {
    expect(d('12.9').toInt()).toBe(12);
    expect(d('-12.9').toInt()).toBe(-12);
    expect(d('1e30').toInt()).toBeNull();
    expect(d('-1e30').toInt()).toBeNull();
    expect(d('0.25').toNumber()).toBe(0.25);
    expect(d('3.00').isInteger()).toBe(true);
    expect(d('3.01').isInteger()).toBe(false);
    expect(Dec.int(-4.7).toString()).toBe('-4');
    expect(d('-3').abs().toString()).toBe('3');
    expect(d('3').abs().toString()).toBe('3');
    expect(d('-3').sign).toBe(-1);
    expect(Dec.ZERO.sign).toBe(0);
    expect(Dec.of(5n, 3).toString()).toBe('0.005');
  });
});
