import { describe, expect, it } from 'vitest';

import {
  computedSourceDefinition,
  convertComputedCell,
  FIELD_TYPE_REGISTRY,
  inheritComputedStyle,
  planComputedConversion,
  type ComputedResultType,
  type ComputedSource,
  type ComputedStyle,
  type FieldDefinitionRef,
  type S1FieldType,
} from '../src/index.js';

const en = { locale: 'en-US', timeZone: 'UTC' };
const USR_1 = 'usr_AAAAAAAAAAAAAAA1';
const USR_2 = 'usr_BBBBBBBBBBBBBBB2';

function def(type: S1FieldType, options: unknown = {}): FieldDefinitionRef {
  return { type, options: FIELD_TYPE_REGISTRY[type].optionsSchema.parse(options) };
}

function source(
  kind: ComputedResultType['kind'],
  list = false,
  style: ComputedStyle | null = null,
): ComputedSource {
  return { result: { kind, list }, style };
}

const currency: ComputedStyle = { type: 'currency', precision: 2, currency_code: 'USD' };
const text = def('text');
const number = def('number');
const date = def('datetime', { style: { format: 'yyyy-MM-dd' } });
const dateTime = def('datetime', { style: { format: 'yyyy-MM-dd HH:mm' } });
const checkbox = def('checkbox');
const users = def('user');
const oneUser = def('user', { multiple: false });
const multi = def('select', { multiple: true });
const single = def('select');

describe('computedSourceDefinition (CONTRACTS §4.1: computed converts as its result type)', () => {
  it.each<[string, ComputedSource, FieldDefinitionRef, S1FieldType]>([
    ['number → number', source('number'), number, 'number'],
    ['number → text reads the display text', source('number'), text, 'text'],
    ['number → select reads the display text', source('number'), single, 'text'],
    ['boolean → checkbox', source('boolean'), checkbox, 'checkbox'],
    ['boolean → number', source('boolean'), number, 'checkbox'],
    ['date → datetime', source('date'), date, 'datetime'],
    ['datetime → number (epoch)', source('datetime'), number, 'datetime'],
    ['user list → user', source('user', true), users, 'user'],
    ['record list → text (titles)', source('record', true), text, 'text'],
    ['attachment → number', source('attachment', true), number, 'text'],
    ['text → datetime (parse)', source('text'), date, 'text'],
  ])('%s', (_name, from, to, expected) => {
    expect(computedSourceDefinition(from, to.type).type).toBe(expected);
  });

  it('keeps a number style and a date format of the result', () => {
    expect(computedSourceDefinition(source('number', false, currency), 'number').options).toEqual(
      expect.objectContaining({ style: currency }),
    );
    expect(computedSourceDefinition(source('date'), 'datetime').options).toEqual(
      expect.objectContaining({ style: { format: 'yyyy-MM-dd' } }),
    );
    expect(computedSourceDefinition(source('datetime'), 'datetime').options).toEqual(
      expect.objectContaining({ style: { format: 'yyyy-MM-dd HH:mm' } }),
    );
  });
});

describe('planComputedConversion', () => {
  it.each<[string, ComputedSource, FieldDefinitionRef, string]>([
    ['number → number is never `none`', source('number'), number, 'keep'],
    ['text → text', source('text'), text, 'keep'],
    ['boolean → checkbox', source('boolean'), checkbox, 'keep'],
    ['number → datetime', source('number'), date, 'keep'],
    ['user list → one user cuts', source('user', true), oneUser, 'truncate'],
    ['number → user is blacklisted', source('number'), users, 'blacklist'],
    ['record → select creates options', source('record', true), multi, 'keep'],
    ['text → checkbox without truthy values', source('text'), checkbox, 'blacklist'],
  ])('%s', (_name, from, to, kind) => {
    expect(planComputedConversion(from, to).kind).toBe(kind);
  });
});

describe('convertComputedCell', () => {
  it.each<[string, ComputedSource, FieldDefinitionRef, unknown, unknown]>([
    ['empty value', source('number'), number, null, { outcome: 'empty' }],
    ['number keeps its value', source('number', false, currency), number, 12.5, kept(12.5)],
    [
      'number → text is the display text',
      source('number', false, currency),
      text,
      1234.5,
      kept('$1,234.50'),
    ],
    ['number list → text joins', source('number', true), text, [1, 2], kept('1, 2')],
    [
      'number list → number keeps the first (cut)',
      source('number', true),
      number,
      [3, 4],
      { outcome: 'truncated', value: 3 },
    ],
    ['single-item list → number', source('number', true), number, [3], kept(3)],
    ['boolean true → checkbox', source('boolean'), checkbox, true, kept(true)],
    ['boolean false → checkbox is empty', source('boolean'), checkbox, false, { outcome: 'empty' }],
    ['boolean → number', source('boolean'), number, false, kept(0)],
    ['boolean → text', source('boolean'), text, true, kept('TRUE')],
    ['date → date', source('date'), date, '2026-09-28', kept('2026-09-28')],
    [
      'datetime → datetime',
      source('datetime'),
      dateTime,
      '2026-09-28T10:30:00.000Z',
      kept('2026-09-28T10:30:00.000Z'),
    ],
    ['date → number (epoch ms)', source('date'), number, '2026-09-28', kept(Date.UTC(2026, 8, 28))],
    ['text → number parses', source('text'), number, '42', kept(42)],
    ['text → number not a number', source('text'), number, 'abc', { outcome: 'lost' }],
    [
      'record list → text shows titles',
      source('record', true),
      text,
      [
        { id: 'rec_AAAAAAAAAAAAAAA1', title: 'Acme' },
        { id: 'rec_BBBBBBBBBBBBBBB2', title: 'Globex' },
      ],
      kept('Acme, Globex'),
    ],
    [
      'user list → users',
      source('user', true),
      users,
      [{ id: USR_1, name: 'A', email: 'a@x.io' }, { id: USR_2 }],
      kept([{ id: USR_1 }, { id: USR_2 }]),
    ],
    [
      'user list → one user cuts',
      source('user', true),
      oneUser,
      [{ id: USR_1 }, { id: USR_2 }],
      { outcome: 'truncated', value: [{ id: USR_1 }] },
    ],
    ['text list → multiple select', source('text', true), multi, ['a', 'b'], kept(['a', 'b'])],
    ['number → user is lost', source('number'), users, 5, { outcome: 'lost' }],
  ])('%s', (_name, from, to, value, expected) => {
    const plan = planComputedConversion(from, to);
    expect(convertComputedCell(plan, from, value, en)).toEqual(expected);
  });
});

describe('inheritComputedStyle', () => {
  it('gives a number target the style of the result when the request has none', () => {
    expect(inheritComputedStyle(source('number', false, currency), 'number', {})).toEqual({
      style: currency,
    });
    expect(
      inheritComputedStyle(source('number', false, currency), 'number', {
        style: { type: 'plain', precision: 1 },
      }),
    ).toEqual({ style: { type: 'plain', precision: 1 } });
  });

  it('gives a datetime target the format of a date result', () => {
    expect(inheritComputedStyle(source('datetime'), 'datetime', undefined)).toEqual({
      style: { format: 'yyyy-MM-dd HH:mm' },
    });
    expect(inheritComputedStyle(source('text'), 'datetime', undefined)).toEqual({});
  });
});

function kept(value: unknown) {
  return { outcome: 'kept', value };
}
