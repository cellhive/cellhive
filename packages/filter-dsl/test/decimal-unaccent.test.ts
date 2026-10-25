import { describe, expect, it } from 'vitest';

import { compareDecimal, foldText, parseDecimal, unaccent, type Decimal } from '../src/index.js';

const parsed = (value: unknown): Decimal => {
  const decimal = parseDecimal(value);
  if (decimal === null) throw new Error(`not a decimal: ${String(value)}`);
  return decimal;
};

describe('parseDecimal / compareDecimal', () => {
  it.each([
    { a: '0', b: 0, order: 0 },
    { a: '-0.000', b: '0', order: 0 },
    { a: '0.30', b: 0.3, order: 0 },
    { a: 0.1 + 0.2, b: '0.3', order: 1 },
    { a: '1e3', b: 1000, order: 0 },
    { a: '1E-7', b: '0.0000001', order: 0 },
    { a: '.5', b: '0.5', order: 0 },
    { a: '5.', b: 5, order: 0 },
    { a: '+2', b: 2, order: 0 },
    { a: ' 12 ', b: 12, order: 0 },
    { a: '100', b: '99.999999999999999999999', order: 1 },
    { a: '-100', b: '-99.9', order: -1 },
    { a: '-1', b: '1', order: -1 },
    { a: '0', b: '-1', order: 1 },
    { a: '12345678901234567890', b: Number('12345678901234567890'), order: 1 },
    { a: BigInt('9007199254740993'), b: '9007199254740992', order: 1 },
    { a: 'Infinity', b: '1e300', order: 1 },
    { a: '-Infinity', b: '-1e300', order: -1 },
    { a: 'NaN', b: 'Infinity', order: 1 },
    { a: 'nan', b: 'NaN', order: 0 },
    { a: '-inf', b: '-Infinity', order: 0 },
  ])('$a vs $b → $order', ({ a, b, order }) => {
    expect(compareDecimal(parsed(a), parsed(b))).toBe(order);
    expect(compareDecimal(parsed(b), parsed(a))).toBe(-order || 0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '', 'abc', '1..2', '1e', null, true, {}])(
    'rejects %s',
    (value) => {
      expect(parseDecimal(value)).toBeNull();
    },
  );
});

describe('unaccent / foldText', () => {
  it.each([
    { input: 'Nguyễn Văn Ân', unaccented: 'Nguyen Van An', folded: 'nguyen van an' },
    { input: 'ĐẶNG đào', unaccented: 'DANG dao', folded: 'dang dao' },
    { input: 'Café', unaccented: 'Cafe', folded: 'cafe' },
    { input: 'Straße Æ œ', unaccented: 'Strasse AE oe', folded: 'strasse ae oe' },
    { input: '％＿＼', unaccented: '%_\\', folded: '%_\\' },
    { input: '½', unaccented: ' 1/2', folded: ' 1/2' },
    { input: '“quoted”', unaccented: '"quoted"', folded: '"quoted"' },
    { input: 'İstanbul', unaccented: 'Istanbul', folded: 'istanbul' },
    { input: 'ΟΔΟΣ', unaccented: 'ΟΔΟΣ', folded: 'οδος' },
    { input: '😀 plain', unaccented: '😀 plain', folded: '😀 plain' },
  ])('$input', ({ input, unaccented, folded }) => {
    expect(unaccent(input)).toBe(unaccented);
    expect(foldText(input)).toBe(folded);
  });
});
