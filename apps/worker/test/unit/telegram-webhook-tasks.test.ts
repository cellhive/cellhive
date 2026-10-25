import { Writable } from 'node:stream';

import { parseCronItems, type JobHelpers } from 'graphile-worker';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import {
  CRON_ITEMS,
  NOTIFICATIONS_TELEGRAM_SPARSE_POLL_CRON,
  NOTIFICATIONS_TELEGRAM_WEBHOOK_CHECK_CRON,
} from '../../src/job-runner.js';
import {
  createNotificationsTelegramReplyTask,
  TelegramReplyRetryError,
} from '../../src/tasks/notifications-telegram-reply.js';
import { createNotificationsTelegramSparsePollTask } from '../../src/tasks/notifications-telegram-sparse-poll.js';

import type { Db, TelegramReplyOutcome } from '@cellhive/server-core';

/** BACKLOG T609: cron items and the tasks of replies and sparse polls (no database). */

const ORG = 'org_UnitOrg000000001';
const SECRET = 'sec_UnitSecret000001';
const helpers = { job: { id: '17' } } as unknown as JobHelpers;

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

const at = (hour: number, min: number) => ({ min, hour, date: 1, month: 1, dow: 1 });

describe('Telegram crons (T609)', () => {
  it('sparse poll every 15 minutes, webhook check hourly; once, without payload', () => {
    const items = parseCronItems([...CRON_ITEMS]);
    const sparse = items.find((item) => item.identifier === 'notifications.telegram_sparse_poll');
    const check = items.find((item) => item.identifier === 'notifications.telegram_webhook_check');
    expect(NOTIFICATIONS_TELEGRAM_SPARSE_POLL_CRON).toBe('*/15 * * * *');
    expect(NOTIFICATIONS_TELEGRAM_WEBHOOK_CHECK_CRON).toBe('20 * * * *');
    expect(sparse).toMatchObject({ task: 'notifications.telegram_sparse_poll' });
    expect(check).toMatchObject({ task: 'notifications.telegram_webhook_check' });
    for (const item of [sparse, check]) {
      expect(item?.payload ?? {}).toEqual({});
      expect(item?.options.maxAttempts).toBe(1);
    }
    // `/stop` waits at most 15 minutes.
    expect([0, 15, 30, 45].every((min) => sparse?.match(at(3, min)))).toBe(true);
    expect(sparse?.match(at(3, 7))).toBe(false);
    expect(check?.match(at(3, 20))).toBe(true);
  });
});

describe('notifications.telegram_reply (T609)', () => {
  const payload = {
    organization_id: ORG,
    secret_id: SECRET,
    chat: 'sealed-chat',
    reply: 'invalid',
    language: 'en',
  } as const;

  function taskWith(outcome: TelegramReplyOutcome) {
    const captured = capture();
    const sent: unknown[] = [];
    const task = createNotificationsTelegramReplyTask({
      logger: captured.logger,
      sender: {
        send: (value) => {
          sent.push(value);
          return Promise.resolve(outcome);
        },
      },
    });
    return { task, sent, captured };
  }

  it('sends the payload; a temporary failure throws for a retry', async () => {
    const ok = taskWith('sent');
    await ok.task(payload, helpers);
    expect(ok.sent).toEqual([payload]);
    expect(ok.captured.lines()[0]).toMatchObject({ level: 20, outcome: 'sent', org_id: ORG });

    const retry = taskWith('retry');
    await expect(retry.task(payload, helpers)).rejects.toBeInstanceOf(TelegramReplyRetryError);
    expect(retry.captured.lines()[0]).toMatchObject({ level: 40, outcome: 'retry' });

    const dropped = taskWith('rate_limited');
    await dropped.task(payload, helpers);
    expect(dropped.captured.lines()[0]).toMatchObject({ level: 30, outcome: 'rate_limited' });
    // Never the sealed chat in the logs.
    for (const run of [ok, retry, dropped]) expect(run.captured.raw()).not.toContain('sealed-chat');
  });

  it('skips a malformed payload', async () => {
    const run = taskWith('sent');
    await run.task({ ...payload, reply: 'hello' } as never, helpers);
    expect(run.sent).toEqual([]);
    expect(run.captured.lines()[0]).toMatchObject({
      level: 50,
      msg: 'notifications.telegram_reply: malformed payload, skipped',
    });
  });
});

describe('notifications.telegram_sparse_poll (T609)', () => {
  it('polls the bot of the payload once, sparse, and logs counts only', async () => {
    const captured = capture();
    const calls: unknown[] = [];
    const task = createNotificationsTelegramSparsePollTask({
      db: {} as Db,
      logger: captured.logger,
      poller: {
        poll: (org, secret, run) => {
          calls.push([org, secret, run]);
          return Promise.resolve({
            outcome: 'done',
            updates: 1,
            linked: 0,
            refused: 0,
            stopped: 1,
            ignored: 0,
          });
        },
      },
    });
    await task({ organization_id: ORG, secret_id: SECRET }, helpers);
    expect(calls).toEqual([[ORG, SECRET, { sparse: true }]]);
    expect(captured.lines()[0]).toMatchObject({
      msg: 'telegram notification bot sparse poll',
      outcome: 'done',
      stopped: 1,
    });
  });
});
