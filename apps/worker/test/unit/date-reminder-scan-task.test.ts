import { Writable } from 'node:stream';

import { parseCronItems, type JobHelpers } from 'graphile-worker';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { CRON_ITEMS, NOTIFICATIONS_DATE_REMINDER_SCAN_CRON } from '../../src/job-runner.js';
import { createNotificationsDateReminderScanTask } from '../../src/tasks/notifications-date-reminder-scan.js';

import type { DateReminderScanner, DateReminderTick } from '@cellhive/server-core';

const ORG = 'org_UnitOrg000000001';

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

const tick: DateReminderTick = {
  fields: 3,
  reminders: 1003,
  results: [
    { organizationId: ORG, fieldId: 'fld_UnitReminder0001', outcome: 'reminded', reminders: 3 },
    { organizationId: ORG, fieldId: 'fld_UnitReminder0002', outcome: 'idle', reminders: 0 },
    { organizationId: ORG, fieldId: 'fld_UnitReminder0003', outcome: 'capped', reminders: 1000 },
  ],
};

describe('notifications.date_reminder_scan (T547)', () => {
  it('runs every minute, once, without backfill', () => {
    expect(NOTIFICATIONS_DATE_REMINDER_SCAN_CRON).toBe('* * * * *');
    const item = parseCronItems([...CRON_ITEMS]).find(
      (cron) => cron.identifier === 'notifications.date_reminder_scan',
    );
    expect(item).toMatchObject({ task: 'notifications.date_reminder_scan' });
    expect(item?.options).toMatchObject({ backfillPeriod: 0, maxAttempts: 1 });
    expect(item?.match({ min: 7, hour: 3, date: 1, month: 1, dow: 1 })).toBe(true);
  });

  it('passes the injected clock and logs ids, codes and counts only', async () => {
    const { logger, lines, raw } = capture();
    const now = new Date('2027-03-09T02:00:00Z');
    const calls: Date[] = [];
    const scanner = {
      scanAll: (at: Date) => {
        calls.push(at);
        return Promise.resolve(tick);
      },
    } satisfies Pick<DateReminderScanner, 'scanAll'>;
    await createNotificationsDateReminderScanTask({ scanner, logger, now: () => now })(
      {},
      {} as JobHelpers,
    );
    expect(calls).toEqual([now]);
    const logged = lines();
    expect(logged.filter((line) => line['msg'] === 'date reminder scan')).toEqual([
      expect.objectContaining({
        org_id: ORG,
        field_id: 'fld_UnitReminder0001',
        outcome: 'reminded',
        reminders: 3,
      }),
      expect.objectContaining({
        org_id: ORG,
        field_id: 'fld_UnitReminder0003',
        outcome: 'capped',
        reminders: 1000,
      }),
    ]);
    expect(logged.at(-1)).toMatchObject({ fields: 3, reminders: 1003 });
    expect(raw()).not.toMatch(/2027-|usr_|rec_/u);
  });

  it('uses the real clock by default', async () => {
    const { logger } = capture();
    const calls: Date[] = [];
    const before = Date.now();
    await createNotificationsDateReminderScanTask({
      scanner: {
        scanAll: (at: Date) => {
          calls.push(at);
          return Promise.resolve({ fields: 0, reminders: 0, results: [] });
        },
      },
      logger,
    })({}, {} as JobHelpers);
    expect(calls[0]?.getTime()).toBeGreaterThanOrEqual(before);
  });
});
