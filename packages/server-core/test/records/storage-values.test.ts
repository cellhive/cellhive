import { describe, expect, it } from 'vitest';

import {
  sameStoredValue,
  storageToJson,
  storedValueToJson,
} from '../../src/records/storage-values.js';

import type { ImplementedFieldType } from '@cellhive/field-types';

const FILE = { id: 'att_AAAAAAAAAAAAAAA1', name: 'a.pdf', size: 10, mime: 'application/pdf' };

describe('storedValueToJson', () => {
  const cases: [ImplementedFieldType, unknown, unknown][] = [
    ['text', 'abc', 'abc'],
    ['text', null, null],
    ['auto_number', 'NO.001', 'NO.001'],
    ['number', '1500000', 1500000],
    ['number', '0.2', 0.2],
    ['number', '-0', 0],
    ['number', '', null],
    ['number', 12, 12],
    ['checkbox', true, true],
    ['checkbox', null, false],
    ['select', ['opt_a'], ['opt_a']],
    ['select', [], null],
    ['user', null, null],
    ['datetime', new Date('2026-09-25T02:00:00.000Z'), '2026-09-25T02:00:00.000Z'],
    ['datetime', '2026-09-25', '2026-09-25'],
    ['created_at', new Date('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z'],
    ['created_by', 'usr_x', 'usr_x'],
    ['attachment', [FILE], [FILE]],
    ['attachment', [{ ...FILE, size: '10', extra: true }, { bad: 1 }], [FILE]],
    ['attachment', [], null],
    ['attachment', null, null],
  ];
  it.each(cases)('%s %j → %j', (type, raw, expected) => {
    expect(storedValueToJson(type, raw)).toEqual(expected);
  });
});

describe('storageToJson', () => {
  it.each([
    [null, null],
    [undefined, null],
    [[], null],
    [
      ['a', 'b'],
      ['a', 'b'],
    ],
    [-0, 0],
    [1.5, 1.5],
    ['x', 'x'],
    [false, false],
  ])('%j → %j', (value, expected) => {
    expect(storageToJson(value)).toEqual(expected);
  });

  it('keeps plain objects (attachment entries), rejects anything else', () => {
    expect(storageToJson([FILE])).toEqual([FILE]);
    expect(() => storageToJson(new Map())).toThrow(TypeError);
    expect(() => storageToJson(Symbol('x'))).toThrow(TypeError);
  });
});

describe('sameStoredValue', () => {
  it.each([
    [1, 1, true],
    [1, 2, false],
    [null, null, true],
    [null, false, false],
    [['a', 'b'], ['a', 'b'], true],
    [['a', 'b'], ['b', 'a'], false],
    [['a'], null, false],
    ['2026-01-01', '2026-01-01', true],
    [[FILE], [{ ...FILE }], true],
    [[FILE], [{ ...FILE, name: 'b.pdf' }], false],
    [[FILE], [{ id: FILE.id }], false],
  ])('%j vs %j → %s', (a, b, expected) => {
    expect(sameStoredValue(a, b)).toBe(expected);
  });
});
