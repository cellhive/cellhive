/**
 * Opt-in email bench (BACKLOG T528, T541): `EMAIL_BENCH=1 pnpm --filter
 * @cellhive/api test:int test/int/email.bench`.
 *
 * Sends automation emails through the real `Mailer` of the API (Valkey
 * quota of the test containers) to a local SMTP server and reports:
 *
 * 1. 50 messages at the default `SMTP_MAX_PER_SEC` (5): wall time and the
 *    most messages the SMTP server received within one sliding second
 *    (asserted ≤ 5 since T541);
 * 2. the organization cap `EMAIL_MAX_PER_HOUR_PER_ORG` (500) with a fast
 *    per-second limit: 500 accepted, the 501st `email_quota_exceeded`
 *    (retry at the next hour), another organization not affected.
 *
 * Load convention of the S4b benches: measured only when the 1-minute load
 * is below 8, otherwise reported as pending. Never fails on the timings
 * (the per-second limit itself is asserted, T541).
 */
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { loadavg } from 'node:os';

import { EmailSendError, type Mailer, type MailMessage } from '@cellhive/server-core';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cacheReady } from '../../src/common/infra/connections.js';
import { CACHE_CLIENT, MAIL_SERVICE } from '../../src/common/tokens.js';

import { startTestApp, type TestApp } from './support.js';

import type { Redis } from 'ioredis';
import type { AddressInfo } from 'node:net';

const MAX_LOAD = 8;

/** An SMTP server that records when each message arrived. */
async function startTimedSmtp(): Promise<{
  url: string;
  arrivals: number[];
  close(): Promise<void>;
}> {
  const arrivals: number[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, _session, callback) {
      stream.on('data', () => undefined);
      stream.on('end', () => {
        arrivals.push(performance.now());
        callback();
      });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server.server, 'listening');
  const { port } = server.server.address() as AddressInfo;
  return {
    url: `smtp://127.0.0.1:${String(port)}`,
    arrivals,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function message(organizationId: string, index: number): MailMessage {
  return {
    to: `bench-${String(index)}@example.test`,
    subject: `Bench ${String(index)}`,
    text: 'Bench',
    html: '<p>Bench</p>',
    origin: { kind: 'automation', organizationId, automationId: 'aut_EmailBench000001' },
  };
}

/** Most arrivals within any window of one second. */
function maxPerSecond(arrivals: readonly number[]): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < arrivals.length; end += 1) {
    while ((arrivals[end] ?? 0) - (arrivals[start] ?? 0) >= 1000) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

describe.skipIf(process.env['EMAIL_BENCH'] !== '1')('email bench (T528, T541)', () => {
  const report: string[] = [];
  let smtp: Awaited<ReturnType<typeof startTimedSmtp>>;
  let paced: TestApp;
  let fast: TestApp;

  beforeAll(async () => {
    smtp = await startTimedSmtp();
    const common = {
      SMTP_URL: smtp.url,
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
      SMTP_ALLOW_INSECURE: 'true',
    };
    paced = await startTestApp(common);
    fast = await startTestApp({ ...common, SMTP_MAX_PER_SEC: '200' });
    // The cache client connects in the background; commands are not queued meanwhile.
    for (const target of [paced, fast]) await cacheReady(target.app.get<Redis>(CACHE_CLIENT));
  });

  afterAll(async () => {
    process.stdout.write(
      `\nEmail bench (T528, T541, load ${(loadavg()[0] ?? 0).toFixed(2)} at end)\n${report.join('\n')}\n`,
    );
    await paced.close();
    await fast.close();
    await smtp.close();
  });

  function skipWhenBusy(context: { skip: () => void }): void {
    const load = loadavg()[0] ?? 0;
    if (load >= MAX_LOAD) {
      report.push(`PENDING: load ${load.toFixed(2)} ≥ ${String(MAX_LOAD)}`);
      context.skip();
    }
  }

  it('paces 50 messages at SMTP_MAX_PER_SEC = 5', async (context) => {
    skipWhenBusy(context);
    const mailer = paced.app.get<Mailer>(MAIL_SERVICE);
    const org = `org_${randomBytes(8).toString('hex')}`;
    smtp.arrivals.length = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: 50 }, (_, index) => mailer.send(message(org, index))));
    const elapsed = performance.now() - started;
    report.push(
      `  50 messages at 5/s: ${(elapsed / 1000).toFixed(1)} s, at most ${String(maxPerSecond(smtp.arrivals))} received within one second (load ${(loadavg()[0] ?? 0).toFixed(2)})`,
    );
    expect(smtp.arrivals).toHaveLength(50);
    // T541: a message holds its slot from the start of the SMTP transaction
    // until one second after it ended, so any sliding second sees at most 5
    // arrivals (T528 measured 10 when only starts were counted); rounds of
    // 5 every 1 s + one round trip: 50 messages take ≈ 9–10 s.
    expect(maxPerSecond(smtp.arrivals)).toBeLessThanOrEqual(5);
    expect(elapsed).toBeGreaterThanOrEqual(9_000);
  }, 120_000);

  it('stops an organization at EMAIL_MAX_PER_HOUR_PER_ORG = 500', async (context) => {
    skipWhenBusy(context);
    const mailer = fast.app.get<Mailer>(MAIL_SERVICE);
    const org = `org_${randomBytes(8).toString('hex')}`;
    smtp.arrivals.length = 0;
    const started = performance.now();
    for (let batch = 0; batch < 25; batch += 1) {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) => mailer.send(message(org, batch * 20 + index))),
      );
    }
    const elapsed = performance.now() - started;
    let refused: unknown;
    const before = performance.now();
    try {
      await mailer.send(message(org, 500));
    } catch (error) {
      refused = error;
    }
    const refusal = performance.now() - before;
    expect(refused).toBeInstanceOf(EmailSendError);
    expect((refused as EmailSendError).code).toBe('email_quota_exceeded');
    await mailer.send(message(`org_${randomBytes(8).toString('hex')}`, 501));
    report.push(
      `  500 messages of one organization (20 at a time, 200/s): ${(elapsed / 1000).toFixed(1)} s ` +
        `(${(500 / (elapsed / 1000)).toFixed(0)} msg/s); 501st refused email_quota_exceeded in ` +
        `${refusal.toFixed(1)} ms, retry at ${(refused as EmailSendError).retryAt?.toISOString() ?? '?'}; ` +
        `another organization still sends (load ${(loadavg()[0] ?? 0).toFixed(2)})`,
    );
    expect(smtp.arrivals).toHaveLength(501);
  }, 300_000);
});
