/**
 * BACKLOG T547: the pure parts of date reminders — who a recipient cell
 * names, where a capped scan leaves its boundary, and what re-arms a
 * reminder (`reminderKey`).
 */
import { describe, expect, it } from 'vitest';

import {
  nextBoundary,
  reminderRecipientsOf,
  resumePointOf,
} from '../../src/notifications/index.js';
import { reminderKey, reminderOf } from '../../src/schema/reminders.js';

import type { Id } from '@cellhive/contracts';

const U1: Id<'usr'> = 'usr_UnitReminderU001';
const U2: Id<'usr'> = 'usr_UnitReminderU002';
const R1: Id<'rec'> = 'rec_UnitReminderR001';
const R2: Id<'rec'> = 'rec_UnitReminderR002';
const R3: Id<'rec'> = 'rec_UnitReminderR003';

describe('reminderRecipientsOf', () => {
  it.each<[string, unknown, Id<'usr'>[]]>([
    ['an empty cell', null, []],
    ['a missing cell', undefined, []],
    ['an empty list', [], []],
    ['a user field', [{ id: U1, name: 'One' }, { id: U2 }], [U1, U2]],
    ['a created_by cell', { id: U1, name: 'One', email: 'one@example.test' }, [U1]],
    ['duplicates', [{ id: U1 }, { id: U1 }, { id: U2 }], [U1, U2]],
    ['malformed entries', [{ id: 'nope' }, 'usr_x', 7, null, { email: 'a@b.c' }, { id: U2 }], [U2]],
    ['another id kind', [{ id: 'grp_UnitReminderG001' }], []],
  ])('%s', (_label, cell, expected) => {
    expect(reminderRecipientsOf(cell)).toEqual(expected);
  });
});

describe('nextBoundary / resumePointOf (keyset, QA S5b M7)', () => {
  const D = Date.parse('2027-08-01T09:00:00Z');

  it('a capped scan leaves its moment and last reminded record', () => {
    const boundary = nextBoundary(D, R2);
    expect(boundary.dueAt.getTime()).toBe(D);
    expect(boundary.recordIds).toEqual([R2]);
    expect(resumePointOf({ dueAt: D, recordIds: boundary.recordIds })).toEqual({ due: D, id: R2 });
  });

  it.each<[string, { dueAt: number | null; recordIds: Id<'rec'>[] }, unknown]>([
    ['no boundary', { dueAt: null, recordIds: [] }, null],
    ['a moment without records (malformed)', { dueAt: D, recordIds: [] }, null],
    // Rows written before T560 listed every record reminded of: the last is the keyset.
    ['a pre-T560 list of ids', { dueAt: D, recordIds: [R1, R2, R3] }, { due: D, id: R3 }],
  ])('%s', (_label, previous, expected) => {
    expect(resumePointOf(previous)).toEqual(expected);
  });
});

describe('reminderOf / reminderKey', () => {
  const live = { deleted_at: null, purged_at: null };
  const reminder = { recipients: 'users', user_ids: [U1] };
  const field = (options: object, extra: object = {}) => ({
    type: 'datetime',
    options,
    ...live,
    ...extra,
  });

  it('reads the reminder of a datetime field only, defaults filled', () => {
    expect(reminderOf({ type: 'datetime', options: { reminder } })).toEqual({
      offset_minutes: 0,
      time_of_day: null,
      recipients: 'users',
      user_ids: [U1],
    });
    expect(reminderOf({ type: 'text', options: { reminder } })).toBeNull();
    expect(reminderOf({ type: 'datetime', options: { reminder: null } })).toBeNull();
    expect(reminderOf({ type: 'datetime', options: {} })).toBeNull();
    expect(
      reminderOf({ type: 'datetime', options: { reminder: { recipients: 'all' } } }),
    ).toBeNull();
  });

  it('is null when the field does not remind (off, trash, purged, other type, absent)', () => {
    expect(reminderKey(null)).toBeNull();
    expect(reminderKey(field({}))).toBeNull();
    expect(reminderKey(field({ reminder }, { deleted_at: new Date() }))).toBeNull();
    expect(reminderKey(field({ reminder }, { purged_at: new Date() }))).toBeNull();
    expect(reminderKey(field({ reminder }, { type: 'text' }))).toBeNull();
    expect(reminderKey(field({ reminder }))).not.toBeNull();
  });

  it('changes with what decides when and whom, not with anything else', () => {
    const base = reminderKey(field({ style: { format: 'yyyy-MM-dd' }, reminder }));
    expect(reminderKey(field({ style: { format: 'yyyy-MM-dd' }, reminder }))).toBe(base);
    // Spelled-out defaults are the same reminder.
    expect(
      reminderKey(
        field({
          style: { format: 'yyyy-MM-dd' },
          reminder: { ...reminder, offset_minutes: 0, time_of_day: null },
        }),
      ),
    ).toBe(base);
    // A default value does not matter.
    expect(
      reminderKey(
        field({ style: { format: 'yyyy-MM-dd' }, default_value: '2027-01-01', reminder }),
      ),
    ).toBe(base);
    for (const changed of [
      { style: { format: 'yyyy-MM-dd' }, reminder: { ...reminder, offset_minutes: -15 } },
      { style: { format: 'yyyy-MM-dd' }, reminder: { ...reminder, time_of_day: '08:00' } },
      { style: { format: 'yyyy-MM-dd' }, reminder: { ...reminder, user_ids: [U2] } },
      {
        style: { format: 'yyyy-MM-dd' },
        reminder: { recipients: 'field_user', user_field_id: 'fld_UnitReminderF001' },
      },
      { style: { format: 'yyyy-MM-dd HH:mm' }, reminder },
      { style: { format: 'yyyy-MM-dd' }, timezone: 'Asia/Ho_Chi_Minh', reminder },
    ]) {
      expect(reminderKey(field(changed))).not.toBe(base);
    }
  });
});
