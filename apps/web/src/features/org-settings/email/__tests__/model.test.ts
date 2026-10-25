import { describe, expect, it } from 'vitest';

import { connectionTestView, replyText, TEST_WINDOW_MS, testsLeft } from '../model/connection-test';

import type { EmailTestResult } from '@cellhive/contracts';

describe('connectionTestView', () => {
  const failed = (reason: string, code: number | null, enhanced: string | null) =>
    ({
      status: 'failed',
      code: 'smtp_rejected',
      reason,
      smtp: { code, enhanced },
    }) as EmailTestResult;

  it.each([
    [failed('auth_failed', 535, '5.7.8'), 'test.failed.authFailed.title', '535 5.7.8'],
    [failed('tls_failed', null, null), 'test.failed.tlsFailed.title', null],
    [failed('connection_failed', null, null), 'test.failed.connectionFailed.title', null],
    [failed('timeout', null, null), 'test.failed.timeout.title', null],
    [failed('temporary', 421, null), 'test.failed.temporary.title', '421'],
    [failed('rejected', 550, '5.7.1'), 'test.failed.rejected.title', '550 5.7.1'],
    [failed('host_not_allowed', null, null), 'test.failed.hostNotAllowed.title', null],
    [failed('unknown', null, null), 'test.failed.unknown.title', null],
  ])('%j', (result, messageKey, reply) => {
    const view = connectionTestView(result);
    expect(view).toEqual({
      ok: false,
      messageKey,
      hintKey: messageKey.replace(/title$/u, 'hint'),
      reply,
    });
  });

  it('reports a sent test with the reply code', () => {
    expect(
      connectionTestView({
        status: 'sent',
        to: 'an@example.test',
        message_id: '<m@x>',
        smtp: { code: 250, enhanced: '2.0.0' },
      }),
    ).toEqual({
      ok: true,
      messageKey: 'test.sent.title',
      hintKey: 'test.sent.body',
      reply: '250 2.0.0',
    });
  });

  it('formats replies', () => {
    expect(replyText({ code: null, enhanced: null })).toBeNull();
    expect(replyText({ code: 250, enhanced: null })).toBe('250');
  });
});

describe('testsLeft', () => {
  const now = 1_000_000;
  it.each([
    [[], 5, 5],
    [[now - 1_000, now - 2_000], 5, 3],
    [[now - TEST_WINDOW_MS, now - 1], 5, 4],
    [[now, now, now, now, now, now], 5, 0],
  ] as const)('%j of %i → %i', (sent, limit, expected) => {
    expect(testsLeft(sent, limit, now)).toBe(expected);
  });
});
