import { describe, expect, it } from 'vitest';

import {
  classifyConversion,
  convertCell,
  datetimeOptionsSchema,
  FIELD_TYPE_REGISTRY,
  isInvalidForTextStyle,
  isPhoneNumber,
  missingSelectOptionNames,
  numberOptionsSchema,
  planFieldConversion,
  selectOptionsSchema,
  textOptionsSchema,
  userOptionsSchema,
  type ConversionSettings,
  type FieldDefinitionRef,
  type S1FieldType,
} from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const enUS = { locale: 'en-US', timeZone: 'UTC' };
const OPT_A = 'opt_Aaaaaaaaaaaaaaa1';
const OPT_B = 'opt_Bbbbbbbbbbbbbbb1';
const USR_1 = 'usr_AAAAAAAAAAAAAAA1';
const USR_2 = 'usr_BBBBBBBBBBBBBBB2';

function def(type: S1FieldType, options: unknown = {}): FieldDefinitionRef {
  return { type, options: FIELD_TYPE_REGISTRY[type].optionsSchema.parse(options) };
}

const text = def('text');
const email = def('text', { style: { type: 'email' } });
const number = def('number');
const grouped = def('number', {
  style: { type: 'plain', precision: 0, thousands_separator: true },
});
const date = def('datetime', { style: { format: 'dd/MM/yyyy' } });
const dateTime = def('datetime', { style: { format: 'dd/MM/yyyy HH:mm' } });
const checkbox = def('checkbox');
const options = [
  { id: OPT_A, name: 'Mới' },
  { id: OPT_B, name: 'Xong' },
];
const single = def('select', { options });
const multi = def('select', { multiple: true, options });
const emptySelect = def('select');
const emptyMulti = def('select', { multiple: true });
const users = def('user');
const oneUser = def('user', { multiple: false });

describe('classifyConversion (CONTRACTS §4)', () => {
  it.each<[string, FieldDefinitionRef, FieldDefinitionRef, ConversionSettings, string]>([
    // §4.1 whitelist
    ['text ← number', number, text, {}, 'keep'],
    ['text ← select', single, text, {}, 'keep'],
    ['text ← datetime', date, text, {}, 'keep'],
    ['text ← created_at', def('created_at'), text, {}, 'keep'],
    ['text ← updated_at', def('updated_at'), text, {}, 'keep'],
    ['text ← auto_number', def('auto_number'), text, {}, 'keep'],
    ['text ← checkbox', checkbox, text, {}, 'keep'],
    ['text ← user', users, text, {}, 'keep'],
    ['text ← created_by', def('created_by'), text, {}, 'keep'],
    ['text ← updated_by', def('updated_by'), text, {}, 'keep'],
    ['number ← text', text, number, {}, 'keep'],
    ['number ← datetime', date, number, {}, 'keep'],
    ['number ← created_at', def('created_at'), number, {}, 'keep'],
    ['number ← checkbox', checkbox, number, {}, 'keep'],
    ['datetime ← text', text, date, {}, 'keep'],
    ['datetime ← number', number, date, {}, 'keep'],
    ['datetime ← created_at', def('created_at'), dateTime, {}, 'keep'],
    ['datetime ← updated_at', def('updated_at'), date, {}, 'keep'],
    ['select ← text', text, single, {}, 'keep'],
    ['select ← number', number, multi, {}, 'keep'],
    ['select(multi) ← select(single)', single, multi, {}, 'none'],
    ['checkbox ← text + truthy', text, checkbox, { truthy_values: ['x'] }, 'keep'],
    ['checkbox ← select + truthy', single, checkbox, { truthy_values: ['Xong'] }, 'keep'],
    ['user ← text + match_email', text, users, { match_email: true }, 'keep'],
    ['user ← created_by', def('created_by'), users, {}, 'keep'],
    ['style only', text, email, {}, 'none'],
    ['number style only', number, grouped, {}, 'none'],
    ['date format, same column type', date, def('datetime'), {}, 'none'],
    ['date ↔ timestamptz', date, dateTime, {}, 'keep'],
    ['timestamptz ↔ date', dateTime, date, {}, 'keep'],
    // §4.2
    ['select multi → single', multi, single, {}, 'truncate'],
    ['user multi → single', users, oneUser, {}, 'truncate'],
    ['user single → multi', oneUser, users, {}, 'none'],
    // §4.3
    ['checkbox ← text without truthy', text, checkbox, {}, 'blacklist'],
    ['checkbox ← text with blank truthy', text, checkbox, { truthy_values: [' '] }, 'blacklist'],
    ['checkbox ← number', number, checkbox, { truthy_values: ['1'] }, 'blacklist'],
    ['user ← text without match_email', text, users, {}, 'blacklist'],
    ['user ← select', single, users, {}, 'blacklist'],
    ['number ← select', single, number, {}, 'blacklist'],
    ['number ← user', users, number, {}, 'blacklist'],
    ['datetime ← checkbox', checkbox, date, {}, 'blacklist'],
    ['select ← datetime', date, single, {}, 'blacklist'],
    // no column of its own
    ['created_at ← text', text, def('created_at'), {}, 'forbidden'],
    ['auto_number ← text', text, def('auto_number'), {}, 'forbidden'],
    ['created_by ← user', users, def('created_by'), {}, 'forbidden'],
  ])('%s → %s', (_name, from, to, settings, kind) => {
    expect(classifyConversion(from, to, settings)).toBe(kind);
  });
});

function convert(
  from: FieldDefinitionRef,
  to: FieldDefinitionRef,
  value: unknown,
  settings: ConversionSettings = {},
  ctx = vi,
) {
  return convertCell(planFieldConversion(from, to, settings), value, ctx);
}

describe('convertCell (CONTRACTS §4.1)', () => {
  it.each<[string, FieldDefinitionRef, FieldDefinitionRef, unknown, unknown]>([
    ['text ← number (display)', grouped, text, 1500000, { outcome: 'kept', value: '1.500.000' }],
    ['text ← select', multi, text, ['Mới', 'Xong'], { outcome: 'kept', value: 'Mới, Xong' }],
    ['text ← date', date, text, '2026-09-25', { outcome: 'kept', value: '25/09/2026' }],
    [
      'text ← datetime in field zone',
      dateTime,
      text,
      '2026-09-25T02:00:00.000Z',
      { outcome: 'kept', value: '25/09/2026 09:00' },
    ],
    ['text ← checkbox', checkbox, text, true, { outcome: 'kept', value: '✓' }],
    ['text ← unchecked', checkbox, text, false, { outcome: 'empty' }],
    [
      'text ← user',
      users,
      text,
      [
        { id: USR_1, name: 'An' },
        { id: USR_2, email: 'b@x.vn' },
      ],
      { outcome: 'kept', value: 'An, b@x.vn' },
    ],
    [
      'text ← auto_number',
      def('auto_number'),
      text,
      'NO.001',
      { outcome: 'kept', value: 'NO.001' },
    ],
    ['number ← "1.500.000" (vi)', text, number, '1.500.000', { outcome: 'kept', value: 1500000 }],
    ['number ← "1,5" (vi)', text, number, '1,5', { outcome: 'kept', value: 1.5 }],
    ['number ← "20%"', text, number, '20%', { outcome: 'kept', value: 0.2 }],
    ['number ← "abc"', text, number, 'abc', { outcome: 'lost' }],
    [
      'number ← 20 digits (rounded: cut, needs confirm)',
      text,
      number,
      '12345678901234567890',
      { outcome: 'truncated', value: 12345678901234567000 },
    ],
    [
      'number ← 18 significant digits',
      text,
      number,
      '0,123456789012345678',
      { outcome: 'truncated', value: 0.12345678901234568 },
    ],
    [
      'number ← 2^53 grouped (vi)',
      text,
      number,
      '9.007.199.254.740.992',
      { outcome: 'kept', value: 9007199254740992 },
    ],
    ['number ← "1,50" (trailing zero)', text, number, '1,50', { outcome: 'kept', value: 1.5 }],
    ['number ← ""', text, number, '', { outcome: 'empty' }],
    ['number ← null', text, number, null, { outcome: 'empty' }],
    [
      'number ← instant',
      dateTime,
      number,
      '2026-09-25T00:00:00.000Z',
      { outcome: 'kept', value: Date.UTC(2026, 8, 25) },
    ],
    [
      'number ← date (start of the day in the field zone)',
      date,
      number,
      '2026-09-25',
      { outcome: 'kept', value: Date.UTC(2026, 8, 24, 17) },
    ],
    ['number ← checked', checkbox, number, true, { outcome: 'kept', value: 1 }],
    ['number ← unchecked', checkbox, number, false, { outcome: 'kept', value: 0 }],
    ['date ← "25/09/2026"', text, date, '25/09/2026', { outcome: 'kept', value: '2026-09-25' }],
    ['date ← "2026-09-25"', text, date, '2026-09-25', { outcome: 'kept', value: '2026-09-25' }],
    ['date ← "31/02/2026"', text, date, '31/02/2026', { outcome: 'lost' }],
    ['date ← "hôm nay"', text, date, 'hôm nay', { outcome: 'lost' }],
    [
      'datetime ← "25/09/2026 09:30" (field zone)',
      text,
      dateTime,
      '25/09/2026 09:30',
      { outcome: 'kept', value: '2026-09-25T02:30:00.000Z' },
    ],
    [
      'datetime ← ISO with offset',
      text,
      dateTime,
      '2026-09-25T09:30:00+07:00',
      { outcome: 'kept', value: '2026-09-25T02:30:00.000Z' },
    ],
    [
      'datetime ← epoch ms',
      number,
      dateTime,
      Date.UTC(2026, 8, 25, 2),
      { outcome: 'kept', value: '2026-09-25T02:00:00.000Z' },
    ],
    [
      'datetime ← epoch seconds (< 10¹¹)',
      number,
      dateTime,
      Date.UTC(2026, 8, 25, 2) / 1000,
      { outcome: 'kept', value: '2026-09-25T02:00:00.000Z' },
    ],
    [
      'date ← epoch ms (field zone)',
      number,
      date,
      Date.UTC(2026, 8, 24, 20),
      { outcome: 'kept', value: '2026-09-25' },
    ],
    ['datetime ← huge number', number, dateTime, 1e20, { outcome: 'lost' }],
    [
      'date → date-time keeps the day (start in field zone)',
      date,
      dateTime,
      '2026-09-25',
      { outcome: 'kept', value: '2026-09-24T17:00:00.000Z' },
    ],
    [
      'date-time → date (day in field zone)',
      dateTime,
      date,
      '2026-09-24T18:00:00.000Z',
      { outcome: 'kept', value: '2026-09-25' },
    ],
    [
      'datetime ← created_at',
      def('created_at'),
      dateTime,
      '2026-09-25T02:00:00.000Z',
      { outcome: 'kept', value: '2026-09-25T02:00:00.000Z' },
    ],
    ['select ← text', text, single, '  Mới  ', { outcome: 'kept', value: 'Mới' }],
    [
      'select ← text keeps commas (single)',
      text,
      emptySelect,
      'a, b',
      { outcome: 'kept', value: 'a, b' },
    ],
    [
      'select(multi) ← text splits',
      text,
      emptyMulti,
      'a, b, a',
      { outcome: 'kept', value: ['a', 'b'] },
    ],
    [
      'select(multi) ← exact name with comma',
      text,
      def('select', { multiple: true, options: [{ id: OPT_A, name: 'a, b' }] }),
      'a, b',
      { outcome: 'kept', value: ['a, b'] },
    ],
    ['select ← number (display)', grouped, emptySelect, 1500, { outcome: 'kept', value: '1.500' }],
    ['select ← id-like text', text, emptySelect, OPT_A, { outcome: 'lost' }],
    ['select ← over-long text', text, emptySelect, 'x'.repeat(256), { outcome: 'lost' }],
    [
      'select(single) ← select(multi)',
      multi,
      single,
      ['Xong', 'Mới'],
      { outcome: 'truncated', value: 'Xong' },
    ],
    ['select(single) ← one option', multi, single, ['Mới'], { outcome: 'kept', value: 'Mới' }],
    [
      'user(single) ← users',
      users,
      oneUser,
      [{ id: USR_1 }, { id: USR_2 }],
      { outcome: 'truncated', value: [{ id: USR_1 }] },
    ],
    [
      'user ← created_by',
      def('created_by'),
      users,
      { id: USR_1, name: 'An' },
      { outcome: 'kept', value: [{ id: USR_1 }] },
    ],
  ])('%s', (_name, from, to, value, expected) => {
    expect(convert(from, to, value)).toEqual(expected);
  });

  it.each(['America/New_York', 'Asia/Ho_Chi_Minh', 'UTC', 'Pacific/Kiritimati'])(
    'keeps the day of a date through number and back (%s)',
    (timeZone) => {
      const ctx = { locale: 'vi', timeZone };
      const toNumber = convertCell(planFieldConversion(date, number), '2026-09-25', ctx);
      expect(toNumber.outcome).toBe('kept');
      const back = convertCell(
        planFieldConversion(number, date),
        toNumber.outcome === 'kept' ? toNumber.value : null,
        ctx,
      );
      expect(back).toEqual({ outcome: 'kept', value: '2026-09-25' });
    },
  );

  it('reads month-first dates for en-US only (CONTRACTS §4.1)', () => {
    const us = def('datetime', { style: { format: 'MM/dd/yyyy' } });
    expect(convert(text, us, '09/25/2026', {}, enUS)).toEqual({
      outcome: 'kept',
      value: '2026-09-25',
    });
    expect(convert(text, us, '09/25/2026', {}, vi)).toEqual({ outcome: 'lost' });
  });

  it('keeps only existing options with match_existing_only', () => {
    const settings = { match_existing_only: true };
    expect(convert(text, single, 'Xong', settings)).toEqual({ outcome: 'kept', value: 'Xong' });
    expect(convert(text, single, 'Khác', settings)).toEqual({ outcome: 'lost' });
    expect(convert(text, multi, 'Mới, Khác', settings)).toEqual({
      outcome: 'kept',
      value: ['Mới'],
    });
  });

  it('checks a checkbox for truthy_values only (trimmed, any case)', () => {
    const settings = { truthy_values: ['Có', 'x'] };
    expect(convert(text, checkbox, ' có ', settings)).toEqual({ outcome: 'kept', value: true });
    expect(convert(text, checkbox, 'X', settings)).toEqual({ outcome: 'kept', value: true });
    expect(convert(text, checkbox, 'Không', settings)).toEqual({ outcome: 'lost' });
    expect(convert(text, checkbox, null, settings)).toEqual({ outcome: 'empty' });
    expect(convert(multi, checkbox, ['Mới', 'Xong'], { truthy_values: ['xong'] })).toEqual({
      outcome: 'kept',
      value: true,
    });
  });

  it('matches member emails with match_email', () => {
    const resolveUserEmail = (value: string) =>
      value === 'an@x.vn' ? USR_1 : value === 'binh@x.vn' ? USR_2 : undefined;
    const ctx = { ...vi, resolveUserEmail };
    const plan = planFieldConversion(text, users, { match_email: true });
    expect(convertCell(plan, 'an@x.vn; binh@x.vn, ai@x.vn', ctx)).toEqual({
      outcome: 'kept',
      value: [{ id: USR_1 }, { id: USR_2 }],
    });
    expect(convertCell(plan, 'nobody@x.vn', ctx)).toEqual({ outcome: 'lost' });
    expect(convertCell(plan, 'not an email', ctx)).toEqual({ outcome: 'lost' });
    const onePlan = planFieldConversion(text, oneUser, { match_email: true });
    expect(convertCell(onePlan, 'an@x.vn, binh@x.vn', ctx)).toEqual({
      outcome: 'truncated',
      value: [{ id: USR_1 }],
    });
  });

  it('loses every non-empty value of a blacklisted conversion', () => {
    expect(convert(text, checkbox, 'x')).toEqual({ outcome: 'lost' });
    expect(convert(text, checkbox, null)).toEqual({ outcome: 'empty' });
    expect(convert(single, number, 'Mới')).toEqual({ outcome: 'lost' });
  });

  it('refuses none and forbidden plans', () => {
    expect(() => convert(text, email, 'a')).toThrow(TypeError);
    expect(() => convert(text, def('created_at'), 'a')).toThrow(TypeError);
  });

  it('produces values the target type accepts', () => {
    const cases: [FieldDefinitionRef, FieldDefinitionRef, unknown][] = [
      [text, number, '1.500.000'],
      [text, date, '25/09/2026'],
      [text, dateTime, '25/09/2026 09:30'],
      [date, dateTime, '2026-09-25'],
      [multi, single, ['Xong', 'Mới']],
      [users, oneUser, [{ id: USR_1 }, { id: USR_2 }]],
      [grouped, text, 12],
      [checkbox, number, true],
    ];
    for (const [from, to, value] of cases) {
      const result = convert(from, to, value);
      if (result.outcome !== 'kept' && result.outcome !== 'truncated') throw new Error('lost');
      const definition = FIELD_TYPE_REGISTRY[to.type];
      expect(definition.validate(result.value, to.options as never)).toEqual({ ok: true });
    }
  });

  it('names the select options a conversion creates', () => {
    const target = selectOptionsSchema.parse({ multiple: true, options });
    expect(missingSelectOptionNames(target, ['Mới', 'Khác'])).toEqual(['Khác']);
    expect(missingSelectOptionNames(target, 'Mới')).toEqual([]);
    expect(missingSelectOptionNames(target, null)).toEqual([]);
  });
});

describe('text style validation (SPEC §5.5 item 5)', () => {
  it.each<[string | null, string, boolean]>([
    ['an@x.vn', 'email', false],
    [' an@x.vn ', 'email', false],
    ['an@x', 'email', true],
    ['an x@y.vn', 'email', true],
    ['', 'email', false],
    [null, 'email', false],
    ['+84 912 345 678', 'phone', false],
    ['(028) 3823-4567', 'phone', false],
    ['0912.345.678', 'phone', false],
    ['12345', 'phone', true],
    ['gọi sau', 'phone', true],
    ['+84 912 345 678 999 999', 'phone', true],
    ['anything', 'plain', false],
    ['anything', 'url', false],
  ])('%j as %s → invalid %s', (value, style, invalid) => {
    const parsed = textOptionsSchema.parse({ style: { type: style } });
    expect(isInvalidForTextStyle(value, parsed.style.type)).toBe(invalid);
  });

  it('reads phone numbers', () => {
    expect(isPhoneNumber('0912345678')).toBe(true);
    expect(isPhoneNumber('091234567a')).toBe(false);
  });
});

describe('fixtures', () => {
  it('parse like the registry does', () => {
    expect(numberOptionsSchema.parse({}).style.type).toBe('plain');
    expect(datetimeOptionsSchema.parse({}).style.format).toBe('yyyy-MM-dd');
    expect(userOptionsSchema.parse({}).multiple).toBe(true);
  });
});
