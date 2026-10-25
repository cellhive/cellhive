import { describe, expect, it } from 'vitest';

import {
  DATETIME_FORMATS,
  DATETIME_OPERATORS,
  datetimeFieldType,
  datetimeOptionsSchema,
  FieldValueError,
  isDateOnlyFormat,
} from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const en = { locale: 'en-US', timeZone: 'America/New_York' };
const gb = { locale: 'en-GB', timeZone: 'Europe/London' };

const opts = (input: unknown) => datetimeOptionsSchema.parse(input);
const dateOnly = opts({});
const withTime = opts({ style: { format: 'dd/MM/yyyy HH:mm' } });
const withTimeHcm = opts({ style: { format: 'dd/MM/yyyy HH:mm' }, timezone: 'Asia/Ho_Chi_Minh' });
const withTimeNy = opts({ style: { format: 'yyyy-MM-dd HH:mm' }, timezone: 'America/New_York' });
const dateOnlyNy = opts({ style: { format: 'MM/dd/yyyy' }, timezone: 'America/New_York' });

describe('datetime options', () => {
  it('defaults to a date-only yyyy-MM-dd format', () => {
    expect(dateOnly).toEqual({ style: { format: 'yyyy-MM-dd' } });
  });

  it('lists the fixed formats and which of them carry a time', () => {
    expect(DATETIME_FORMATS).toEqual([
      'yyyy-MM-dd',
      'dd/MM/yyyy',
      'MM/dd/yyyy',
      'yyyy-MM-dd HH:mm',
      'dd/MM/yyyy HH:mm',
      'MM/dd/yyyy HH:mm',
    ]);
    expect(DATETIME_FORMATS.map((format) => isDateOnlyFormat(format))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it.each([
    [{ style: { format: 'dd/MM/yyyy' }, default_value: '2026-09-25' }],
    [{ style: { format: 'dd/MM/yyyy HH:mm' }, default_value: '2026-09-25T02:00:00.000Z' }],
    [{ style: { format: 'dd/MM/yyyy HH:mm' }, default_value: '2026-09-25T09:00:00+07:00' }],
    [{ default_value: { $slot: 'record_created_time' } }],
    [{ default_value: null }],
    [{ timezone: 'Europe/London' }],
  ])('accepts %j', (input) => {
    expect(datetimeOptionsSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    [{ style: { format: 'dd.MM.yyyy' } }],
    [{ timezone: 'Mars/Olympus' }],
    [{ default_value: '2026-09-25T02:00:00.000Z' }],
    [{ style: { format: 'yyyy-MM-dd HH:mm' }, default_value: '2026-09-25' }],
    [{ default_value: '2026-02-30' }],
    [{ default_value: { $slot: 'current_user' } }],
    [{ default_value: 1 }],
  ])('rejects %j', (input) => {
    expect(datetimeOptionsSchema.safeParse(input).success).toBe(false);
  });

  it('stores the IANA primary name of the zone (T819: Postgres has no Asia/Saigon)', () => {
    expect(datetimeOptionsSchema.parse({ timezone: 'Asia/Saigon' }).timezone).toBe(
      'Asia/Ho_Chi_Minh',
    );
    expect(datetimeOptionsSchema.parse({ timezone: 'US/Eastern' }).timezone).toBe(
      'America/New_York',
    );
  });
});

describe('datetime options.reminder (T547, CONTRACTS §22.6)', () => {
  const FLD = 'fld_ReminderOwner001';
  const U1 = 'usr_ReminderUser0001';
  const U2 = 'usr_ReminderUser0002';
  const users = Array.from(
    { length: 51 },
    (_, i) => `usr_ReminderMany${String(i).padStart(4, '0')}`,
  );

  it.each([
    [
      'field user, defaults filled',
      { reminder: { recipients: 'field_user', user_field_id: FLD } },
      {
        style: { format: 'yyyy-MM-dd' },
        reminder: {
          offset_minutes: 0,
          time_of_day: null,
          recipients: 'field_user',
          user_field_id: FLD,
        },
      },
    ],
    [
      'fixed users, a day before at 09:00 explicitly',
      {
        timezone: 'Asia/Ho_Chi_Minh',
        reminder: {
          recipients: 'users',
          user_ids: [U1, U2],
          offset_minutes: -1440,
          time_of_day: '09:00',
        },
      },
      {
        style: { format: 'yyyy-MM-dd' },
        timezone: 'Asia/Ho_Chi_Minh',
        reminder: {
          offset_minutes: -1440,
          time_of_day: '09:00',
          recipients: 'users',
          user_ids: [U1, U2],
        },
      },
    ],
    [
      'a field with a time, 15 minutes before',
      {
        style: { format: 'dd/MM/yyyy HH:mm' },
        reminder: { recipients: 'users', user_ids: [U1], offset_minutes: -15 },
      },
      {
        style: { format: 'dd/MM/yyyy HH:mm' },
        reminder: { offset_minutes: -15, time_of_day: null, recipients: 'users', user_ids: [U1] },
      },
    ],
    ['off (null)', { reminder: null }, { style: { format: 'yyyy-MM-dd' }, reminder: null }],
    [
      'bounds of the offset',
      {
        reminder: {
          recipients: 'users',
          user_ids: [U1],
          offset_minutes: 43_200,
          time_of_day: '23:59',
        },
      },
      {
        style: { format: 'yyyy-MM-dd' },
        reminder: {
          offset_minutes: 43_200,
          time_of_day: '23:59',
          recipients: 'users',
          user_ids: [U1],
        },
      },
    ],
    [
      '50 users',
      { reminder: { recipients: 'users', user_ids: users.slice(0, 50) } },
      {
        style: { format: 'yyyy-MM-dd' },
        reminder: {
          offset_minutes: 0,
          time_of_day: null,
          recipients: 'users',
          user_ids: users.slice(0, 50),
        },
      },
    ],
  ])('accepts %s', (_label, input, expected) => {
    expect(datetimeOptionsSchema.parse(input)).toEqual(expected);
  });

  it.each([
    [
      'an offset past 30 days',
      { recipients: 'users', user_ids: [U1], offset_minutes: 43_201 },
      'reminder.offset_minutes',
    ],
    [
      'an offset before −30 days',
      { recipients: 'users', user_ids: [U1], offset_minutes: -43_201 },
      'reminder.offset_minutes',
    ],
    [
      'a fractional offset',
      { recipients: 'users', user_ids: [U1], offset_minutes: 1.5 },
      'reminder.offset_minutes',
    ],
    [
      'a time of day 24:00',
      { recipients: 'users', user_ids: [U1], time_of_day: '24:00' },
      'reminder.time_of_day',
    ],
    [
      'a time of day 9:00',
      { recipients: 'users', user_ids: [U1], time_of_day: '9:00' },
      'reminder.time_of_day',
    ],
    ['an unknown recipient kind', { recipients: 'everyone' }, 'reminder.recipients'],
    ['field_user without a field', { recipients: 'field_user' }, 'reminder.user_field_id'],
    [
      'field_user with user_ids',
      { recipients: 'field_user', user_field_id: FLD, user_ids: [U1] },
      'reminder',
    ],
    ['users without ids', { recipients: 'users' }, 'reminder.user_ids'],
    ['users with an empty list', { recipients: 'users', user_ids: [] }, 'reminder.user_ids'],
    ['users with 51 ids', { recipients: 'users', user_ids: users }, 'reminder.user_ids'],
    ['users with a duplicate', { recipients: 'users', user_ids: [U1, U1] }, 'reminder.user_ids'],
    ['users with a malformed id', { recipients: 'users', user_ids: ['u1'] }, 'reminder.user_ids.0'],
    [
      'users with a field id',
      { recipients: 'users', user_ids: [U1], user_field_id: FLD },
      'reminder',
    ],
    ['an unknown key', { recipients: 'users', user_ids: [U1], channel: 'email' }, 'reminder'],
  ])('rejects %s', (_label, reminder, path) => {
    const parsed = datetimeOptionsSchema.safeParse({ reminder });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain(path);
  });

  it('refuses a time of day on a field with a time (it reminds at the value itself)', () => {
    const parsed = datetimeOptionsSchema.safeParse({
      style: { format: 'yyyy-MM-dd HH:mm' },
      reminder: { recipients: 'users', user_ids: [U1], time_of_day: '09:00' },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'reminder.time_of_day',
    ]);
  });
});

describe('datetime pgType', () => {
  it.each([
    [dateOnly, 'date'],
    [opts({ style: { format: 'MM/dd/yyyy' } }), 'date'],
    [withTime, 'timestamptz'],
    [withTimeNy, 'timestamptz'],
  ])('%j -> %s', (options, expected) => {
    expect(datetimeFieldType.pgType(options, { collation: 'und-x-icu' })).toBe(expected);
  });
});

describe('datetime validate (json write)', () => {
  it.each([
    [withTime, '2026-09-25T02:00:00.000Z'],
    [withTime, '2026-09-25T09:00:00+07:00'],
    [withTime, '2026-09-25T09:00+0700'],
    [withTime, 1790301600000],
    [withTime, null],
    [dateOnly, '2026-09-25'],
    [dateOnly, '2024-02-29'],
    [dateOnly, null],
  ])('accepts %#', (options, value) => {
    expect(datetimeFieldType.validate(value, options)).toEqual({ ok: true });
  });

  it.each([
    [withTime, '2026-09-25', 'EXPECTED_DATETIME'],
    [withTime, '2026-09-25T09:00:00', 'EXPECTED_DATETIME'],
    [withTime, '25/09/2026 09:00', 'EXPECTED_DATETIME'],
    [withTime, '2026-13-25T09:00:00Z', 'EXPECTED_DATETIME'],
    [withTime, Number.NaN, 'EXPECTED_DATETIME'],
    [withTime, 9e15, 'EXPECTED_DATETIME'],
    [withTime, true, 'EXPECTED_DATETIME'],
    [dateOnly, '2026-09-25T02:00:00.000Z', 'EXPECTED_DATE'],
    [dateOnly, '2026-02-29', 'EXPECTED_DATE'],
    [dateOnly, '2026-9-5', 'EXPECTED_DATE'],
    [dateOnly, 1790301600000, 'EXPECTED_DATE'],
    [dateOnly, undefined, 'EXPECTED_DATE'],
  ])('rejects %#', (options, value, code) => {
    const result = datetimeFieldType.validate(value, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe(code);
  });
});

describe('datetime storage', () => {
  it.each([
    [withTime, '2026-09-25T09:00:00+07:00', '2026-09-25T02:00:00.000Z'],
    [withTime, '2026-09-25T02:00:00Z', '2026-09-25T02:00:00.000Z'],
    [withTime, 1790301600000, '2026-09-25T02:00:00.000Z'],
    [withTime, null, null],
    [dateOnly, '2026-09-25', '2026-09-25'],
    [dateOnly, null, null],
  ])('toStorage %#', (options, value, expected) => {
    expect(datetimeFieldType.toStorage(value, options)).toBe(expected);
  });

  it('toStorage throws on invalid input', () => {
    expect(() => datetimeFieldType.toStorage('nope', withTime)).toThrow(FieldValueError);
  });

  it.each([
    [withTime, new Date('2026-09-25T02:00:00.000Z'), '2026-09-25T02:00:00.000Z'],
    [withTime, '2026-09-25 02:00:00+00', '2026-09-25T02:00:00.000Z'],
    [withTime, '2026-09-25T09:00:00+07:00', '2026-09-25T02:00:00.000Z'],
    [withTime, 'garbage', null],
    [withTime, new Date(Number.NaN), null],
    [withTime, null, null],
    [dateOnly, '2026-09-25', '2026-09-25'],
    [dateOnly, new Date(Date.UTC(2026, 8, 25)), '2026-09-25'],
    [dateOnly, 'garbage', null],
    [dateOnly, new Date(Number.NaN), null],
    [dateOnly, 17, null],
    [dateOnly, undefined, null],
  ])('fromStorage %#', (options, stored, expected) => {
    expect(datetimeFieldType.fromStorage(stored, options)).toBe(expected);
  });

  it('round-trips', () => {
    for (const [options, value] of [
      [withTime, '2026-09-25T02:00:00.000Z'],
      [dateOnly, '2026-09-25'],
      [withTime, null],
    ] as const) {
      expect(
        datetimeFieldType.fromStorage(datetimeFieldType.toStorage(value, options), options),
      ).toBe(value);
    }
  });
});

describe('datetime typecast', () => {
  it.each([
    // C§2 example: wall time in the field timezone.
    ['vi dd/MM HH:mm in HCM', withTimeHcm, vi, '25/09/2026 09:00', '2026-09-25T02:00:00.000Z'],
    [
      'uses ctx timezone when the field has none',
      withTime,
      vi,
      '25/09/2026 09:00',
      '2026-09-25T02:00:00.000Z',
    ],
    [
      'field timezone wins over ctx',
      withTimeHcm,
      en,
      '2026-09-25 09:00',
      '2026-09-25T02:00:00.000Z',
    ],
    ['en-US reads month first', withTimeNy, en, '09/25/2026 09:00', '2026-09-25T13:00:00.000Z'],
    ['en-GB reads day first', withTime, gb, '25/09/2026 09:00', '2026-09-25T08:00:00.000Z'],
    [
      'date only into a datetime field = midnight',
      withTimeHcm,
      vi,
      '2026-09-25',
      '2026-09-24T17:00:00.000Z',
    ],
    [
      'ISO local without offset',
      withTimeHcm,
      vi,
      '2026-09-25T09:00:30',
      '2026-09-25T02:00:30.000Z',
    ],
    [
      'ISO with offset passes through',
      withTimeHcm,
      vi,
      '2026-09-25T09:00:00+07:00',
      '2026-09-25T02:00:00.000Z',
    ],
    ['epoch ms', withTimeHcm, vi, 1790301600000, '2026-09-25T02:00:00.000Z'],
    ['dotted day-first date', withTimeHcm, vi, '25.09.2026', '2026-09-24T17:00:00.000Z'],
    ['with seconds', withTimeHcm, vi, '25/09/2026 09:00:59', '2026-09-25T02:00:59.000Z'],
    ['single-digit day and month', withTimeHcm, vi, '5/9/2026 7:05', '2026-09-05T00:05:00.000Z'],
    // DST in New York (March 2026 switch).
    ['NY before spring-forward', withTimeNy, en, '2026-03-08 01:30', '2026-03-08T06:30:00.000Z'],
    ['NY gap is shifted forward', withTimeNy, en, '2026-03-08 02:30', '2026-03-08T07:30:00.000Z'],
    ['NY after spring-forward', withTimeNy, en, '2026-03-08 03:30', '2026-03-08T07:30:00.000Z'],
    ['NY summer', withTimeNy, en, '2026-07-04 12:00', '2026-07-04T16:00:00.000Z'],
    ['empty string', withTime, vi, '', null],
    ['null', withTime, vi, null, null],
    // Date-only fields.
    ['C§1.4 example', dateOnly, vi, '25/09/2026', '2026-09-25'],
    [
      'date-only keeps the wall date and drops the time',
      dateOnly,
      vi,
      '25/09/2026 23:30',
      '2026-09-25',
    ],
    [
      'date-only from an instant uses the field timezone',
      dateOnly,
      vi,
      '2026-09-24T18:00:00Z',
      '2026-09-25',
    ],
    ['date-only from an instant in NY', dateOnlyNy, vi, '2026-09-25T02:00:00Z', '2026-09-24'],
    ['date-only from epoch ms', dateOnly, vi, 1790301600000, '2026-09-25'],
    ['date-only en-US month first', dateOnlyNy, en, '09/25/2026', '2026-09-25'],
    ['date-only ISO', dateOnly, en, '2026-09-25', '2026-09-25'],
    ['date-only year-first slash', dateOnly, en, '2026/09/25', '2026-09-25'],
  ])('%s', (_label, options, ctx, input, expected) => {
    expect(datetimeFieldType.typecast(input, options, ctx)).toEqual({
      ok: true,
      value: expected,
      unknownOptions: [],
    });
  });

  it.each([
    [withTime, vi, '31/02/2026'],
    [withTime, vi, '25/13/2026'],
    [withTime, en, '25/09/2026'],
    [withTime, vi, '25/09/2026 24:00'],
    [withTime, vi, '25/09/2026 09:60'],
    [withTime, vi, 'tomorrow'],
    [withTime, vi, true],
    [withTime, vi, Number.POSITIVE_INFINITY],
    [dateOnly, vi, '2026-02-30'],
    [dateOnly, vi, {}],
  ])('rejects %#', (options, ctx, input) => {
    const result = datetimeFieldType.typecast(input, options, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues[0]?.code).toBe(
        options === dateOnly ? 'EXPECTED_DATE' : 'EXPECTED_DATETIME',
      );
  });
});

describe('datetime formatText', () => {
  it.each([
    ['dd/MM/yyyy HH:mm in HCM', withTimeHcm, en, '2026-09-25T02:00:00.000Z', '25/09/2026 09:00'],
    ['ctx timezone', withTime, vi, '2026-09-25T02:00:00.000Z', '25/09/2026 09:00'],
    ['NY summer (EDT)', withTimeNy, vi, '2026-09-25T02:00:00.000Z', '2026-09-24 22:00'],
    ['NY before DST', withTimeNy, vi, '2026-03-08T06:59:00.000Z', '2026-03-08 01:59'],
    ['NY after DST', withTimeNy, vi, '2026-03-08T07:00:00.000Z', '2026-03-08 03:00'],
    [
      'MM/dd/yyyy HH:mm',
      opts({ style: { format: 'MM/dd/yyyy HH:mm' } }),
      en,
      '2026-09-25T13:05:00.000Z',
      '09/25/2026 09:05',
    ],
    ['date-only yyyy-MM-dd', dateOnly, vi, '2026-09-25', '2026-09-25'],
    [
      'date-only dd/MM/yyyy',
      opts({ style: { format: 'dd/MM/yyyy' } }),
      vi,
      '2026-09-25',
      '25/09/2026',
    ],
    ['date-only MM/dd/yyyy ignores timezone', dateOnlyNy, vi, '2026-09-25', '09/25/2026'],
    ['null', withTime, vi, null, ''],
    ['unparseable value is returned as-is', withTime, vi, 'n/a', 'n/a'],
    ['unparseable date-only value', dateOnly, vi, 'n/a', 'n/a'],
  ])('%s', (_label, options, ctx, value, expected) => {
    expect(datetimeFieldType.formatText(value, options, ctx)).toBe(expected);
  });
});

describe('datetime operators', () => {
  it('uses the datetime operator group', () => {
    expect(datetimeFieldType.filterOperators(dateOnly)).toEqual(DATETIME_OPERATORS);
    expect(DATETIME_OPERATORS).toEqual([
      'is',
      'before',
      'after',
      'on_or_before',
      'on_or_after',
      'between',
      'is_empty',
      'is_not_empty',
    ]);
  });
});
