import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../../../lib/api/client';
import { draftOf, updateBody, validateDraft, createBody, type FieldDraft } from '../../../draft';
import {
  normalizePath,
  onlyReminderErrors,
  REMINDER_OFF,
  reminderDraftOf,
  reminderIssues,
  reminderOptionOf,
  reminderOptionsOf,
  serverReminderIssues,
  userIndexOf,
  type ReminderDraft,
} from '../draft';

import type { DateReminderOption, FieldDto } from '@cellhive/contracts';

const NOW = '2026-10-17T00:00:00.000Z';
const OWNER = 'fld_Owner00000000001';
const USER_A = 'usr_0123456789ABCDEF';
const USER_B = 'usr_Other00000000001';

function dueField(options: Record<string, unknown>): FieldDto {
  return {
    id: 'fld_Due0000000000001',
    table_id: 'tbl_Tasks00000000001',
    name: 'Due',
    type: 'datetime',
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

const ON: ReminderDraft = { ...REMINDER_OFF, enabled: true, userFieldId: OWNER };

describe('reminderDraftOf ↔ reminderOptionOf', () => {
  it.each<[string, DateReminderOption, boolean]>([
    [
      '1 day before at 09:00 to a field',
      {
        offset_minutes: -1440,
        time_of_day: '09:00',
        recipients: 'field_user',
        user_field_id: OWNER,
      },
      true,
    ],
    [
      'on the day, default time, to members',
      { offset_minutes: 0, time_of_day: null, recipients: 'users', user_ids: [USER_A, USER_B] },
      true,
    ],
    [
      '90 minutes after a time',
      { offset_minutes: 90, time_of_day: null, recipients: 'field_user', user_field_id: OWNER },
      false,
    ],
  ])('%s', (_label, option, dateOnly) => {
    const draft = reminderDraftOf(option);
    expect(draft.enabled).toBe(true);
    expect(draft.saved).toBe(true);
    expect(reminderOptionOf(draft, dateOnly)).toEqual(option);
  });

  it('off: null / absent', () => {
    expect(reminderDraftOf(null)).toBe(REMINDER_OFF);
    expect(reminderDraftOf(undefined)).toBe(REMINDER_OFF);
    expect(reminderOptionOf(REMINDER_OFF, true)).toBeNull();
  });

  it('sends no time of day for a field with a time', () => {
    expect(reminderOptionOf({ ...ON, timeOfDay: '08:30' }, false)).toMatchObject({
      time_of_day: null,
    });
    expect(reminderOptionOf({ ...ON, timeOfDay: '08:30' }, true)).toMatchObject({
      time_of_day: '08:30',
    });
  });

  it('a bad amount gives a non-integer offset (the schema reports it too)', () => {
    expect(reminderOptionOf({ ...ON, amount: 'x' }, true)?.['offset_minutes']).toBeNaN();
    expect(
      reminderOptionOf({ ...ON, direction: 'at', amount: 'x' }, true)?.['offset_minutes'],
    ).toBe(0);
  });

  it('the reminder key: object when on, null only to turn a saved one off', () => {
    expect(reminderOptionsOf(REMINDER_OFF, true)).toEqual({});
    expect(reminderOptionsOf({ ...ON, enabled: false, saved: true }, true)).toEqual({
      reminder: null,
    });
    expect(reminderOptionsOf(ON, true)).toEqual({
      reminder: {
        offset_minutes: -1440,
        time_of_day: null,
        recipients: 'field_user',
        user_field_id: OWNER,
      },
    });
  });
});

describe('reminderIssues', () => {
  it.each<[string, Partial<ReminderDraft>, [string, string][]]>([
    ['off: nothing', { enabled: false, amount: '' }, []],
    ['valid', {}, []],
    ['on time ignores the amount', { direction: 'at', amount: '' }, []],
    ['empty amount', { amount: '' }, [['options.reminder.offset_minutes', 'REMINDER_AMOUNT']]],
    ['zero', { amount: '0' }, [['options.reminder.offset_minutes', 'REMINDER_AMOUNT']]],
    ['31 days', { amount: '31' }, [['options.reminder.offset_minutes', 'REMINDER_AMOUNT']]],
    ['720 hours is fine', { amount: '720', unit: 'hours' }, []],
    ['decimal', { amount: '1.5' }, [['options.reminder.offset_minutes', 'REMINDER_AMOUNT']]],
    [
      'no field',
      { userFieldId: '' },
      [['options.reminder.user_field_id', 'REMINDER_FIELD_REQUIRED']],
    ],
    [
      'no member',
      { recipients: 'users' },
      [['options.reminder.user_ids', 'REMINDER_USERS_REQUIRED']],
    ],
    [
      '51 members',
      {
        recipients: 'users',
        userIds: Array.from({ length: 51 }, (_, i) => `usr_${String(i).padStart(16, '0')}`),
      },
      [['options.reminder.user_ids', 'REMINDER_USERS_TOO_MANY']],
    ],
  ])('%s', (_label, patch, expected) => {
    expect(
      reminderIssues({ ...ON, ...patch }).map((issue) => [issue.path, issue.detail.code]),
    ).toEqual(expected);
  });

  it('gives the largest amount of the unit', () => {
    expect(reminderIssues({ ...ON, amount: '800', unit: 'hours' })[0]?.detail.params).toEqual({
      max: 720,
    });
  });
});

describe('server 422 details', () => {
  const error = new ApiError({
    status: 422,
    code: 'VALIDATION_FAILED',
    errors: [
      { path: 'options.reminder.user_ids[1]', code: 'USER_NOT_FOUND', message: 'x' },
      {
        path: 'options.reminder.user_field_id',
        code: 'INVALID_FIELD_TYPE',
        message: 'x',
        params: { type: 'text', expected: ['user', 'created_by'] },
      },
    ],
  });

  it('maps them to form paths', () => {
    expect(serverReminderIssues(error)).toEqual([
      { path: 'options.reminder.user_ids.1', detail: { code: 'USER_NOT_FOUND' } },
      {
        path: 'options.reminder.user_field_id',
        detail: {
          code: 'INVALID_FIELD_TYPE',
          params: { type: 'text', expected: ['user', 'created_by'] },
        },
      },
    ]);
    expect(onlyReminderErrors(error)).toBe(true);
  });

  it('leaves other errors to the dialog', () => {
    const other = new ApiError({
      status: 422,
      code: 'VALIDATION_FAILED',
      errors: [
        { path: 'name', code: 'TOO_LONG', message: 'x' },
        { path: 'options.reminder.time_of_day', code: 'INVALID_VALUE', message: 'x' },
      ],
    });
    expect(serverReminderIssues(other).map((issue) => issue.path)).toEqual([
      'options.reminder.time_of_day',
    ]);
    expect(onlyReminderErrors(other)).toBe(false);
    expect(onlyReminderErrors(new ApiError({ status: 409, code: 'NAME_CONFLICT' }))).toBe(false);
    expect(serverReminderIssues(new Error('network'))).toEqual([]);
  });

  it.each([
    ['options.reminder.user_ids[12]', 'options.reminder.user_ids.12', 12],
    ['options.reminder.user_field_id', 'options.reminder.user_field_id', null],
  ])('%s', (path, normalized, index) => {
    expect(normalizePath(path)).toBe(normalized);
    expect(userIndexOf(normalized)).toBe(index);
  });
});

describe('the field draft with a reminder', () => {
  const saved = dueField({
    style: { format: 'dd/MM/yyyy' },
    default_value: null,
    reminder: {
      offset_minutes: -1440,
      time_of_day: '09:00',
      recipients: 'field_user',
      user_field_id: OWNER,
    },
  });
  const plain = dueField({ style: { format: 'dd/MM/yyyy' }, default_value: null });

  it('an untouched field sends nothing', () => {
    expect(updateBody(saved, draftOf(saved))).toBeNull();
    expect(updateBody(plain, draftOf(plain))).toBeNull();
  });

  it('turning a reminder on sends it with the other options', () => {
    const draft: FieldDraft = {
      ...draftOf(plain),
      reminder: { ...ON, timeOfDay: '09:00' },
    };
    expect(validateDraft(draft).issues).toEqual([]);
    expect(updateBody(plain, draft)).toEqual({
      options: {
        style: { format: 'dd/MM/yyyy' },
        default_value: null,
        reminder: {
          offset_minutes: -1440,
          time_of_day: '09:00',
          recipients: 'field_user',
          user_field_id: OWNER,
        },
      },
    });
  });

  it('turning it off sends reminder: null', () => {
    const draft = draftOf(saved);
    expect(
      updateBody(saved, { ...draft, reminder: { ...draft.reminder, enabled: false } }),
    ).toEqual({
      options: { style: { format: 'dd/MM/yyyy' }, default_value: null, reminder: null },
    });
  });

  it('switching to a format with a time drops the time of day', () => {
    const draft = draftOf(saved);
    expect(
      updateBody(saved, {
        ...draft,
        datetime: { ...draft.datetime, style: { format: 'dd/MM/yyyy HH:mm' } },
      }),
    ).toEqual({
      options: {
        style: { format: 'dd/MM/yyyy HH:mm' },
        default_value: null,
        reminder: {
          offset_minutes: -1440,
          time_of_day: null,
          recipients: 'field_user',
          user_field_id: OWNER,
        },
      },
    });
  });

  it('a new date field without a reminder has no reminder key; problems block saving', () => {
    const fresh: FieldDraft = { ...draftOf(), name: 'Due', type: 'datetime' };
    expect(createBody(fresh).options).not.toHaveProperty('reminder');
    const broken: FieldDraft = { ...fresh, reminder: { ...ON, userFieldId: '', amount: '' } };
    expect(validateDraft(broken).issues.map((issue) => [issue.path, issue.detail.code])).toEqual([
      ['options.reminder.offset_minutes', 'REMINDER_AMOUNT'],
      ['options.reminder.user_field_id', 'REMINDER_FIELD_REQUIRED'],
    ]);
  });
});
