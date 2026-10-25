import { describe, expect, it } from 'vitest';

import { FieldValueError, TEXT_OPERATORS, textFieldType, textOptionsSchema } from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const plain = textOptionsSchema.parse({});

describe('text options', () => {
  it('defaults to the plain style', () => {
    expect(plain).toEqual({ style: { type: 'plain' } });
  });

  it.each(['plain', 'phone', 'url', 'email', 'barcode'])('accepts style %s', (type) => {
    expect(textOptionsSchema.parse({ style: { type }, default_value: 'x' })).toEqual({
      style: { type },
      default_value: 'x',
    });
  });

  it.each([
    { style: { type: 'markdown' } },
    { style: { type: 'plain', extra: 1 } },
    { default_value: 1 },
    { unknown: true },
  ])('rejects %j', (options) => {
    expect(textOptionsSchema.safeParse(options).success).toBe(false);
  });
});

describe('text pgType', () => {
  it.each([
    ['und-x-icu', 'text COLLATE "und-x-icu"'],
    ['vi-VN-x-icu', 'text COLLATE "vi-VN-x-icu"'],
    ['C', 'text COLLATE "C"'],
  ])('collation %s', (collation, expected) => {
    expect(textFieldType.pgType(plain, { collation })).toBe(expected);
  });

  it.each(['vi"; DROP TABLE x; --', '', 'a b'])('rejects unsafe collation %j', (collation) => {
    expect(() => textFieldType.pgType(plain, { collation })).toThrow(TypeError);
  });
});

describe('text values', () => {
  it.each([
    ['abc', true],
    ['', true],
    [null, true],
    [12, false],
    [true, false],
    [['a'], false],
    [undefined, false],
  ])('validate %j -> %s', (value, ok) => {
    const result = textFieldType.validate(value, plain);
    expect(result.ok).toBe(ok);
    if (!result.ok) expect(result.issues[0]?.code).toBe('EXPECTED_STRING');
  });

  it.each([
    ['abc', 'abc'],
    ['', null],
    [null, null],
    ['  keep spaces  ', '  keep spaces  '],
    ['line 1\nline 2', 'line 1\nline 2'],
  ])('toStorage %j -> %j', (value, expected) => {
    expect(textFieldType.toStorage(value, plain)).toBe(expected);
  });

  it('toStorage throws FieldValueError with issues on invalid input', () => {
    expect(() => textFieldType.toStorage(5, plain)).toThrow(FieldValueError);
    try {
      textFieldType.toStorage(5, plain);
    } catch (error) {
      expect((error as FieldValueError).issues[0]?.code).toBe('EXPECTED_STRING');
    }
  });

  it.each([
    ['abc', 'abc'],
    [null, null],
    [undefined, null],
    [42, null],
  ])('fromStorage %j -> %j', (stored, expected) => {
    expect(textFieldType.fromStorage(stored, plain)).toBe(expected);
  });

  it.each([
    ['abc', 'abc'],
    [123, '123'],
    [1.5, '1.5'],
    [true, 'true'],
    [false, 'false'],
    ['', null],
    [null, null],
    [undefined, null],
  ])('typecast %j -> %j', (input, expected) => {
    expect(textFieldType.typecast(input, plain, vi)).toEqual({
      ok: true,
      value: expected,
      unknownOptions: [],
    });
  });

  it.each([[{ a: 1 }], [['x']], [Number.NaN]])('typecast rejects %j', (input) => {
    const result = textFieldType.typecast(input, plain, vi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe('EXPECTED_STRING');
  });

  it.each([
    ['abc', 'abc'],
    [null, ''],
  ])('formatText %j -> %j', (value, expected) => {
    expect(textFieldType.formatText(value, plain, vi)).toBe(expected);
  });

  it('round-trips through storage', () => {
    for (const value of ['Máy POS lỗi in', 'a@x.vn', null]) {
      const stored = textFieldType.toStorage(value, plain);
      expect(textFieldType.fromStorage(stored, plain)).toBe(value);
    }
  });

  it('exposes metadata and filter operators', () => {
    expect(textFieldType.type).toBe('text');
    expect(textFieldType.readOnly).toBe(false);
    expect(textFieldType.supportsDefaultValue).toBe(true);
    expect(textFieldType.systemColumn).toBeNull();
    expect(textFieldType.filterOperators(plain)).toEqual(TEXT_OPERATORS);
    expect(TEXT_OPERATORS).toEqual([
      'eq',
      'neq',
      'contains',
      'not_contains',
      'starts_with',
      'ends_with',
      'is_empty',
      'is_not_empty',
    ]);
  });
});
