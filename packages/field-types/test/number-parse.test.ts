import { describe, expect, it } from 'vitest';

import { parseLocaleNumber, parseLocaleNumberExact } from '../src/index.js';

describe('parseLocaleNumber', () => {
  it.each([
    // [input, locale, expected]
    ['1.500.000', 'vi', 1500000],
    ['1.500.000', 'vi-VN', 1500000],
    ['1,5', 'vi', 1.5],
    ['1.500,25', 'vi', 1500.25],
    [',5', 'vi', 0.5],
    ['1.5', 'vi', 1.5], // not a valid vi grouping -> plain JS decimal fallback
    ['1500000', 'vi', 1500000],
    ['-1.500', 'vi', -1500],
    ['+42', 'vi', 42],
    ['20%', 'vi', 0.2],
    ['20,5%', 'vi', 0.205],
    ['%15', 'en-US', 0.15],
    ['1.500.000 ₫', 'vi', 1500000],
    ['1.500.000đ', 'vi', 1500000],
    ['1.500.000 VNĐ', 'vi', 1500000],
    ['VND 1.500.000', 'vi', 1500000],
    ['1,500,000', 'en-US', 1500000],
    ['1,500.25', 'en-US', 1500.25],
    ['$1,500.25', 'en-US', 1500.25],
    ['-$1,500', 'en-US', -1500],
    ['US$ 12', 'en-US', 12],
    ['1.5', 'en-US', 1.5],
    ['.5', 'en-US', 0.5],
    ['1e3', 'en-US', 1000],
    ['  7  ', 'en-US', 7],
    ['-0', 'en-US', 0],
    ['1 234,5', 'fr', 1234.5],
    ['1\u202f234,5', 'fr', 1234.5],
    ['1’234.5', 'de-CH', 1234.5],
  ])('parses %j with %s -> %d', (input, locale, expected) => {
    expect(parseLocaleNumber(input, locale)).toBe(expected);
  });

  it.each([
    ['', 'vi'],
    ['   ', 'vi'],
    ['abc', 'vi'],
    ['1,5', 'en-US'], // `,5` is not a valid en-US group
    ['1.2.3', 'en-US'],
    ['12abc', 'en-US'],
    ['1 500', 'vi'], // whitespace is not the vi group separator
    ['1.500.000,', 'vi'],
    ['--1', 'en-US'],
    ['%', 'en-US'],
    ['$', 'en-US'],
    ['1e999', 'en-US'],
  ])('rejects %j with %s', (input, locale) => {
    expect(parseLocaleNumber(input, locale)).toBeNull();
  });
});

describe('parseLocaleNumberExact', () => {
  it.each([
    // [input, locale, value, exact]
    ['1.500.000', 'vi', 1500000, true],
    ['1,50', 'vi', 1.5, true],
    ['0,1', 'vi', 0.1, true],
    ['20,5%', 'vi', 0.205, true],
    ['1e21', 'en-US', 1e21, true],
    ['0', 'vi', 0, true],
    ['0,000', 'vi', 0, true],
    ['-0,25', 'vi', -0.25, true],
    ['9007199254740993', 'vi', 9007199254740992, false],
    ['12345678901234567890', 'en-US', 12345678901234567000, false],
    ['-12.345.678.901.234.567.890', 'vi', -12345678901234567000, false],
    ['1e-400', 'en-US', 0, false],
  ] as const)('%s (%s) -> %s exact=%s', (input, locale, value, exact) => {
    expect(parseLocaleNumberExact(input, locale)).toEqual({ value, exact });
  });

  it('is null for what is not a number', () => {
    expect(parseLocaleNumberExact('abc', 'vi')).toBeNull();
  });
});
