import { describe, expect, it } from 'vitest';

import {
  AUTO_NUMBER_DATE_FORMATS,
  autoNumberFieldType,
  autoNumberOptionsSchema,
  DEFAULT_AUTO_NUMBER_RULES,
  FieldValueError,
  formatAutoNumber,
  TEXT_OPERATORS,
  type AutoNumberRule,
} from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const ticketRules: AutoNumberRule[] = [
  { type: 'text', text: 'TK-' },
  { type: 'created_time', date_format: 'yyyyMMdd' },
  { type: 'text', text: '-' },
  { type: 'incremental_number', length: 4 },
];

describe('auto_number options', () => {
  it('defaults to NO.001', () => {
    expect(autoNumberOptionsSchema.parse({})).toEqual({
      style: { rules: DEFAULT_AUTO_NUMBER_RULES },
    });
    expect(
      formatAutoNumber(DEFAULT_AUTO_NUMBER_RULES, {
        autoValue: 1,
        createdAt: new Date(),
        timeZone: 'UTC',
      }),
    ).toBe('NO.001');
  });

  it.each([
    [{ style: { rules: ticketRules } }],
    [{ style: { rules: [{ type: 'incremental_number', length: 9 }] } }],
    [{ style: { rules: Array.from({ length: 9 }, () => ({ type: 'text', text: 'x' })) } }],
  ])('accepts %#', (input) => {
    expect(autoNumberOptionsSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['no rules', { style: { rules: [] } }],
    [
      'ten rules',
      { style: { rules: Array.from({ length: 10 }, () => ({ type: 'text', text: 'x' })) } },
    ],
    ['length 0', { style: { rules: [{ type: 'incremental_number', length: 0 }] } }],
    ['length 10', { style: { rules: [{ type: 'incremental_number', length: 10 }] } }],
    ['empty text', { style: { rules: [{ type: 'text', text: '' }] } }],
    ['bad date format', { style: { rules: [{ type: 'created_time', date_format: 'dd-MM' }] } }],
    ['unknown rule', { style: { rules: [{ type: 'random' }] } }],
    ['default_value', { default_value: 'x' }],
  ])('rejects %s', (_label, input) => {
    expect(autoNumberOptionsSchema.safeParse(input).success).toBe(false);
  });
});

describe('formatAutoNumber', () => {
  const createdAt = '2026-09-20T03:15:00.000Z';

  it.each([
    [ticketRules, 42, 'Asia/Ho_Chi_Minh', 'TK-20260920-0042'],
    [ticketRules, 42n, 'Asia/Ho_Chi_Minh', 'TK-20260920-0042'],
    [ticketRules, '42', 'Asia/Ho_Chi_Minh', 'TK-20260920-0042'],
    [ticketRules, 123456, 'Asia/Ho_Chi_Minh', 'TK-20260920-123456'],
    // 03:15Z is still 19 September in New York.
    [ticketRules, 7, 'America/New_York', 'TK-20260919-0007'],
    [[{ type: 'created_time', date_format: 'yyMMdd' }], 1, 'UTC', '260920'],
    [[{ type: 'created_time', date_format: 'yyyyMM' }], 1, 'UTC', '202609'],
    [[{ type: 'created_time', date_format: 'yyMM' }], 1, 'UTC', '2609'],
    [[{ type: 'created_time', date_format: 'MMdd' }], 1, 'UTC', '0920'],
    [[{ type: 'created_time', date_format: 'yyyy' }], 1, 'UTC', '2026'],
    [[{ type: 'created_time', date_format: 'yy' }], 1, 'UTC', '26'],
    [[{ type: 'created_time', date_format: 'MM' }], 1, 'UTC', '09'],
    [[{ type: 'created_time', date_format: 'dd' }], 1, 'UTC', '20'],
    [[{ type: 'incremental_number', length: 1 }], 9, 'UTC', '9'],
  ] as const)('%j #%s in %s -> %s', (rules, autoValue, timeZone, expected) => {
    expect(formatAutoNumber(rules, { autoValue, createdAt, timeZone })).toBe(expected);
  });

  it('accepts Date and epoch ms for createdAt', () => {
    const at = Date.parse(createdAt);
    expect(formatAutoNumber(ticketRules, { autoValue: 1, createdAt: at, timeZone: 'UTC' })).toBe(
      'TK-20260920-0001',
    );
    expect(
      formatAutoNumber(ticketRules, { autoValue: 1, createdAt: new Date(at), timeZone: 'UTC' }),
    ).toBe('TK-20260920-0001');
  });

  it('lists the supported date formats', () => {
    expect(AUTO_NUMBER_DATE_FORMATS).toEqual([
      'yyyyMMdd',
      'yyMMdd',
      'yyyyMM',
      'yyMM',
      'MMdd',
      'yyyy',
      'yy',
      'MM',
      'dd',
    ]);
  });

  it.each([
    [{ autoValue: -1, createdAt, timeZone: 'UTC' }],
    [{ autoValue: 1.5, createdAt, timeZone: 'UTC' }],
    [{ autoValue: '12a', createdAt, timeZone: 'UTC' }],
    [{ autoValue: -1n, createdAt, timeZone: 'UTC' }],
    [{ autoValue: 1, createdAt: 'not a date', timeZone: 'UTC' }],
  ])('rejects invalid input %#', (input) => {
    expect(() => formatAutoNumber(ticketRules, input)).toThrow(TypeError);
  });
});

describe('auto_number field type', () => {
  const options = autoNumberOptionsSchema.parse({ style: { rules: ticketRules } });

  it('metadata', () => {
    expect(autoNumberFieldType.readOnly).toBe(true);
    expect(autoNumberFieldType.supportsDefaultValue).toBe(false);
    expect(autoNumberFieldType.systemColumn).toBeNull();
    expect(autoNumberFieldType.pgType(options, { collation: 'und-x-icu' })).toBe(
      'text COLLATE "und-x-icu"',
    );
    expect(() => autoNumberFieldType.pgType(options, { collation: 'x" ; DROP' })).toThrow(
      TypeError,
    );
    expect(autoNumberFieldType.filterOperators(options)).toEqual(TEXT_OPERATORS);
  });

  it('is read-only', () => {
    expect(autoNumberFieldType.validate('TK-1', options).ok).toBe(false);
    expect(autoNumberFieldType.typecast('TK-1', options, vi).ok).toBe(false);
    expect(() => autoNumberFieldType.toStorage('TK-1', options)).toThrow(FieldValueError);
  });

  it.each([
    ['TK-20260920-0042', 'TK-20260920-0042'],
    [null, null],
    [42, null],
  ])('fromStorage %j', (stored, expected) => {
    expect(autoNumberFieldType.fromStorage(stored, options)).toBe(expected);
  });

  it.each([
    ['TK-20260920-0042', 'TK-20260920-0042'],
    [null, ''],
  ])('formatText %j', (value, expected) => {
    expect(autoNumberFieldType.formatText(value, options, vi)).toBe(expected);
  });
});
