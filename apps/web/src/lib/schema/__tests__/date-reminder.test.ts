import { describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import {
  exampleValueOf,
  isDateOnlyField,
  maxAmountOf,
  offsetMinutesOf,
  recipientFieldState,
  reminderDueAt,
  reminderHeaderHints,
  reminderOfField,
  reminderTimingText,
  splitOffset,
  TIME_OF_DAY_STEPS,
  type ReminderOffsetParts,
} from '../date-reminder';

import type { DateReminderOption, FieldDto } from '@cellhive/contracts';

const NOW = '2026-10-17T00:00:00.000Z';

function field(id: `fld_${string}`, overrides: Partial<FieldDto> = {}): FieldDto {
  return {
    id,
    table_id: 'tbl_Tasks00000000001',
    name: id,
    type: 'text',
    options: {},
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const OWNER = field('fld_Owner00000000001', { name: 'Owner', type: 'user' });
const CREATOR = field('fld_Creator000000001', { name: 'Created by', type: 'created_by' });
const NOTE = field('fld_Note000000000001', { name: 'Note' });

describe('splitOffset / offsetMinutesOf', () => {
  it.each<[number, ReminderOffsetParts]>([
    [0, { direction: 'at', amount: 0, unit: 'days' }],
    [-1440, { direction: 'before', amount: 1, unit: 'days' }],
    [-43_200, { direction: 'before', amount: 30, unit: 'days' }],
    [120, { direction: 'after', amount: 2, unit: 'hours' }],
    [-90, { direction: 'before', amount: 90, unit: 'minutes' }],
    [-15, { direction: 'before', amount: 15, unit: 'minutes' }],
    [2880, { direction: 'after', amount: 2, unit: 'days' }],
  ])('%d minutes', (minutes, parts) => {
    expect(splitOffset(minutes)).toEqual(parts);
    expect(offsetMinutesOf(parts)).toBe(minutes);
  });

  it('caps each unit at 30 days', () => {
    expect([maxAmountOf('days'), maxAmountOf('hours'), maxAmountOf('minutes')]).toEqual([
      30, 720, 43_200,
    ]);
  });

  it('offers every half hour of the day', () => {
    expect(TIME_OF_DAY_STEPS).toHaveLength(48);
    expect(TIME_OF_DAY_STEPS[0]).toBe('00:00');
    expect(TIME_OF_DAY_STEPS[19]).toBe('09:30');
    expect(TIME_OF_DAY_STEPS.at(-1)).toBe('23:30');
  });
});

describe('reminderDueAt (as the server dueAt)', () => {
  it.each([
    {
      label: 'date-only, default 09:00 in Ho Chi Minh City, a day before',
      input: {
        dateOnly: true,
        value: '2026-10-24',
        offsetMinutes: -1440,
        timeOfDay: null,
        timeZone: 'Asia/Ho_Chi_Minh',
      },
      due: '2026-10-23T02:00:00.000Z',
    },
    {
      label: 'date-only at 17:30 UTC, on the day',
      input: {
        dateOnly: true,
        value: '2026-10-24',
        offsetMinutes: 0,
        timeOfDay: '17:30',
        timeZone: 'UTC',
      },
      due: '2026-10-24T17:30:00.000Z',
    },
    {
      label: 'a wall time skipped by DST is pushed forward (New York, 2026-03-08 02:30)',
      input: {
        dateOnly: true,
        value: '2026-03-08',
        offsetMinutes: 0,
        timeOfDay: '02:30',
        timeZone: 'America/New_York',
      },
      due: '2026-03-08T07:30:00.000Z',
    },
    {
      label: 'a value with a time, 15 minutes before (no time of day)',
      input: {
        dateOnly: false,
        value: '2026-10-24T10:00:00.000Z',
        offsetMinutes: -15,
        timeOfDay: null,
        timeZone: 'Asia/Ho_Chi_Minh',
      },
      due: '2026-10-24T09:45:00.000Z',
    },
  ])('$label', ({ input, due }) => {
    expect(new Date(reminderDueAt(input) ?? 0).toISOString()).toBe(due);
  });

  it('gives null for a value that is not a date', () => {
    expect(
      reminderDueAt({
        dateOnly: true,
        value: '24/10/2026',
        offsetMinutes: 0,
        timeOfDay: null,
        timeZone: 'UTC',
      }),
    ).toBeNull();
    expect(
      reminderDueAt({
        dateOnly: false,
        value: 'soon',
        offsetMinutes: 0,
        timeOfDay: null,
        timeZone: 'UTC',
      }),
    ).toBeNull();
  });
});

describe('exampleValueOf', () => {
  const now = new Date('2026-10-17T20:00:00.000Z');
  it('is the date a week later in the zone (date-only)', () => {
    // 03:00 on the 18th in Ho Chi Minh City: the 25th a week later.
    expect(exampleValueOf(now, true, 'Asia/Ho_Chi_Minh')).toBe('2026-10-25');
    expect(exampleValueOf(now, true, 'UTC')).toBe('2026-10-24');
  });
  it('is 17:00 that day in the zone (with a time)', () => {
    expect(exampleValueOf(now, false, 'Asia/Ho_Chi_Minh')).toBe('2026-10-25T10:00:00.000Z');
  });
});

describe('reminderOfField / isDateOnlyField / recipientFieldState', () => {
  const reminder: DateReminderOption = {
    offset_minutes: -1440,
    time_of_day: '09:00',
    recipients: 'field_user',
    user_field_id: OWNER.id,
  };
  const due = field('fld_Due0000000000001', {
    type: 'datetime',
    options: { style: { format: 'dd/MM/yyyy' }, reminder },
  });

  it('reads a saved reminder, ignores others', () => {
    expect(reminderOfField(due)).toEqual(reminder);
    expect(reminderOfField({ ...due, options: { style: { format: 'dd/MM/yyyy' } } })).toBeNull();
    expect(reminderOfField({ ...due, options: { reminder: { recipients: 'nobody' } } })).toBeNull();
    expect(reminderOfField({ ...due, type: 'text' })).toBeNull();
  });

  it.each([
    [{ style: { format: 'dd/MM/yyyy' } }, true],
    [{ style: { format: 'yyyy-MM-dd HH:mm' } }, false],
    [{}, true],
  ])('%j is date-only: %s', (options, dateOnly) => {
    expect(isDateOnlyField({ options })).toBe(dateOnly);
  });

  it.each<[readonly FieldDto[], string]>([
    [[OWNER, NOTE], 'ok'],
    [[NOTE], 'missing'],
    [[{ ...OWNER, type: 'text' }], 'wrong_type'],
  ])('recipient field state %#', (fields, state) => {
    expect(recipientFieldState(reminder, fields)).toBe(state);
  });

  it('a members reminder has no field to lose', () => {
    expect(
      recipientFieldState(
        {
          offset_minutes: 0,
          time_of_day: null,
          recipients: 'users',
          user_ids: ['usr_0123456789ABCDEF'],
        },
        [],
      ),
    ).toBe('ok');
  });
});

describe('reminderTimingText / reminderHeaderHints', () => {
  it.each([
    ['en', -1440, '09:00', true, '1 day before, at 09:00'],
    ['en', 0, null, true, 'on the day, at 09:00'],
    ['en', -15, null, false, '15 minutes before'],
    ['en', 120, null, false, '2 hours after'],
    ['en', 0, null, false, 'at the time'],
    ['vi', -2880, '08:30', true, 'trước 2 ngày, lúc 08:30'],
    ['vi', -15, null, false, 'trước 15 phút'],
  ] as const)('%s %d %s', async (language, offset, time, dateOnly, text) => {
    const i18n = await createTestI18n(language);
    const t = i18n.getFixedT(language, 'grid');
    expect(reminderTimingText(t, { offset_minutes: offset, time_of_day: time }, dateOnly)).toBe(
      text,
    );
  });

  const due = field('fld_Due0000000000001', {
    name: 'Due',
    type: 'datetime',
    options: {
      style: { format: 'dd/MM/yyyy' },
      reminder: {
        offset_minutes: -1440,
        time_of_day: null,
        recipients: 'field_user',
        user_field_id: OWNER.id,
      },
    },
  });
  const at = field('fld_Meeting000000001', {
    name: 'Meeting',
    type: 'datetime',
    options: {
      style: { format: 'yyyy-MM-dd HH:mm' },
      reminder: {
        offset_minutes: -15,
        time_of_day: null,
        recipients: 'users',
        user_ids: ['usr_0123456789ABCDEF', 'usr_Other00000000001'],
      },
    },
  });

  it('describes each reminding field (en)', async () => {
    const i18n = await createTestI18n('en');
    const t = i18n.getFixedT('en', 'grid');
    const hints = reminderHeaderHints([due, at, OWNER, CREATOR, NOTE], true, t);
    expect([...hints.keys()]).toEqual([due.id, at.id]);
    expect(hints.get(due.id)).toEqual({
      text: 'Reminder: 1 day before, at 09:00 · to the people in Owner',
      warning: false,
    });
    expect(hints.get(at.id)?.text).toBe('Reminder: 15 minutes before · to 2 members');
  });

  it('warns schema managers of a recipient field that is gone; tells others nothing more', async () => {
    const i18n = await createTestI18n('vi');
    const t = i18n.getFixedT('vi', 'grid');
    const managed = reminderHeaderHints([due, NOTE], true, t).get(due.id);
    expect(managed?.warning).toBe(true);
    expect(managed?.text).toContain('Nhắc hạn không được gửi');
    // A reader may just not see the field: no warning, no name.
    expect(reminderHeaderHints([due, NOTE], false, t).get(due.id)).toEqual({
      text: 'Nhắc hạn: trước 1 ngày, lúc 09:00 · gửi người trong một trường',
      warning: false,
    });
  });
});
