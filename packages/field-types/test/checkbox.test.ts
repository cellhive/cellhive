import { describe, expect, it } from 'vitest';

import { CHECKBOX_OPERATORS, checkboxFieldType, checkboxOptionsSchema } from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const en = { locale: 'en-US', timeZone: 'America/New_York' };
const options = checkboxOptionsSchema.parse({});

describe('checkbox', () => {
  it('has no options and no default value', () => {
    expect(options).toEqual({});
    expect(checkboxOptionsSchema.safeParse({ default_value: true }).success).toBe(false);
    expect(checkboxFieldType.supportsDefaultValue).toBe(false);
  });

  it('maps to a non-null boolean', () => {
    expect(checkboxFieldType.pgType(options, { collation: 'und-x-icu' })).toBe(
      'boolean NOT NULL DEFAULT false',
    );
  });

  it.each([
    [true, true],
    [false, true],
    [null, true],
    ['true', false],
    [1, false],
    [undefined, false],
  ])('validate %j -> %s', (value, ok) => {
    const result = checkboxFieldType.validate(value, options);
    expect(result.ok).toBe(ok);
    if (!result.ok) expect(result.issues[0]?.code).toBe('EXPECTED_BOOLEAN');
  });

  it.each([
    [true, true],
    [false, false],
    [null, false],
  ])('toStorage %j -> %j', (value, expected) => {
    expect(checkboxFieldType.toStorage(value, options)).toBe(expected);
  });

  it.each([
    [true, true],
    [false, false],
    [null, false],
    [undefined, false],
    ['t', false],
  ])('fromStorage %j -> %j', (stored, expected) => {
    expect(checkboxFieldType.fromStorage(stored, options)).toBe(expected);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['x', true],
    ['X', true],
    ['có', true],
    ['Có', true],
    ['yes', true],
    ['✓', true],
    [' on ', true],
    ['false', false],
    ['0', false],
    ['không', false],
    ['no', false],
    ['off', false],
    ['', false],
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    [null, false],
    [undefined, false],
  ])('typecast %j -> %j', (input, expected) => {
    for (const ctx of [vi, en]) {
      expect(checkboxFieldType.typecast(input, options, ctx)).toEqual({
        ok: true,
        value: expected,
        unknownOptions: [],
      });
    }
  });

  it.each([['maybe'], [2], [{}], [[true]]])('typecast rejects %j', (input) => {
    const result = checkboxFieldType.typecast(input, options, vi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe('EXPECTED_BOOLEAN');
  });

  it.each([
    [true, '✓'],
    [false, ''],
  ])('formatText %j -> %j', (value, expected) => {
    expect(checkboxFieldType.formatText(value, options, vi)).toBe(expected);
  });

  it('round-trips and exposes operators', () => {
    for (const value of [true, false]) {
      expect(
        checkboxFieldType.fromStorage(checkboxFieldType.toStorage(value, options), options),
      ).toBe(value);
    }
    expect(checkboxFieldType.filterOperators(options)).toEqual(CHECKBOX_OPERATORS);
    expect(CHECKBOX_OPERATORS).toEqual(['is']);
  });
});
