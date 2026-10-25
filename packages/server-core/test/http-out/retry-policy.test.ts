import { describe, expect, it } from 'vitest';

import {
  decideRetry,
  parseRetryAfter,
  retryDelayAfter,
  type DeliveryAttemptResult,
} from '../../src/http-out/retry-policy.js';

const NOW = new Date('2026-10-18T03:00:00.000Z');
const mid = () => 0.5; // no jitter
const at = (ms: number) => new Date(NOW.getTime() + ms);
const response = (status: number, retryAfter?: string): DeliveryAttemptResult => ({
  kind: 'response',
  status,
  ...(retryAfter === undefined ? {} : { retryAfter }),
});

describe('retry policy of the HTTP outbox (T605, ADR-35 §4)', () => {
  describe('parseRetryAfter', () => {
    it.each([
      ['seconds', '120', at(120_000)],
      ['zero seconds', '0', NOW],
      ['spaces around', ' 5 ', at(5_000)],
      ['HTTP date', 'Sun, 18 Oct 2026 03:10:00 GMT', at(600_000)],
      ['date in the past means now', 'Sun, 18 Oct 2026 02:00:00 GMT', NOW],
    ] as const)('%s', (_name, value, expected) => {
      expect(parseRetryAfter(value, NOW)).toEqual(expected);
    });

    it.each([
      ['missing', undefined],
      ['null', null],
      ['empty', ''],
      ['negative', '-5'],
      ['fraction', '1.5'],
      ['garbage', 'soon'],
      ['too many digits', '12345678901'],
    ] as const)('%s → null', (_name, value) => {
      expect(parseRetryAfter(value, NOW)).toBeNull();
    });
  });

  describe('retryDelayAfter', () => {
    it.each([
      [1, 10_000],
      [2, 60_000],
      [3, 300_000],
      [4, 900_000],
      [5, 1_800_000],
    ] as const)('after attempt %i: %i ms without jitter', (attempt, delay) => {
      expect(retryDelayAfter(attempt, mid)).toBe(delay);
    });

    it('jitter stays within ± 20 %', () => {
      expect(retryDelayAfter(1, () => 0)).toBe(8_000);
      expect(retryDelayAfter(1, () => 0.999_999)).toBe(12_000);
    });

    it('no delay after the sixth attempt', () => {
      expect(retryDelayAfter(6, mid)).toBeNull();
    });
  });

  describe('decideRetry', () => {
    it.each([200, 201, 204, 299])('%i succeeds', (status) => {
      expect(decideRetry({ result: response(status), attempt: 1, now: NOW, random: mid })).toEqual({
        action: 'succeed',
      });
    });

    it.each([
      ['302 (redirects never followed)', 302],
      ['301', 301],
      ['400', 400],
      ['401', 401],
      ['404', 404],
      ['410 (endpoint gone)', 410],
      ['422', 422],
      ['501', 501],
      ['100', 100],
    ] as const)('%s fails at once', (_name, status) => {
      expect(decideRetry({ result: response(status), attempt: 1, now: NOW, random: mid })).toEqual({
        action: 'fail',
        failure: { code: 'http_status', params: { status } },
      });
    });

    it.each([408, 425, 429, 500, 502, 503, 504, 599])('%i is retried on schedule', (status) => {
      expect(decideRetry({ result: response(status), attempt: 2, now: NOW, random: mid })).toEqual({
        action: 'retry',
        at: at(60_000),
        pauseUntil: null,
        failure: { code: 'http_status', params: { status } },
      });
    });

    it.each([
      ['timeout', 'http_timeout'],
      ['network', 'http_network'],
    ] as const)('%s is retried', (_name, code) => {
      expect(
        decideRetry({ result: { kind: 'error', code }, attempt: 1, now: NOW, random: mid }),
      ).toEqual({
        action: 'retry',
        at: at(10_000),
        pauseUntil: null,
        failure: { code, params: {} },
      });
    });

    it.each([
      { reason: 'unresolvable', cause: 'timeout' },
      { reason: 'unresolvable', cause: 'temporary' },
    ])('QA S5c: a name the resolver could not answer for now (%o) is retried', (params) => {
      expect(
        decideRetry({
          result: { kind: 'error', code: 'ssrf_blocked', params },
          attempt: 1,
          now: NOW,
          random: mid,
        }),
      ).toEqual({
        action: 'retry',
        at: at(10_000),
        pauseUntil: null,
        failure: { code: 'ssrf_blocked', params },
      });
    });

    it.each([
      ['ssrf_blocked', { reason: 'private_address' }],
      ['ssrf_blocked', { reason: 'unresolvable' }],
      ['ssrf_blocked', { reason: 'private_address', cause: 'timeout' }],
      ['http_response_too_large', { limit_bytes: 1_048_576 }],
    ] as const)('%s %o fails at once', (code, params) => {
      expect(
        decideRetry({ result: { kind: 'error', code, params }, attempt: 1, now: NOW, random: mid }),
      ).toEqual({ action: 'fail', failure: { code, params } });
    });

    it('the sixth temporary failure is final, with the attempts', () => {
      expect(decideRetry({ result: response(500), attempt: 6, now: NOW, random: mid })).toEqual({
        action: 'fail',
        failure: { code: 'http_status', params: { status: 500, attempts: 6 } },
      });
      expect(
        decideRetry({
          result: { kind: 'error', code: 'http_timeout' },
          attempt: 6,
          now: NOW,
          random: mid,
        }),
      ).toEqual({ action: 'fail', failure: { code: 'http_timeout', params: { attempts: 6 } } });
    });

    it('Retry-After later than the schedule wins and pauses the host', () => {
      expect(
        decideRetry({ result: response(503, '120'), attempt: 1, now: NOW, random: mid }),
      ).toEqual({
        action: 'retry',
        at: at(120_000),
        pauseUntil: at(120_000),
        failure: { code: 'http_status', params: { status: 503 } },
      });
    });

    it('Retry-After earlier than the schedule keeps the schedule (still pauses)', () => {
      expect(
        decideRetry({ result: response(429, '2'), attempt: 1, now: NOW, random: mid }),
      ).toEqual({
        action: 'retry',
        at: at(10_000),
        pauseUntil: at(2_000),
        failure: { code: 'http_status', params: { status: 429 } },
      });
    });

    it('Retry-After exactly one hour is honoured', () => {
      const decision = decideRetry({
        result: response(429, '3600'),
        attempt: 1,
        now: NOW,
        random: mid,
      });
      expect(decision).toMatchObject({ action: 'retry', at: at(3_600_000) });
    });

    it('Retry-After over one hour fails with rate_limited', () => {
      expect(
        decideRetry({ result: response(503, '7200'), attempt: 1, now: NOW, random: mid }),
      ).toEqual({
        action: 'fail',
        failure: { code: 'rate_limited', params: { status: 503, retry_after_s: 7200 } },
      });
    });

    it('Retry-After on a 500 is ignored (only 429/503)', () => {
      expect(
        decideRetry({ result: response(500, '7200'), attempt: 1, now: NOW, random: mid }),
      ).toMatchObject({ action: 'retry', at: at(10_000), pauseUntil: null });
    });

    it('an invalid Retry-After is ignored', () => {
      expect(
        decideRetry({ result: response(429, 'later'), attempt: 1, now: NOW, random: mid }),
      ).toMatchObject({ action: 'retry', at: at(10_000), pauseUntil: null });
    });

    it('six attempts of 500 follow 0 / 10 s / 1 min / 5 min / 15 min / 30 min', () => {
      let now = NOW;
      const times = [now.getTime()];
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const decision = decideRetry({ result: response(500), attempt, now, random: mid });
        if (decision.action !== 'retry') {
          expect(attempt).toBe(6);
          expect(decision.action).toBe('fail');
          break;
        }
        now = decision.at;
        times.push(now.getTime());
      }
      const gaps = times.slice(1).map((time, index) => time - (times[index] ?? 0));
      expect(gaps).toEqual([10_000, 60_000, 300_000, 900_000, 1_800_000]);
    });
  });
});
