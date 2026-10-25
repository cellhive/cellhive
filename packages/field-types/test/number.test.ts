import { describe, expect, it } from 'vitest';

import { NUMBER_OPERATORS, numberFieldType, numberOptionsSchema } from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const en = { locale: 'en-US', timeZone: 'America/New_York' };

const opts = (input: unknown) => numberOptionsSchema.parse(input);
const plain = opts({});

describe('number options', () => {
  it('defaults to plain, precision 0, no percentage, no grouping', () => {
    expect(plain).toEqual({
      style: { type: 'plain', precision: 0, percentage: false, thousands_separator: false },
    });
  });

  it.each([
    [
      { style: { type: 'currency', currency_code: 'VND' } },
      { style: { type: 'currency', currency_code: 'VND' } },
    ],
    [
      { style: { type: 'currency', currency_code: 'USD', precision: 4 } },
      { style: { type: 'currency', currency_code: 'USD', precision: 4 } },
    ],
    [{ style: { type: 'progress' } }, { style: { type: 'progress', percentage: true } }],
    [
      { style: { type: 'progress', percentage: false, color: 'green' } },
      { style: { type: 'progress', percentage: false, color: 'green' } },
    ],
    [{ style: { type: 'rating' } }, { style: { type: 'rating', icon: 'star', min: 1, max: 5 } }],
    [
      { style: { type: 'rating', icon: 'heart', min: 0, max: 10 } },
      { style: { type: 'rating', icon: 'heart', min: 0, max: 10 } },
    ],
    [{ default_value: 1.5 }, { ...plain, default_value: 1.5 }],
    [{ default_value: null }, { ...plain, default_value: null }],
  ])('accepts %j', (input, expected) => {
    expect(opts(input)).toEqual(expected);
  });

  it.each([
    { style: { type: 'plain', precision: 5 } },
    { style: { type: 'plain', precision: -1 } },
    { style: { type: 'plain', precision: 1.5 } },
    { style: { type: 'currency' } },
    { style: { type: 'currency', currency_code: 'vnd' } },
    { style: { type: 'currency', currency_code: 'ZZZ' } },
    { style: { type: 'rating', min: 2 } },
    { style: { type: 'rating', max: 11 } },
    { style: { type: 'rating', max: 0 } },
    { style: { type: 'rating', icon: 'unicorn' } },
    { style: { type: 'duration' } },
    { default_value: '1' },
    { default_value: Number.POSITIVE_INFINITY },
  ])('rejects %j', (input) => {
    expect(numberOptionsSchema.safeParse(input).success).toBe(false);
  });
});

describe('number values', () => {
  it('maps to numeric', () => {
    expect(numberFieldType.pgType(plain, { collation: 'und-x-icu' })).toBe('numeric');
  });

  it.each([
    [1500000, true],
    [0.2, true],
    [-3, true],
    [null, true],
    ['1', false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [true, false],
    [undefined, false],
  ])('validate %j -> %s', (value, ok) => {
    const result = numberFieldType.validate(value, plain);
    expect(result.ok).toBe(ok);
    if (!result.ok)
      expect(result.issues).toEqual([expect.objectContaining({ code: 'EXPECTED_NUMBER' })]);
  });

  it.each([
    [1500000, 1500000],
    [0.2, 0.2],
    [-0, 0],
    [null, null],
  ])('toStorage %j -> %j', (value, expected) => {
    expect(numberFieldType.toStorage(value, plain)).toBe(expected);
  });

  it.each([
    [1500000, 1500000],
    ['1500000', 1500000],
    ['0.2', 0.2],
    ['-12.50', -12.5],
    [null, null],
    [undefined, null],
    ['not-a-number', null],
    [{}, null],
  ])('fromStorage %j -> %j', (stored, expected) => {
    expect(numberFieldType.fromStorage(stored, plain)).toBe(expected);
  });

  it.each([
    ['1.500.000', vi, 1500000],
    ['1,5', vi, 1.5],
    ['20%', vi, 0.2],
    ['20%', en, 0.2],
    ['1,500,000', en, 1500000],
    ['1.5', en, 1.5],
    [42, en, 42],
    ['', vi, null],
    ['   ', vi, null],
    [null, vi, null],
    [undefined, vi, null],
  ])('typecast %j (%j) -> %j', (input, ctx, expected) => {
    expect(numberFieldType.typecast(input, plain, ctx)).toEqual({
      ok: true,
      value: expected,
      unknownOptions: [],
    });
  });

  it.each([
    ['1,5', en],
    ['abc', vi],
    [true, vi],
    [[1], vi],
    [Number.NaN, vi],
  ])('typecast rejects %j (%j)', (input, ctx) => {
    const result = numberFieldType.typecast(input, plain, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe('EXPECTED_NUMBER');
  });

  it('round-trips through storage (pg numeric arrives as a string)', () => {
    for (const value of [1500000, 0.2, -7.25, null]) {
      const stored = numberFieldType.toStorage(value, plain);
      expect(numberFieldType.fromStorage(stored === null ? null : String(stored), plain)).toBe(
        value,
      );
    }
  });

  it('filter operators', () => {
    expect(numberFieldType.filterOperators(plain)).toEqual(NUMBER_OPERATORS);
    expect(NUMBER_OPERATORS).toEqual([
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'between',
      'is_empty',
      'is_not_empty',
    ]);
    expect(numberFieldType.supportsDefaultValue).toBe(true);
    expect(numberFieldType.readOnly).toBe(false);
  });
});

describe('number formatText', () => {
  it.each([
    // [style, value, ctx, expected]
    [{ type: 'currency', currency_code: 'VND' }, 1500000, vi, '1.500.000 ₫'],
    [{ type: 'currency', currency_code: 'VND' }, 1500000.6, vi, '1.500.001 ₫'],
    [{ type: 'currency', currency_code: 'USD' }, 1500, en, '$1,500.00'],
    [{ type: 'currency', currency_code: 'USD' }, 1500, vi, '1.500,00 US$'],
    [{ type: 'currency', currency_code: 'JPY' }, 1500, en, '¥1,500'],
    [{ type: 'currency', currency_code: 'USD', precision: 0 }, 1500.4, en, '$1,500'],
    [{ type: 'currency', currency_code: 'VND', precision: 2 }, 1500000, vi, '1.500.000,00 ₫'],
    [{ type: 'plain' }, 1500000, vi, '1500000'],
    [{ type: 'plain' }, 1.5, en, '2'],
    [{ type: 'plain', precision: 2 }, 1.5, vi, '1,50'],
    [{ type: 'plain', precision: 2, thousands_separator: true }, 1234567.891, vi, '1.234.567,89'],
    [{ type: 'plain', thousands_separator: true }, 1234567, en, '1,234,567'],
    [{ type: 'plain', percentage: true }, 0.2, vi, '20%'],
    [{ type: 'plain', percentage: true, precision: 1 }, 0.205, en, '20.5%'],
    [{ type: 'progress' }, 0.2, vi, '20%'],
    [{ type: 'progress' }, 0.255, en, '25.5%'],
    [{ type: 'progress', percentage: false }, 42, en, '42'],
    [{ type: 'rating' }, 3, vi, '★★★☆☆'],
    [{ type: 'rating' }, 0, vi, '☆☆☆☆☆'],
    [{ type: 'rating', max: 3 }, 7, vi, '★★★'],
    [{ type: 'rating', max: 10 }, 2.6, vi, '★★★☆☆☆☆☆☆☆'],
    [{ type: 'rating' }, -2, vi, '☆☆☆☆☆'],
    [{ type: 'plain' }, null, vi, ''],
    [{ type: 'rating' }, null, vi, ''],
  ])('%j %j (%j) -> %j', (style, value, ctx, expected) => {
    expect(numberFieldType.formatText(value, opts({ style }), ctx)).toBe(expected);
  });
});
