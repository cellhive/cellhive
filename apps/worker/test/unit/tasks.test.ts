import { Writable } from 'node:stream';

import { toEventDocument, EmailSendError } from '@cellhive/server-core';
import { parseCronItems, type JobHelpers } from 'graphile-worker';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_RUNS_CLEANUP_CRON,
  CRON_ITEMS,
  EXPORTS_CLEANUP_CRON,
  IMPORTS_CLEANUP_CRON,
  MAINTENANCE_CLEANUP_CRON,
  NOTIFICATION_BUFFERS_SWEEP_CRON,
  NOTIFICATIONS_CLEANUP_CRON,
  NOTIFICATIONS_DAILY_DIGEST_CRON,
  NOTIFICATIONS_TELEGRAM_POLL_CRON,
  PARTITIONS_MAINTAIN_CRON,
  RECORDS_PURGE_CRON,
  TABLES_PURGE_CRON,
} from '../../src/job-runner.js';
import { createPasswordResetEmailTask } from '../../src/tasks/auth-password-reset-email.js';
import { createAutomationRunTask } from '../../src/tasks/automation-run.js';
import { createEventsDispatchTask } from '../../src/tasks/events-dispatch.js';
import { createNotificationsDeliverTask } from '../../src/tasks/notifications-deliver.js';
import { createNotificationsFanoutTask } from '../../src/tasks/notifications-fanout.js';
import { createNotificationsFlushTask } from '../../src/tasks/notifications-flush.js';
import { createNotificationsTelegramPollTask } from '../../src/tasks/notifications-telegram-poll.js';

import type {
  AutomationDispatchResult,
  RunEngineResult,
  Db,
  DispatchResult,
  NotificationEmailDelivery,
  NotificationEmailOutcome,
  NotificationTelegramDelivery,
  NotificationTelegramOutcome,
  EventKey,
  EventRecord,
  NotificationFanout,
  NotificationFlusher,
  OrganizationsRepository,
  OrgScope,
  PasswordResetsRepository,
  UsersRepository,
} from '@cellhive/server-core';

const EVT = 'evt_UnitEvent0000001';
const ORG = 'org_UnitOrg000000001';
const CREATED_AT = '2026-09-20T03:15:00.123456Z';

function capture() {
  const chunks: string[] = [];
  const logger = pino(
    { level: 'debug', messageKey: 'msg' },
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    }),
  );
  const lines = () =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, raw: () => chunks.join('') };
}

class FakeDispatcher {
  readonly calls: { org: string; key: EventKey }[] = [];
  dispatched = false;

  constructor(
    private readonly event: EventRecord | undefined,
    private readonly automations: readonly AutomationDispatchResult[] = [],
  ) {}

  dispatch(scope: OrgScope, key: EventKey): Promise<DispatchResult> {
    this.calls.push({ org: scope.organizationId, key });
    if (this.event === undefined) return Promise.resolve({ status: 'missing' });
    const event = toEventDocument(this.event);
    if (this.dispatched) return Promise.resolve({ status: 'redelivered', event });
    this.dispatched = true;
    return Promise.resolve({ status: 'dispatched', event, automations: this.automations });
  }
}

const helpers = { job: { id: '17' } } as unknown as JobHelpers;

const storedEvent: EventRecord = {
  id: EVT,
  organization_id: ORG,
  type: 'record.updated',
  entity_type: 'record',
  entity_id: 'rec_UnitRecord000001',
  actor_type: 'user',
  actor_id: 'usr_UnitUser00000001',
  payload: { changes: { fld_name: { from: 'a', to: 'Nguyễn Văn Ánh' } } },
  causation: null,
  created_at: new Date(CREATED_AT),
  dispatched_at: null,
};

describe('events.dispatch', () => {
  it('dispatches the event in its organization and logs identifiers and outcomes only', async () => {
    const dispatcher = new FakeDispatcher(storedEvent, [
      { automationId: 'aut_UnitAutomation01', outcome: 'queued', runId: 'run_UnitRun000000001' },
      { automationId: 'aut_UnitAutomation02', outcome: 'condition_false' },
    ]);
    const { logger, lines, raw } = capture();
    const task = createEventsDispatchTask({ dispatcher, logger });

    await task({ event_id: EVT, organization_id: ORG, created_at: CREATED_AT }, helpers);
    await task({ event_id: EVT, organization_id: ORG, created_at: CREATED_AT }, helpers);

    expect(dispatcher.calls).toEqual([
      { org: ORG, key: { id: EVT, createdAt: CREATED_AT } },
      { org: ORG, key: { id: EVT, createdAt: CREATED_AT } },
    ]);
    expect(lines().map((line) => line.redelivery)).toEqual([false, true]);
    expect(lines()[0]).toMatchObject({
      msg: 'event dispatched',
      job_id: '17',
      event_id: EVT,
      event_type: 'record.updated',
      entity_id: 'rec_UnitRecord000001',
      automations: [
        {
          automation_id: 'aut_UnitAutomation01',
          outcome: 'queued',
          run_id: 'run_UnitRun000000001',
        },
        { automation_id: 'aut_UnitAutomation02', outcome: 'condition_false' },
      ],
    });
    expect(lines()[1]).not.toHaveProperty('automations');
    expect(raw()).not.toContain('Nguyễn');
  });

  it.each([
    ['missing organization', { event_id: EVT, created_at: CREATED_AT }],
    [
      'bad event id',
      { event_id: 'rec_UnitRecord000001', organization_id: ORG, created_at: CREATED_AT },
    ],
    ['bad timestamp', { event_id: EVT, organization_id: ORG, created_at: 'yesterday' }],
  ])('skips a malformed payload (%s) without touching the database', async (_name, payload) => {
    const dispatcher = new FakeDispatcher(storedEvent);
    const { logger, lines } = capture();
    const task = createEventsDispatchTask({ dispatcher, logger });
    await task(payload as never, helpers);
    expect(dispatcher.calls).toEqual([]);
    expect(lines()[0]).toMatchObject({
      level: 50,
      msg: 'events.dispatch: malformed payload, skipped',
    });
  });

  it('completes with a warning when the event is gone', async () => {
    const dispatcher = new FakeDispatcher(undefined);
    const { logger, lines } = capture();
    const task = createEventsDispatchTask({ dispatcher, logger });
    await task({ event_id: EVT, organization_id: ORG, created_at: CREATED_AT }, helpers);
    expect(dispatcher.calls).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ level: 40 });
  });
});

describe('auth.password_reset_email', () => {
  function taskWith(mailer: null) {
    const lookups: string[] = [];
    const { logger, lines, raw } = capture();
    const users = {
      findByEmail: (email: string) => {
        lookups.push(email);
        return Promise.resolve(undefined);
      },
    } as unknown as UsersRepository;
    const task = createPasswordResetEmailTask({
      db: {} as Db,
      users,
      organizations: {} as OrganizationsRepository,
      passwordResets: {} as PasswordResetsRepository,
      mailer,
      publicUrl: 'https://cellhive.test',
      logger,
    });
    return { task, lookups, lines, raw };
  }

  it('does nothing without SMTP and never logs the address', async () => {
    const { task, lookups, lines, raw } = taskWith(null);
    await task(
      { email: 'secret.person@example.test', request_id: null, ip: null, user_agent: null },
      helpers,
    );
    expect(lookups).toEqual([]);
    expect(lines()[0]).toMatchObject({ outcome: 'skipped', job_id: '17' });
    expect(raw()).not.toContain('secret.person');
  });

  it('drops a malformed payload', async () => {
    const { task, lookups, lines } = taskWith(null);
    await task({ email: '' } as never, helpers);
    expect(lookups).toEqual([]);
    expect(lines()[0]).toMatchObject({ level: 40, msg: 'malformed password reset email payload' });
  });
});

describe('cron', () => {
  it('schedules partitions.maintain daily at 00:15 UTC', () => {
    const [item] = parseCronItems([...CRON_ITEMS]);
    expect(PARTITIONS_MAINTAIN_CRON).toBe('15 0 * * *');
    expect(item).toMatchObject({ task: 'partitions.maintain', identifier: 'partitions.maintain' });
    const digest = (hour: number, min: number) => ({ min, hour, date: 1, month: 1, dow: 1 });
    expect(item?.match(digest(0, 15))).toBe(true);
    expect(item?.match(digest(0, 16))).toBe(false);
    expect(item?.match(digest(12, 15))).toBe(false);
  });

  it('schedules maintenance.cleanup hourly at minute 25', () => {
    const item = parseCronItems([...CRON_ITEMS]).find(
      (cron) => cron.identifier === 'maintenance.cleanup',
    );
    expect(MAINTENANCE_CLEANUP_CRON).toBe('25 * * * *');
    expect(item).toMatchObject({ task: 'maintenance.cleanup' });
    const digest = (hour: number, min: number) => ({ min, hour, date: 1, month: 1, dow: 1 });
    expect(item?.match(digest(3, 25))).toBe(true);
    expect(item?.match(digest(17, 25))).toBe(true);
    expect(item?.match(digest(3, 26))).toBe(false);
  });

  it('schedules exports.cleanup hourly at minute 35', () => {
    const item = parseCronItems([...CRON_ITEMS]).find(
      (cron) => cron.identifier === 'exports.cleanup',
    );
    expect(EXPORTS_CLEANUP_CRON).toBe('35 * * * *');
    expect(item).toMatchObject({ task: 'exports.cleanup' });
    const digest = (hour: number, min: number) => ({ min, hour, date: 1, month: 1, dow: 1 });
    expect(item?.match(digest(3, 35))).toBe(true);
    expect(item?.match(digest(3, 25))).toBe(false);
  });

  it('schedules imports.cleanup hourly at minute 45', () => {
    const item = parseCronItems([...CRON_ITEMS]).find(
      (cron) => cron.identifier === 'imports.cleanup',
    );
    expect(IMPORTS_CLEANUP_CRON).toBe('45 * * * *');
    expect(item).toMatchObject({ task: 'imports.cleanup' });
    const digest = (hour: number, min: number) => ({ min, hour, date: 1, month: 1, dow: 1 });
    expect(item?.match(digest(3, 45))).toBe(true);
    expect(item?.match(digest(3, 35))).toBe(false);
  });

  it('schedules records.purge daily at 01:45 UTC (T408)', () => {
    const item = parseCronItems([...CRON_ITEMS]).find(
      (cron) => cron.identifier === 'records.purge',
    );
    expect(RECORDS_PURGE_CRON).toBe('45 1 * * *');
    expect(item).toMatchObject({ task: 'records.purge' });
    const digest = (hour: number, min: number) => ({ min, hour, date: 1, month: 1, dow: 1 });
    expect(item?.match(digest(1, 45))).toBe(true);
    expect(item?.match(digest(2, 45))).toBe(false);
  });

  it('schedules tables.purge daily at 01:15 UTC, before records.purge (T461)', () => {
    const item = parseCronItems([...CRON_ITEMS]).find((cron) => cron.identifier === 'tables.purge');
    expect(TABLES_PURGE_CRON).toBe('15 1 * * *');
    expect(item).toMatchObject({ task: 'tables.purge' });
    const digest = (hour: number, min: number) => ({ min, hour, date: 1, month: 1, dow: 1 });
    expect(item?.match(digest(1, 15))).toBe(true);
    expect(item?.match(digest(1, 45))).toBe(false);
  });

  it('schedules notifications.cleanup daily at 02:30 UTC (T511)', () => {
    const item = parseCronItems([...CRON_ITEMS]).find(
      (cron) => cron.identifier === 'notifications.cleanup',
    );
    expect(NOTIFICATIONS_CLEANUP_CRON).toBe('30 2 * * *');
    expect(item).toMatchObject({ task: 'notifications.cleanup' });
    const digest = (hour: number, min: number) => ({ min, hour, date: 1, month: 1, dow: 1 });
    expect(item?.match(digest(2, 30))).toBe(true);
    expect(item?.match(digest(3, 30))).toBe(false);
  });
});

describe('notifications.cleanup buffer sweep cron (T542)', () => {
  it('runs every 5 minutes with buffers_only, next to the daily run', () => {
    const items = parseCronItems([...CRON_ITEMS]).filter(
      (cron) => cron.task === 'notifications.cleanup',
    );
    expect(items.map((item) => item.identifier).sort()).toEqual([
      'notifications.cleanup',
      'notifications.cleanup.buffers',
    ]);
    const sweep = items.find((item) => item.identifier === 'notifications.cleanup.buffers');
    expect(NOTIFICATION_BUFFERS_SWEEP_CRON).toBe('*/5 * * * *');
    expect(sweep?.payload).toEqual({ buffers_only: true });
    const at = (hour: number, min: number) => ({ min, hour, date: 1, month: 1, dow: 1 });
    expect(sweep?.match(at(3, 0))).toBe(true);
    expect(sweep?.match(at(3, 25))).toBe(true);
    expect(sweep?.match(at(3, 26))).toBe(false);
    const daily = items.find((item) => item.identifier === 'notifications.cleanup');
    expect(daily?.payload ?? {}).toEqual({});
  });
});

describe('notifications.flush (T542)', () => {
  function flusherOf(outcome: Awaited<ReturnType<NotificationFlusher['flush']>>) {
    const calls: unknown[] = [];
    const flusher = {
      flush: (payload: unknown, context: unknown) => {
        calls.push([payload, context]);
        return Promise.resolve(outcome);
      },
    } as unknown as NotificationFlusher;
    return { flusher, calls };
  }

  it('skips a malformed payload without flushing', async () => {
    const { logger, lines } = capture();
    const { flusher, calls } = flusherOf({ status: 'empty' });
    const task = createNotificationsFlushTask({ flusher, logger });
    await task({ organization_id: ORG, kind: 'nope', group_key: 'x' } as never, helpers);
    await task({ organization_id: ORG, kind: 'assigned', group_key: '' } as never, helpers);
    expect(calls).toEqual([]);
    expect(lines().map((line) => line.msg)).toEqual([
      'notifications.flush: malformed payload, skipped',
      'notifications.flush: malformed payload, skipped',
    ]);
  });

  it('flushes with the job id and logs counts only', async () => {
    const { logger, lines } = capture();
    const { flusher, calls } = flusherOf({
      status: 'flushed',
      rows: 3,
      requests: 2,
      recorded: 2,
      skipped: { cannot_read_record: 1 },
    });
    const task = createNotificationsFlushTask({ flusher, logger });
    const payload = { organization_id: ORG, kind: 'assigned', group_key: 'job_x' } as const;
    await task(payload, helpers);
    expect(calls).toEqual([[payload, { jobId: '17' }]]);
    expect(lines()[0]).toMatchObject({
      level: 30,
      msg: 'notification buffer flushed',
      job_id: '17',
      org_id: ORG,
      kind: 'assigned',
      status: 'flushed',
      rows: 3,
      recorded: 2,
      skipped: { cannot_read_record: 1 },
    });
  });

  it('logs an error when no grouper handles the kind (rows kept)', async () => {
    const { logger, lines } = capture();
    const { flusher } = flusherOf({ status: 'no_grouper', rows: 4 });
    const task = createNotificationsFlushTask({ flusher, logger });
    await task({ organization_id: ORG, kind: 'followed', group_key: 'rec_x' }, helpers);
    expect(lines()[0]).toMatchObject({
      level: 50,
      msg: 'notifications.flush: no grouper for this kind, rows kept',
      rows: 4,
    });
  });
});

describe('notifications.telegram_poll (T549)', () => {
  it('runs every minute, once, without payload', () => {
    const item = parseCronItems([...CRON_ITEMS]).find(
      (cron) => cron.identifier === 'notifications.telegram_poll',
    );
    expect(NOTIFICATIONS_TELEGRAM_POLL_CRON).toBe('* * * * *');
    expect(item).toMatchObject({ task: 'notifications.telegram_poll' });
    expect(item?.payload ?? {}).toEqual({});
    expect(item?.options.maxAttempts).toBe(1);
    const at = (hour: number, min: number) => ({ min, hour, date: 1, month: 1, dow: 1 });
    expect(item?.match(at(1, 7))).toBe(true);
  });

  it('polls the bot of the payload and logs the outcome and counts only', async () => {
    const { logger, lines, raw } = capture();
    const calls: unknown[] = [];
    const task = createNotificationsTelegramPollTask({
      db: {} as Db,
      logger,
      poller: {
        poll: (org, secret) => {
          calls.push([org, secret]);
          return Promise.resolve({
            outcome: 'done',
            updates: 2,
            linked: 1,
            refused: 1,
            stopped: 0,
            ignored: 0,
          });
        },
      },
    });
    await task({ organization_id: ORG, secret_id: 'sec_UnitSecret000001' }, helpers);
    expect(calls).toEqual([[ORG, 'sec_UnitSecret000001']]);
    expect(lines()[0]).toMatchObject({
      level: 30,
      msg: 'telegram notification bot polled',
      job_id: '17',
      org_id: ORG,
      secret_id: 'sec_UnitSecret000001',
      outcome: 'done',
      linked: 1,
      refused: 1,
    });
    expect(Object.keys(lines()[0] ?? {})).not.toContain('token');
    expect(raw()).not.toMatch(/chat|start=/u);
  });
});

describe('automation.runs_cleanup cron (T518)', () => {
  it('runs daily at 02:45 UTC', () => {
    const item = parseCronItems([...CRON_ITEMS]).find(
      (cron) => cron.identifier === 'automation.runs_cleanup',
    );
    expect(AUTOMATION_RUNS_CLEANUP_CRON).toBe('45 2 * * *');
    expect(item).toMatchObject({ task: 'automation.runs_cleanup' });
    const at = (hour: number, min: number) => ({ min, hour, date: 1, month: 1, dow: 1 });
    expect(item?.match(at(2, 45))).toBe(true);
    expect(item?.match(at(3, 45))).toBe(false);
  });
});

describe('notifications.daily_digest cron (T512)', () => {
  it('runs every hour at minute 0 (whole hours of each time zone)', () => {
    const item = parseCronItems([...CRON_ITEMS]).find(
      (cron) => cron.identifier === 'notifications.daily_digest',
    );
    expect(NOTIFICATIONS_DAILY_DIGEST_CRON).toBe('0 * * * *');
    expect(item).toMatchObject({ task: 'notifications.daily_digest' });
    const at = (hour: number, min: number) => ({ min, hour, date: 1, month: 1, dow: 1 });
    expect(item?.match(at(1, 0))).toBe(true);
    expect(item?.match(at(23, 0))).toBe(true);
    expect(item?.match(at(1, 30))).toBe(false);
  });
});

describe('notifications.deliver (T512)', () => {
  const payload = {
    organization_id: ORG,
    user_id: 'usr_UnitUser00000001',
    reason: 'immediate',
  } as const;
  const deliveryOf = (outcome: NotificationEmailOutcome) => {
    const calls: unknown[] = [];
    const delivery = {
      deliver: (input: unknown) => {
        calls.push(input);
        return Promise.resolve(outcome);
      },
    } as unknown as NotificationEmailDelivery;
    return { delivery, calls };
  };
  const telegramOf = (outcome: NotificationTelegramOutcome) => {
    const calls: unknown[] = [];
    const telegram = {
      deliver: (input: unknown) => {
        calls.push(input);
        return Promise.resolve(outcome);
      },
    } as unknown as NotificationTelegramDelivery;
    return { telegram, calls };
  };
  const idle = telegramOf({ status: 'nothing' });

  it('skips a malformed payload', async () => {
    const { logger, lines } = capture();
    const { delivery, calls } = deliveryOf({ status: 'nothing' });
    await createNotificationsDeliverTask({ delivery, telegram: idle.telegram, logger })(
      { organization_id: ORG, user_id: 'nope', reason: 'weekly' } as never,
      helpers,
    );
    expect(calls).toEqual([]);
    expect(lines()[0]).toMatchObject({
      level: 50,
      msg: 'notifications.deliver: malformed payload, skipped',
    });
  });

  it('logs counts of a sent email, never content', async () => {
    const { logger, lines } = capture();
    const { delivery, calls } = deliveryOf({
      status: 'sent',
      sent: 3,
      skipped: { muted: 1 },
      more: false,
    });
    await createNotificationsDeliverTask({ delivery, telegram: idle.telegram, logger })(
      payload,
      helpers,
    );
    expect(calls).toEqual([payload]);
    expect(lines()[0]).toMatchObject({
      msg: 'notification email sent',
      org_id: ORG,
      status: 'sent',
      sent: 3,
      skipped: { muted: 1 },
    });
  });

  it('throws on a temporary failure so the job is retried; a rejection is only logged', async () => {
    const temporary = new EmailSendError('smtp_temporary', 'later', {
      retryable: true,
      reason: 'temporary',
      smtp: { code: 451, enhanced: '4.3.0' },
    });
    const retry = deliveryOf({ status: 'retry', attempts: 2, error: temporary });
    await expect(
      createNotificationsDeliverTask({
        delivery: retry.delivery,
        telegram: idle.telegram,
        logger: capture().logger,
      })(payload, helpers),
    ).rejects.toBe(temporary);

    const { logger, lines } = capture();
    const rejected = new EmailSendError('smtp_rejected', 'no', {
      retryable: false,
      reason: 'rejected',
      smtp: { code: 550, enhanced: '5.1.1' },
    });
    const failed = deliveryOf({ status: 'failed', failed: 1, error: rejected });
    await createNotificationsDeliverTask({
      delivery: failed.delivery,
      telegram: idle.telegram,
      logger,
    })(payload, helpers);
    expect(lines()[0]).toMatchObject({
      level: 40,
      msg: 'notification email not sent',
      code: 'smtp_rejected',
      smtp_code: 550,
    });
  });
});

describe('notifications.deliver, Telegram channel (T550)', () => {
  const payload = {
    organization_id: ORG,
    user_id: 'usr_UnitUser00000001',
    reason: 'immediate',
    channel: 'telegram',
  } as const;
  const emailNever = {
    deliver: () => Promise.reject(new Error('the email delivery must not run')),
  } as unknown as NotificationEmailDelivery;
  const telegramOf = (outcome: NotificationTelegramOutcome) => {
    const calls: unknown[] = [];
    const telegram = {
      deliver: (input: unknown) => {
        calls.push(input);
        return Promise.resolve(outcome);
      },
    } as unknown as NotificationTelegramDelivery;
    return { telegram, calls };
  };

  it('runs the Telegram delivery only, and logs counts of a sent message', async () => {
    const { logger, lines } = capture();
    const { telegram, calls } = telegramOf({
      status: 'sent',
      sent: 3,
      shown: 3,
      skipped: { muted: 1 },
      more: false,
    });
    await createNotificationsDeliverTask({ delivery: emailNever, telegram, logger })(
      payload,
      helpers,
    );
    expect(calls).toEqual([payload]);
    expect(lines()[0]).toMatchObject({
      level: 30,
      msg: 'notification Telegram message sent',
      channel: 'telegram',
      org_id: ORG,
      status: 'sent',
      sent: 3,
      shown: 3,
      skipped: { muted: 1 },
    });
  });

  it('a job of before T550 (no channel) is an email job', async () => {
    const email = {
      calls: [] as unknown[],
      deliver(input: unknown) {
        this.calls.push(input);
        return Promise.resolve({ status: 'nothing' } as NotificationEmailOutcome);
      },
    };
    const never = {
      deliver: () => Promise.reject(new Error('the Telegram delivery must not run')),
    } as unknown as NotificationTelegramDelivery;
    await createNotificationsDeliverTask({
      delivery: email as unknown as NotificationEmailDelivery,
      telegram: never,
      logger: capture().logger,
    })({ organization_id: ORG, user_id: 'usr_UnitUser00000001', reason: 'immediate' }, helpers);
    expect(email.calls).toHaveLength(1);
  });

  it('rejects an unknown channel as malformed', async () => {
    const { logger, lines } = capture();
    const { telegram, calls } = telegramOf({ status: 'nothing' });
    await createNotificationsDeliverTask({ delivery: emailNever, telegram, logger })(
      { ...payload, channel: 'sms' } as never,
      helpers,
    );
    expect(calls).toEqual([]);
    expect(lines()[0]).toMatchObject({ level: 50 });
  });

  it('throws on a temporary failure (retried), logs failures and deferrals by code only', async () => {
    const retry = telegramOf({ status: 'retry', attempts: 2, cause: 'server_error' });
    await expect(
      createNotificationsDeliverTask({
        delivery: emailNever,
        telegram: retry.telegram,
        logger: capture().logger,
      })(payload, helpers),
    ).rejects.toMatchObject({ name: 'NotificationTelegramRetryError', reason: 'server_error' });

    const failedLog = capture();
    const failed = telegramOf({
      status: 'failed',
      failed: 2,
      code: 'telegram_blocked',
      skipped: { channel_error: 4 },
      channelError: true,
      more: false,
    });
    await createNotificationsDeliverTask({
      delivery: emailNever,
      telegram: failed.telegram,
      logger: failedLog.logger,
    })(payload, helpers);
    expect(failedLog.lines()[0]).toMatchObject({
      level: 40,
      msg: 'notification Telegram message not sent',
      code: 'telegram_blocked',
      failed: 2,
      channel_error: true,
      skipped: { channel_error: 4 },
    });

    const deferredLog = capture();
    const deferred = telegramOf({
      status: 'deferred',
      pending: 3,
      retryAt: new Date('2026-10-17T00:00:02.000Z'),
      reason: 'rate_limited',
    });
    await createNotificationsDeliverTask({
      delivery: emailNever,
      telegram: deferred.telegram,
      logger: deferredLog.logger,
    })(payload, helpers);
    expect(deferredLog.lines()[0]).toMatchObject({
      level: 30,
      msg: 'notification Telegram message deferred',
      reason: 'rate_limited',
      retry_at: '2026-10-17T00:00:02.000Z',
    });

    const skippedLog = capture();
    const skipped = telegramOf({
      status: 'skipped',
      skipped: { telegram_not_configured: 2 },
      more: false,
    });
    await createNotificationsDeliverTask({
      delivery: emailNever,
      telegram: skipped.telegram,
      logger: skippedLog.logger,
    })(payload, helpers);
    expect(skippedLog.lines()[0]).toMatchObject({
      msg: 'notification Telegram deliveries skipped',
      skipped: { telegram_not_configured: 2 },
    });
  });
});

describe('notifications.fanout (T511)', () => {
  it('skips a malformed payload without running the fan-out or logging data', async () => {
    const { logger, lines, raw } = capture();
    let runs = 0;
    const fanout = {
      run: () => {
        runs += 1;
        return Promise.resolve({ written: [], skipped: [] });
      },
    } as unknown as NotificationFanout;
    const task = createNotificationsFanoutTask({ fanout, logger });
    await task(
      { organization_id: ORG, type: 'nope', data: { secret: 'value-xyz' } } as never,
      helpers,
    );
    expect(runs).toBe(0);
    expect(lines()[0]).toMatchObject({
      level: 50,
      msg: 'notifications.fanout: malformed payload, skipped',
    });
    expect(raw()).not.toContain('value-xyz');
  });

  it('logs counts by reason, never the data', async () => {
    const { logger, lines, raw } = capture();
    const fanout = {
      run: () =>
        Promise.resolve({
          written: [
            {
              userId: 'usr_UnitUser00000001',
              id: 'ntf_UnitNotif0000001',
              inApp: true,
              emailQueued: true,
              telegramQueued: true,
            },
          ],
          skipped: [
            { userId: 'usr_UnitUser00000002', reason: 'cannot_read_base' },
            { userId: 'usr_UnitUser00000003', reason: 'cannot_read_base' },
          ],
        }),
    } as unknown as NotificationFanout;
    const task = createNotificationsFanoutTask({ fanout, logger });
    await task(
      {
        organization_id: ORG,
        type: 'automation.message',
        base_id: 'bse_UnitBase00000001',
        table_id: null,
        entity_type: 'automation',
        entity_id: 'aut_UnitAuto00000001',
        actor: null,
        group_key: null,
        recipients: { user_ids: ['usr_UnitUser00000001'], base_admins: false },
        requires: { record_id: null, field_ids: [] },
        skip_actor: false,
        data: {
          automation_id: 'aut_UnitAuto00000001',
          run_id: 'run_UnitRun000000001',
          title: 'secret-title',
          body: 'secret-body',
        },
      },
      helpers,
    );
    expect(lines()[0]).toMatchObject({
      msg: 'notifications fanned out',
      recorded: 1,
      in_app: 1,
      email_queued: 1,
      telegram_queued: 1,
      skipped: { cannot_read_base: 2 },
    });
    expect(raw()).not.toContain('secret-');
  });
});

describe('automation.run (BACKLOG T505)', () => {
  const RUN = 'run_UnitRun000000001';
  const job = {
    job: {
      id: '18',
      task_identifier: 'automation.run',
      payload: { organization_id: ORG, run_id: RUN },
      priority: 0,
      attempts: 1,
      max_attempts: 25,
      key: null,
      flags: null,
      job_queue_id: null,
    },
  } as unknown as JobHelpers;

  function engineOf(result: RunEngineResult) {
    const calls: { org: string; run: string; task: string }[] = [];
    return {
      calls,
      engine: {
        execute: (scope: OrgScope, runId: string, deferrable: { task_identifier: string }) => {
          calls.push({ org: scope.organizationId, run: runId, task: deferrable.task_identifier });
          return Promise.resolve(result);
        },
      },
    };
  }

  it.each<[RunEngineResult, number, Record<string, unknown>]>([
    [{ status: 'succeeded' }, 30, { status: 'succeeded' }],
    [
      { status: 'failed', code: 'permission_denied', step: 'act_1' },
      40,
      { status: 'failed', code: 'permission_denied', step: 'act_1' },
    ],
    [
      { status: 'retry_scheduled', step: 'act_2', delayMs: 10_000 },
      30,
      { status: 'retry_scheduled', step: 'act_2', retry_in_ms: 10_000 },
    ],
    [{ status: 'deferred' }, 30, { status: 'deferred' }],
    [{ status: 'missing' }, 40, { status: 'missing' }],
  ])('runs the engine for the run and logs ids and codes (%j)', async (result, level, logged) => {
    const { engine, calls } = engineOf(result);
    const { logger, lines } = capture();
    await createAutomationRunTask({ engine, logger })({ organization_id: ORG, run_id: RUN }, job);
    expect(calls).toEqual([{ org: ORG, run: RUN, task: 'automation.run' }]);
    expect(lines()[0]).toMatchObject({ level, job_id: '18', org_id: ORG, run_id: RUN, ...logged });
  });

  it.each([
    ['missing run', { organization_id: ORG }],
    ['bad run id', { organization_id: ORG, run_id: 'rec_UnitRecord000001' }],
  ])('skips a malformed payload (%s)', async (_name, payload) => {
    const { engine, calls } = engineOf({ status: 'succeeded' });
    const { logger, lines } = capture();
    await createAutomationRunTask({ engine, logger })(payload as never, job);
    expect(calls).toEqual([]);
    expect(lines()[0]).toMatchObject({
      level: 50,
      msg: 'automation.run: malformed payload, skipped',
    });
  });
});
