import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

import {
  createMailService,
  createValkeyEmailQuota,
  createValkeySendPacer,
  EmailSendError,
  SendPacerUnavailableError,
  valkeyQuotaClient,
  type Mailer,
  type MailMessage,
  type SendSlot,
} from '@cellhive/server-core';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cacheReady, createCacheClient } from '../../src/common/infra/connections.js';
import { CACHE_CLIENT, MAIL_SERVICE } from '../../src/common/tokens.js';

import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { Redis } from 'ioredis';
import type { AddressInfo } from 'node:net';

/** An SMTP server that records how many messages it accepted. */
async function startSmtp(): Promise<{
  url: string;
  received: () => number;
  arrivals: number[];
  close(): Promise<void>;
}> {
  let received = 0;
  const arrivals: number[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, _session, callback) {
      stream.on('data', () => undefined);
      stream.on('end', () => {
        received += 1;
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
    received: () => received,
    arrivals,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function automationMessage(index: number): MailMessage {
  return {
    to: `limits-${String(index)}@example.test`,
    subject: 'Limits',
    text: 'Limits',
    html: '<p>Limits</p>',
    origin: {
      kind: 'automation',
      organizationId: `org_${randomBytes(8).toString('hex')}`,
      automationId: 'aut_EmailLimits00001',
    },
  };
}

/** Most instants within any one-second window. */
function maxWithinOneSecond(times: readonly number[], windowMs = 1000): number {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while ((sorted[end] ?? 0) - (sorted[start] ?? 0) >= windowMs) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/** A Valkey client nobody listens to (port 1): never ready. */
function unreachableClient(t: TestApp): Redis {
  return createCacheClient(
    { ...t.config, cache: { ...t.config.cache, url: 'redis://127.0.0.1:1' } },
    captureLogger().logger,
  );
}

/**
 * BACKLOG T541 (S5-review §4 #14, #15): the email quota waits for the
 * Valkey connection instead of failing with "Stream isn't writeable" right
 * after start (and fails as a classified temporary error when Valkey does
 * not come up), and the shared sliding-window pacer (Telegram per bot, T550)
 * keeps every sliding second under its limit across processes.
 */
describe('email limits and Valkey readiness (T541)', () => {
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  let t: TestApp;
  const extraClients: Redis[] = [];

  beforeAll(async () => {
    smtp = await startSmtp();
    t = await startTestApp({
      SMTP_URL: smtp.url,
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
      SMTP_ALLOW_INSECURE: 'true',
      SMTP_MAX_PER_SEC: '200',
    });
  });

  afterAll(async () => {
    for (const client of extraClients) client.disconnect();
    await t.close();
    await smtp.close();
  });

  describe('quota before Valkey is ready (S5-review §4 #14)', () => {
    it('a message sent while the API cache client is still connecting is sent', async () => {
      const cache = t.app.get<Redis>(CACHE_CLIENT);
      const mailer = t.app.get<Mailer>(MAIL_SERVICE);
      await cacheReady(cache);
      // The state right after start: connecting, no offline queue.
      const ended = once(cache, 'end');
      cache.disconnect();
      await ended;
      const reconnected = cache.connect().catch(() => undefined);
      const statusAtSend = cache.status;
      const before = smtp.received();
      const result = await mailer.send(automationMessage(1));
      expect(['connecting', 'connect']).toContain(statusAtSend);
      expect(result.accepted).toEqual(['l***@example.test']);
      expect(smtp.received()).toBe(before + 1);
      await reconnected;
      expect(cache.status).toBe('ready');
    });

    it('the first 50 ms of a fresh client: sent, never a plain error', async () => {
      const client = createCacheClient(t.config, captureLogger().logger);
      extraClients.push(client);
      const quota = createValkeyEmailQuota(valkeyQuotaClient(client), {
        limit: 500,
        scope: 'org',
      });
      const mailer = createMailService(t.config, { orgQuota: quota });
      const started = performance.now();
      const statusAtSend = client.status;
      const outcomes = await Promise.allSettled(
        Array.from({ length: 5 }, (_, index) => mailer.send(automationMessage(10 + index))),
      );
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(statusAtSend).not.toBe('ready');
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          // Allowed only as a classified, retried failure.
          expect(outcome.reason).toBeInstanceOf(EmailSendError);
          expect(outcome.reason).toMatchObject({ code: 'smtp_temporary', retryable: true });
        }
      }
      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
      mailer.close();
    });

    it('Valkey never comes up: a temporary smtp_temporary after the wait, nothing sent', async () => {
      const client = unreachableClient(t);
      extraClients.push(client);
      const quota = createValkeyEmailQuota(valkeyQuotaClient(client, 300), {
        limit: 500,
        scope: 'org',
      });
      const mailer = createMailService(t.config, { orgQuota: quota });
      const before = smtp.received();
      const started = performance.now();
      const error: unknown = await mailer.send(automationMessage(20)).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(performance.now() - started).toBeGreaterThanOrEqual(250);
      expect(error).toBeInstanceOf(EmailSendError);
      expect(error).toMatchObject({ code: 'smtp_temporary', retryable: true, reason: 'temporary' });
      expect((error as EmailSendError).message).not.toMatch(/Stream|ECONNREFUSED|127\.0\.0\.1/);
      expect(smtp.received()).toBe(before);
      // System emails do not use the quota: they still go out.
      await mailer.send({ ...automationMessage(21), origin: { kind: 'system' } });
      expect(smtp.received()).toBe(before + 1);
      mailer.close();
    });
  });

  describe('SMTP_MAX_PER_SEC over sliding seconds (S5-review §4 #15)', () => {
    it('15 messages at 5 per second: the SMTP server never sees more than 5 in one second', async () => {
      const paced = createMailService({
        ...t.config,
        email: { ...t.config.email, maxPerSecond: 5 },
      });
      smtp.arrivals.length = 0;
      const started = performance.now();
      await Promise.all(
        Array.from({ length: 15 }, (_, index) => paced.send(automationMessage(100 + index))),
      );
      const elapsed = performance.now() - started;
      expect(smtp.arrivals).toHaveLength(15);
      expect(maxWithinOneSecond(smtp.arrivals)).toBeLessThanOrEqual(5);
      // Rounds of 5 at 0, ≥ 1, ≥ 2 s (each one second after the round before ended).
      expect(elapsed).toBeGreaterThanOrEqual(2_000);
      paced.close();
    });
  });

  describe('shared sliding-window pacer (bucket per bot, for T550)', () => {
    const pacerClient = () => {
      const client = createCacheClient(t.config, captureLogger().logger);
      extraClients.push(client);
      return valkeyQuotaClient(client);
    };
    const bot = () => `bot${randomBytes(6).toString('hex')}`;

    it('20 sends at 5 per second: no sliding second over 5, a burst of 5 at once', async () => {
      const pacer = createValkeySendPacer(pacerClient(), { limit: 5, scope: 'test' });
      const key = bot();
      const starts: number[] = [];
      const started = performance.now();
      await Promise.all(
        Array.from({ length: 20 }, async () => {
          const slot = await pacer.acquire(key);
          starts.push(performance.now());
          await slot.release();
        }),
      );
      expect(maxWithinOneSecond(starts, 700)).toBeLessThanOrEqual(5); // grant-seen jitter, as below
      // Rounds at 0, 1, 2, 3 s.
      expect(performance.now() - started).toBeGreaterThanOrEqual(2_900);
      expect(starts.filter((at) => at - started < 500)).toHaveLength(5);
    });

    it('two processes share one bucket', async () => {
      const key = bot();
      const pacers = [pacerClient(), pacerClient()].map((client) =>
        createValkeySendPacer(client, { limit: 4, scope: 'test' }),
      );
      const starts: number[] = [];
      await Promise.all(
        Array.from({ length: 16 }, async (_, index) => {
          const slot = await (pacers[index % 2] ?? pacers[0])?.acquire(key);
          starts.push(performance.now());
          await slot?.release();
        }),
      );
      expect(starts).toHaveLength(16);
      // The window runs on Valkey's clock while `starts` is when this process saw the grant:
      // under load a grant can be seen up to a few hundred ms late, bunching it with the next
      // window's. Allow that jitter, and check the 16 sends still needed four windows.
      expect(maxWithinOneSecond(starts, 700)).toBeLessThanOrEqual(4);
      const span = Math.max(...starts) - Math.min(...starts);
      expect(span).toBeGreaterThanOrEqual(3 * 1000 - 300);
    });

    it('a send in flight keeps its slot; it counts one window after its release', async () => {
      const pacer = createValkeySendPacer(pacerClient(), { limit: 1, scope: 'test' });
      const key = bot();
      const first = await pacer.acquire(key);
      let secondAt = 0;
      const second = pacer.acquire(key).then((slot) => {
        secondAt = performance.now();
        return slot;
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(secondAt).toBe(0);
      const releasedAt = performance.now();
      await first.release();
      await (await second).release();
      expect(secondAt - releasedAt).toBeGreaterThanOrEqual(900);
      expect(secondAt - releasedAt).toBeLessThan(1_600);
    });

    it('a slot never released stops counting after its lease', async () => {
      const pacer = createValkeySendPacer(pacerClient(), {
        limit: 1,
        scope: 'test',
        leaseMs: 300,
      });
      const key = bot();
      const started = performance.now();
      await pacer.acquire(key); // lost
      await (await pacer.acquire(key)).release();
      expect(performance.now() - started).toBeGreaterThanOrEqual(1_200);
    });

    it('keys are independent; the bucket key expires', async () => {
      const client = pacerClient();
      const pacer = createValkeySendPacer(client, { limit: 1, scope: 'test', leaseMs: 1_000 });
      const [full, free] = [bot(), bot()];
      const held: SendSlot = await pacer.acquire(full);
      const started = performance.now();
      await (await pacer.acquire(free)).release();
      expect(performance.now() - started).toBeLessThan(500);
      const cache = t.app.get<Redis>(CACHE_CLIENT);
      const ttl = await cache.pttl(`ob:pace:test:${full}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(1_000 + 1_000 + 1_000);
      await held.release();
    });

    it('fails as unavailable without Valkey, as timeout past maxWaitMs', async () => {
      const client = unreachableClient(t);
      extraClients.push(client);
      const offline = createValkeySendPacer(valkeyQuotaClient(client, 200), {
        limit: 1,
        scope: 'test',
      });
      await expect(offline.acquire(bot())).rejects.toMatchObject({
        name: 'SendPacerUnavailableError',
        reason: 'unavailable',
      });
      const pacer = createValkeySendPacer(pacerClient(), {
        limit: 1,
        scope: 'test',
        maxWaitMs: 200,
      });
      const key = bot();
      const held = await pacer.acquire(key);
      const error: unknown = await pacer.acquire(key).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(SendPacerUnavailableError);
      expect(error).toMatchObject({ reason: 'timeout' });
      await held.release();
    });
  });
});
