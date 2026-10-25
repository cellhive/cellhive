import { describe, expect, it } from 'vitest';

import {
  recipientFailureOf,
  rejectionReason,
  rejectionsOf,
  smtpReplyText,
  type RejectionReason,
  type SmtpReply,
} from '../model/rejections';

const reply = (code: number | null, enhanced: string | null = null): SmtpReply => ({
  code,
  enhanced,
});

describe('rejectionReason (T556, QA S5 L1)', () => {
  const cases: [string, string | null, SmtpReply | null, RejectionReason][] = [
    ['550 5.1.1: unknown mailbox', 'smtp_rejected', reply(550, '5.1.1'), 'mailbox_unknown'],
    [
      '5.1.10 (Microsoft "recipient not found")',
      'smtp_rejected',
      reply(550, '5.1.10'),
      'mailbox_unknown',
    ],
    ['5.1.6 mailbox moved', 'smtp_rejected', reply(551, '5.1.6'), 'mailbox_unknown'],
    ['5.1.2 unknown domain', 'smtp_rejected', reply(550, '5.1.2'), 'domain_unknown'],
    ['5.1.3 bad address syntax', 'smtp_rejected', reply(501, '5.1.3'), 'bad_address'],
    ['5.1.8 sender refused', 'smtp_rejected', reply(553, '5.1.8'), 'sender_rejected'],
    ['5.2.1 mailbox disabled', 'smtp_rejected', reply(550, '5.2.1'), 'mailbox_disabled'],
    ['5.2.2 mailbox full', 'smtp_rejected', reply(552, '5.2.2'), 'mailbox_full'],
    ['5.3.4 message too big', 'smtp_rejected', reply(552, '5.3.4'), 'too_large'],
    ['5.7.1 policy', 'smtp_rejected', reply(550, '5.7.1'), 'policy'],
    ['5.7.26 DMARC failure', 'smtp_rejected', reply(550, '5.7.26'), 'policy'],
    ['4.2.2 full for now: temporary', 'smtp_temporary', reply(452, '4.2.2'), 'temporary'],
    ['enhanced beats basic: 550 5.2.2', 'smtp_rejected', reply(550, '5.2.2'), 'mailbox_full'],
    [
      'unknown enhanced falls back to basic 550',
      'smtp_rejected',
      reply(550, '5.0.0'),
      'mailbox_unknown',
    ],
    ['basic 552 alone', 'smtp_rejected', reply(552), 'mailbox_full'],
    ['basic 553 alone', 'smtp_rejected', reply(553), 'bad_address'],
    ['basic 554 alone', 'smtp_rejected', reply(554), 'policy'],
    ['basic 451 alone', 'smtp_temporary', reply(451), 'temporary'],
    ['basic 500 says nothing', 'smtp_rejected', reply(500), 'refused'],
    ['no reply (step run before T541)', 'smtp_rejected', null, 'refused'],
    ['no reply, temporary code', 'smtp_temporary', null, 'temporary'],
    [
      'invalid address wins over any reply',
      'invalid_address',
      reply(550, '5.1.1'),
      'invalid_address',
    ],
    ['unknown engine code, no reply', null, null, 'refused'],
  ];
  it.each(cases)('%s', (_name, code, smtp, reason) => {
    expect(rejectionReason(code, smtp)).toBe(reason);
  });
});

describe('smtpReplyText', () => {
  it.each([
    [reply(550, '5.1.1'), '550 5.1.1'],
    [reply(550), '550'],
    [reply(null, '5.1.1'), '5.1.1'],
    [reply(null), null],
    [null, null],
  ] as const)('%o → %s', (smtp, text) => {
    expect(smtpReplyText(smtp)).toBe(text);
  });
});

describe('rejectionsOf', () => {
  it('reads masked addresses and codes, drops malformed items, never invents an address', () => {
    expect(
      rejectionsOf([
        {
          masked: 'c***@example.com',
          code: 'smtp_rejected',
          smtp: { code: 550, enhanced: '5.1.1' },
        },
        { masked: '***', code: 'invalid_address', smtp: null },
        { code: 'smtp_rejected', smtp: { code: 'x', enhanced: 'not a code' } },
        'garbage',
        null,
      ]),
    ).toEqual([
      {
        masked: 'c***@example.com',
        code: 'smtp_rejected',
        smtp: { code: 550, enhanced: '5.1.1' },
        reason: 'mailbox_unknown',
      },
      { masked: '***', code: 'invalid_address', smtp: null, reason: 'invalid_address' },
      { masked: null, code: 'smtp_rejected', smtp: null, reason: 'refused' },
    ]);
    expect(rejectionsOf(undefined)).toEqual([]);
    expect(rejectionsOf({ masked: 'a' })).toEqual([]);
  });
});

describe('recipientFailureOf', () => {
  const one = {
    masked: 'c***@example.com',
    code: 'smtp_rejected',
    smtp: { code: 550, enhanced: '5.1.1' },
  };
  const cases: [
    string,
    Record<string, unknown> | undefined,
    ReturnType<typeof recipientFailureOf>,
  ][] = [
    ['no params', undefined, null],
    ['params of another error', { reason: 'auth_failed', smtp: { code: 535 } }, null],
    ['empty list and no count', { rejected: [], rejected_count: 0, accepted_count: 0 }, null],
    [
      'one refused, none accepted',
      { reason: 'rejected', rejected: [one], rejected_count: 1, accepted_count: 0 },
      {
        rejected: [{ ...one, reason: 'mailbox_unknown' }],
        rejectedCount: 1,
        acceptedCount: 0,
      },
    ],
    [
      'more refused than listed (cap of 50), some accepted',
      { rejected: [one], rejected_count: 73, accepted_count: 2 },
      {
        rejected: [{ ...one, reason: 'mailbox_unknown' }],
        rejectedCount: 73,
        acceptedCount: 2,
      },
    ],
    [
      'a count lower than the list is raised to the list',
      { rejected: [one, one], rejected_count: 1 },
      {
        rejected: [
          { ...one, reason: 'mailbox_unknown' },
          { ...one, reason: 'mailbox_unknown' },
        ],
        rejectedCount: 2,
        acceptedCount: 0,
      },
    ],
    [
      'bad counts are ignored',
      { rejected: [one], rejected_count: -4, accepted_count: 1.5 },
      { rejected: [{ ...one, reason: 'mailbox_unknown' }], rejectedCount: 1, acceptedCount: 0 },
    ],
  ];
  it.each(cases)('%s', (_name, params, expected) => {
    expect(recipientFailureOf(params)).toEqual(expected);
  });
});
