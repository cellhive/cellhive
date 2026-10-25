import { describe, expect, it } from 'vitest';

import {
  ACTIVE_NOTIFICATION_TYPES,
  automationBatchOverflowViewDataSchema,
  isMandatoryNotificationType,
  MANDATORY_NOTIFICATION_TYPES,
  markNotificationsReadSchema,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DATA_SCHEMAS,
  NOTIFICATION_BUFFER_FLUSH_DELAY_MS,
  NOTIFICATION_BUFFER_KINDS,
  NOTIFICATION_BUFFER_STALE_MS,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_FOLLOWERS_MAX,
  NOTIFICATION_RECORD_IDS_MAX,
  NOTIFICATION_TELEGRAM_BATCH_MS,
  NOTIFICATION_TELEGRAM_MAX_ATTEMPTS,
  NOTIFICATION_TELEGRAM_MAX_CHARS,
  NOTIFICATION_TELEGRAM_MAX_ITEMS,
  NOTIFICATION_TYPES,
  TELEGRAM_BOT_MESSAGES_PER_SECOND,
  TELEGRAM_CHAT_MESSAGES_PER_SECOND,
  TELEGRAM_DELIVERY_FAILURE_CODES,
  TELEGRAM_DELIVERY_SKIP_CODES,
  notificationListQuerySchema,
  S5B_NOTIFICATION_TYPES,
  updateNotificationPreferencesSchema,
  updateNotificationSettingsSchema,
} from '../src/notifications.js';

const NTF = 'ntf_A1b2C3d4E5f6G7h8';
const BSE = 'bse_A1b2C3d4E5f6G7h8';
const AUT = 'aut_A1b2C3d4E5f6G7h8';
const RUN = 'run_A1b2C3d4E5f6G7h8';
const REC = 'rec_A1b2C3d4E5f6G7h8';
const FLD = 'fld_A1b2C3d4E5f6G7h8';
const USR = 'usr_A1b2C3d4E5f6G7h8';
const JOB = 'job_A1b2C3d4E5f6G7h8';
const recs = (n: number) =>
  Array.from({ length: n }, (_, i) => `rec_A1b2C3d4E5f6G${String(i).padStart(3, '0')}`);

describe('notification catalogue (CONTRACTS §22)', () => {
  it('has a default for every type and channel; in-app on by default', () => {
    for (const type of NOTIFICATION_TYPES) {
      for (const channel of NOTIFICATION_CHANNELS) {
        expect(typeof NOTIFICATION_DEFAULTS[type][channel]).toBe('boolean');
      }
      expect(NOTIFICATION_DEFAULTS[type].in_app).toBe(true);
    }
  });

  it('every produced type and every S5b type has a data schema, and nothing else', () => {
    expect(Object.keys(NOTIFICATION_DATA_SCHEMAS).sort()).toEqual(
      [...new Set([...ACTIVE_NOTIFICATION_TYPES, ...S5B_NOTIFICATION_TYPES])].sort(),
    );
    for (const type of [...ACTIVE_NOTIFICATION_TYPES, ...S5B_NOTIFICATION_TYPES]) {
      expect(NOTIFICATION_TYPES).toContain(type);
    }
  });

  it('produces import.finished from T548 (CONTRACTS §22.1), email off by default', () => {
    expect(ACTIVE_NOTIFICATION_TYPES).toContain('import.finished');
    expect(NOTIFICATION_DEFAULTS['import.finished']).toEqual({
      in_app: true,
      email: false,
      telegram: false,
    });
    expect(isMandatoryNotificationType('import.finished')).toBe(false);
  });

  it('produces date.reminder from T547 (CONTRACTS §22.1, §22.6), email on by default', () => {
    expect(ACTIVE_NOTIFICATION_TYPES).toContain('date.reminder');
    expect(NOTIFICATION_DEFAULTS['date.reminder']).toEqual({
      in_app: true,
      email: true,
      telegram: true,
    });
    expect(isMandatoryNotificationType('date.reminder')).toBe(false);
  });

  it('has the telegram channel (T550), whose default is the email default of each type', () => {
    expect(NOTIFICATION_CHANNELS).toEqual(['in_app', 'email', 'telegram']);
    for (const type of NOTIFICATION_TYPES) {
      expect([type, NOTIFICATION_DEFAULTS[type].telegram]).toEqual([
        type,
        NOTIFICATION_DEFAULTS[type].email,
      ]);
    }
  });

  it('Telegram delivery constants (CONTRACTS §22.4)', () => {
    expect(NOTIFICATION_TELEGRAM_BATCH_MS).toBe(5_000);
    expect(NOTIFICATION_TELEGRAM_MAX_ITEMS).toBe(10);
    expect(NOTIFICATION_TELEGRAM_MAX_CHARS).toBe(4_096);
    expect(NOTIFICATION_TELEGRAM_MAX_ATTEMPTS).toBe(5);
    expect(TELEGRAM_BOT_MESSAGES_PER_SECOND).toBe(25);
    expect(TELEGRAM_CHAT_MESSAGES_PER_SECOND).toBe(1);
    expect(TELEGRAM_DELIVERY_SKIP_CODES).toContain('telegram_not_configured');
    expect(TELEGRAM_DELIVERY_SKIP_CODES).toContain('channel_error');
    expect(TELEGRAM_DELIVERY_FAILURE_CODES).toEqual([
      'telegram_blocked',
      'telegram_rejected',
      'telegram_invalid_token',
      'telegram_unavailable',
    ]);
  });

  it('produces record.followed_changed from T545 (CONTRACTS §22.1), email off by default', () => {
    expect(ACTIVE_NOTIFICATION_TYPES).toContain('record.followed_changed');
    expect(NOTIFICATION_DEFAULTS['record.followed_changed']).toEqual({
      in_app: true,
      email: false,
      telegram: false,
    });
    expect(isMandatoryNotificationType('record.followed_changed')).toBe(false);
    expect(NOTIFICATION_FOLLOWERS_MAX).toBe(1000);
  });

  it('produces record.assigned from T544 (CONTRACTS §22.1), email on by default', () => {
    expect(ACTIVE_NOTIFICATION_TYPES).toContain('record.assigned');
    expect(NOTIFICATION_DEFAULTS['record.assigned']).toEqual({
      in_app: true,
      email: true,
      telegram: true,
    });
    expect(isMandatoryNotificationType('record.assigned')).toBe(false);
  });

  it('S5b types keep their email defaults (CONTRACTS §22.1)', () => {
    expect(S5B_NOTIFICATION_TYPES.map((type) => NOTIFICATION_DEFAULTS[type].email)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('buffer constants (CONTRACTS §22.2)', () => {
    expect(NOTIFICATION_BUFFER_KINDS).toEqual(['assigned', 'followed']);
    expect(NOTIFICATION_BUFFER_FLUSH_DELAY_MS).toEqual({ assigned: 10_000, followed: 60_000 });
    expect(NOTIFICATION_BUFFER_STALE_MS).toBe(600_000);
    expect(NOTIFICATION_RECORD_IDS_MAX).toBe(20);
  });

  it.each([
    ['automation.disabled', true],
    ['approval.task_assigned', true],
    ['automation.message', false],
    ['automation.batch_overflow', false],
  ] as const)('%s mandatory: %s', (type, mandatory) => {
    expect(isMandatoryNotificationType(type)).toBe(mandatory);
  });

  it('mandatory types are declared types', () => {
    for (const type of MANDATORY_NOTIFICATION_TYPES) expect(NOTIFICATION_TYPES).toContain(type);
  });
});

describe('notification data', () => {
  it.each([
    ['automation.disabled', { automation_id: AUT, reason: 'circuit_breaker' }, true],
    ['automation.disabled', { automation_id: AUT, reason: 'other' }, false],
    ['automation.disabled', { automation_id: AUT, reason: 'circuit_breaker', value: 1 }, false],
    [
      'automation.batch_overflow',
      { automation_id: AUT, run_id: RUN, batch_id: 'req_x', limit: 500 },
      true,
    ],
    [
      'automation.batch_overflow',
      { automation_id: AUT, run_id: RUN, batch_id: 'req_x', limit: 0 },
      false,
    ],
    ['automation.message', { automation_id: AUT, run_id: RUN, title: 'Hi', body: '' }, true],
    ['automation.message', { automation_id: AUT, run_id: RUN, title: '', body: '' }, false],
    [
      'automation.message',
      { automation_id: AUT, run_id: RUN, title: 'x'.repeat(201), body: '' },
      false,
    ],
    [
      'automation.message',
      { automation_id: AUT, run_id: RUN, title: 'x', body: 'y'.repeat(2001) },
      false,
    ],
    // S5b (T542): record.assigned
    ['record.assigned', { batch_id: null, count: 1, record_ids: [REC], field_ids: [FLD] }, true],
    [
      'record.assigned',
      { batch_id: 'job_x', count: 4000, record_ids: recs(20), field_ids: [FLD] },
      true,
    ],
    [
      'record.assigned',
      { batch_id: 'job_x', count: 4000, record_ids: recs(21), field_ids: [FLD] },
      false,
    ],
    ['record.assigned', { batch_id: null, count: 1, record_ids: recs(2), field_ids: [FLD] }, false],
    ['record.assigned', { batch_id: null, count: 0, record_ids: [REC], field_ids: [FLD] }, false],
    ['record.assigned', { batch_id: null, count: 1, record_ids: [], field_ids: [FLD] }, false],
    ['record.assigned', { batch_id: null, count: 1, record_ids: [REC], field_ids: [] }, false],
    ['record.assigned', { batch_id: '', count: 1, record_ids: [REC], field_ids: [FLD] }, false],
    [
      'record.assigned',
      { batch_id: null, count: 1, record_ids: [REC], field_ids: [FLD], title: 'x' },
      false,
    ],
    // record.followed_changed
    ['record.followed_changed', { field_ids: [FLD], change_count: 3, actor_ids: [USR] }, true],
    ['record.followed_changed', { field_ids: [FLD], change_count: 1, actor_ids: [] }, true],
    [
      'record.followed_changed',
      { field_ids: [FLD], change_count: 9, actor_ids: Array.from({ length: 6 }, () => USR) },
      false,
    ],
    ['record.followed_changed', { field_ids: [], change_count: 1, actor_ids: [] }, false],
    ['record.followed_changed', { field_ids: [FLD], change_count: 0, actor_ids: [] }, false],
    [
      'record.followed_changed',
      { field_ids: [FLD], change_count: 1, actor_ids: [], values: { a: 1 } },
      false,
    ],
    // date.reminder: the value of that date field only
    [
      'date.reminder',
      { field_id: FLD, due_at: '2026-10-20T02:00:00.000Z', value: '2026-10-20' },
      true,
    ],
    [
      'date.reminder',
      {
        field_id: FLD,
        due_at: '2026-10-20T01:30:00.000Z',
        value: '2026-10-20T02:00:00.000Z',
      },
      true,
    ],
    ['date.reminder', { field_id: FLD, due_at: '2026-10-20', value: '2026-10-20' }, false],
    [
      'date.reminder',
      { field_id: FLD, due_at: '2026-10-20T02:00:00.000Z', value: 'tomorrow' },
      false,
    ],
    [
      'date.reminder',
      { field_id: REC, due_at: '2026-10-20T02:00:00.000Z', value: '2026-10-20' },
      false,
    ],
    [
      'date.reminder',
      {
        field_id: FLD,
        due_at: '2026-10-20T02:00:00.000Z',
        value: '2026-10-20',
        other: 'x',
      },
      false,
    ],
    // import.finished: counts only
    [
      'import.finished',
      { job_id: JOB, status: 'succeeded', created: 10, updated: 0, failed_rows: 2 },
      true,
    ],
    [
      'import.finished',
      { job_id: JOB, status: 'cancelled', created: 0, updated: 0, failed_rows: 0 },
      true,
    ],
    [
      'import.finished',
      { job_id: JOB, status: 'running', created: 0, updated: 0, failed_rows: 0 },
      false,
    ],
    [
      'import.finished',
      { job_id: JOB, status: 'failed', created: -1, updated: 0, failed_rows: 0 },
      false,
    ],
    [
      'import.finished',
      { job_id: REC, status: 'failed', created: 0, updated: 0, failed_rows: 0 },
      false,
    ],
  ] as const)('%s %j → %s', (type, data, ok) => {
    expect(NOTIFICATION_DATA_SCHEMAS[type].safeParse(data).success).toBe(ok);
  });

  it.each([
    [{ skipped: 4000 }, true],
    [{ skipped: null }, true],
    [{}, true],
    [{ skipped: -1 }, false],
    [{ skipped: 1.5 }, false],
  ])('batch_overflow as read %j → %s', (extra, ok) => {
    expect(
      automationBatchOverflowViewDataSchema.safeParse({
        automation_id: AUT,
        run_id: RUN,
        batch_id: 'job_x',
        limit: 1000,
        ...extra,
      }).success,
    ).toBe(ok);
  });
});

describe('notification API inputs', () => {
  it.each([
    [{ ids: [NTF] }, true],
    [{ all: true }, true],
    [{ all: true, base_id: BSE }, true],
    [{ ids: [] }, false],
    [{ ids: Array.from({ length: 201 }, () => NTF) }, false],
    [{ all: false }, false],
    [{ ids: [NTF], all: true }, false],
    [{ ids: ['rec_A1b2C3d4E5f6G7h8'] }, false],
    [{}, false],
  ])('read %j → %s', (body, ok) => {
    expect(markNotificationsReadSchema.safeParse(body).success).toBe(ok);
  });

  it.each([
    [{ email_frequency: 'daily', daily_hour: 0 }, true],
    [{ daily_hour: 23 }, true],
    [{ email_frequency: 'off' }, true],
    [{}, false],
    [{ daily_hour: 24 }, false],
    [{ daily_hour: 7.5 }, false],
    [{ email_frequency: 'weekly' }, false],
    [{ email_frequency: 'off', muted_bases: [] }, false],
    // T543: the auto-follow switches, alone or with the email settings.
    [{ auto_follow_created: false }, true],
    [{ auto_follow_assigned: true }, true],
    [{ auto_follow_created: true, auto_follow_assigned: false, daily_hour: 6 }, true],
    [{ auto_follow_created: 'false' }, false],
    [{ auto_follow_assigned: null }, false],
    [{ auto_follow_commented: true }, false],
    [{ auto_follow_created: undefined }, false],
  ])('settings %j → %s', (body, ok) => {
    expect(updateNotificationSettingsSchema.safeParse(body).success).toBe(ok);
  });

  it.each([
    [{ items: [{ type: 'automation.message', channel: 'email', enabled: false }] }, true],
    [{ items: [{ type: 'comment.mentioned', channel: 'in_app', enabled: true }] }, true],
    [{ items: [] }, false],
    // T550: the Telegram channel.
    [{ items: [{ type: 'automation.message', channel: 'telegram', enabled: false }] }, true],
    [{ items: [{ type: 'record.assigned', channel: 'telegram', enabled: true }] }, true],
    [{ items: [{ type: 'automation.message', channel: 'sms', enabled: false }] }, false],
    [{ items: [{ type: 'automation.message', channel: 'telegram', enabled: 'no' }] }, false],
    [
      {
        items: Array.from({ length: 13 * 3 }, () => ({
          type: 'automation.message',
          channel: 'telegram',
          enabled: true,
        })),
      },
      true,
    ],
    [
      {
        items: Array.from({ length: 13 * 3 + 1 }, () => ({
          type: 'automation.message',
          channel: 'telegram',
          enabled: true,
        })),
      },
      false,
    ],
    [{ items: [{ type: 'nope', channel: 'email', enabled: false }] }, false],
  ])('preferences %j → %s', (body, ok) => {
    expect(updateNotificationPreferencesSchema.safeParse(body).success).toBe(ok);
  });

  it('list query parses unread and base filter', () => {
    expect(notificationListQuerySchema.parse({ unread: 'true', base_id: BSE })).toMatchObject({
      unread: true,
      base_id: BSE,
      limit: 50,
    });
    expect(notificationListQuerySchema.safeParse({ base_id: 'x' }).success).toBe(false);
  });
});
