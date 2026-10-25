import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  generateSigningSecret,
  parseSigningSecret,
  signWebhook,
  verifyWebhook,
  type WebhookHeaders,
  type WebhookVerifyResult,
} from '../../src/webhooks/index.js';

/*
 * Test vectors copied from the Standard Webhooks reference implementation,
 * https://github.com/standard-webhooks/standard-webhooks at commit
 * 7537d2a2d3d52d8f2e0ecd12527af4a9307fd81b:
 *   - libraries/javascript/src/webhook.test.ts ("sign function works",
 *     defaultMsgID / defaultPayload / defaultSecret, "multi sig payload is
 *     valid", "invalid signature", "partial signature", timestamp cases);
 *   - libraries/python/tests/test_webhooks.py (`test_sign_function`, same
 *     expected value).
 * Spec: spec/standard-webhooks.md ("Signature scheme", "Webhook headers").
 */
const SPEC_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const SPEC_MSG_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const SPEC_TIMESTAMP = 1614265330;
const SPEC_PAYLOAD = '{"test": 2432232314}';
const SPEC_SIGNATURE = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
/** A well-formed `v1` signature that matches nothing (from "multi sig payload is valid"). */
const SPEC_FOREIGN_SIGNATURE = 'Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=';

/** A second secret (32 bytes 0x01…0x20) standing in for the secret before a rotation. */
const OLD_SECRET = `whsec_${Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')}`;

const NOW = new Date(SPEC_TIMESTAMP * 1000);

/** Independent HMAC (not through the module under test). */
function referenceSignature(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return createHmac('sha256', key)
    .update(`${id}.${String(timestamp)}.${body}`)
    .digest('base64');
}

const VALID_SIG = `v1,${referenceSignature(SPEC_SECRET, SPEC_MSG_ID, SPEC_TIMESTAMP, SPEC_PAYLOAD)}`;
const OLD_SIG = `v1,${referenceSignature(OLD_SECRET, SPEC_MSG_ID, SPEC_TIMESTAMP, SPEC_PAYLOAD)}`;

function headers(overrides: Record<string, string | undefined> = {}): WebhookHeaders {
  const base: Record<string, string | undefined> = {
    'webhook-id': SPEC_MSG_ID,
    'webhook-timestamp': String(SPEC_TIMESTAMP),
    'webhook-signature': VALID_SIG,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));
}

describe('Standard Webhooks spec vectors', () => {
  it('signs the reference message exactly like the reference libraries', () => {
    expect(
      signWebhook({ id: SPEC_MSG_ID, timestamp: SPEC_TIMESTAMP, body: SPEC_PAYLOAD }, [
        SPEC_SECRET,
      ]),
    ).toBe(SPEC_SIGNATURE);
  });

  it('verifies the reference signature', () => {
    expect(
      verifyWebhook(
        headers({ 'webhook-signature': SPEC_SIGNATURE }),
        SPEC_PAYLOAD,
        [SPEC_SECRET],
        NOW,
      ),
    ).toEqual({ ok: true });
  });

  it('accepts the reference secret as 24 bytes', () => {
    expect(parseSigningSecret(SPEC_SECRET)?.length).toBe(24);
  });
});

describe('parseSigningSecret', () => {
  const cases: { name: string; secret: string; bytes: number | null }[] = [
    { name: 'spec secret (24 bytes)', secret: SPEC_SECRET, bytes: 24 },
    { name: '32 bytes', secret: OLD_SECRET, bytes: 32 },
    {
      name: '64 bytes (upper bound)',
      secret: `whsec_${Buffer.alloc(64, 7).toString('base64')}`,
      bytes: 64,
    },
    {
      name: '23 bytes (too short)',
      secret: `whsec_${Buffer.alloc(23, 7).toString('base64')}`,
      bytes: null,
    },
    {
      name: '65 bytes (too long)',
      secret: `whsec_${Buffer.alloc(65, 7).toString('base64')}`,
      bytes: null,
    },
    { name: 'empty', secret: '', bytes: null },
    { name: 'prefix only', secret: 'whsec_', bytes: null },
    { name: 'missing prefix', secret: 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', bytes: null },
    { name: 'wrong prefix', secret: 'whsk_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', bytes: null },
    {
      name: 'broken base64 (bad char)',
      secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaS!',
      bytes: null,
    },
    {
      name: 'broken base64 (bad length)',
      secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSwA',
      bytes: null,
    },
    {
      name: 'base64url alphabet is not base64',
      secret: `whsec_${Buffer.alloc(32, 0xfb).toString('base64url')}`,
      bytes: null,
    },
    { name: 'inner whitespace', secret: 'whsec_MfKQ9r8GKYqr TwjUPD8ILPZIo2LaLaSw', bytes: null },
    {
      name: 'non-canonical padding bits',
      secret: `whsec_${Buffer.alloc(25, 7).toString('base64').replace(/w==$/, 'x==')}`,
      bytes: null,
    },
  ];

  it.each(cases)('$name', ({ secret, bytes }) => {
    const key = parseSigningSecret(secret);
    if (bytes === null) expect(key).toBeNull();
    else expect(key?.length).toBe(bytes);
  });

  it('generateSigningSecret makes a parseable 32-byte secret, different each time', () => {
    const a = generateSigningSecret();
    const b = generateSigningSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(parseSigningSecret(a)?.length).toBe(32);
    expect(a).not.toBe(b);
  });
});

describe('signWebhook', () => {
  const message = { id: SPEC_MSG_ID, timestamp: SPEC_TIMESTAMP, body: SPEC_PAYLOAD };

  it('signs with every secret, space separated, in the given order (rotation)', () => {
    expect(signWebhook(message, [SPEC_SECRET, OLD_SECRET])).toBe(`${VALID_SIG} ${OLD_SIG}`);
  });

  it('signs a Buffer body like the same string', () => {
    expect(signWebhook({ ...message, body: Buffer.from(SPEC_PAYLOAD) }, [SPEC_SECRET])).toBe(
      SPEC_SIGNATURE,
    );
  });

  it('signs an empty body', () => {
    expect(signWebhook({ ...message, body: '' }, [SPEC_SECRET])).toBe(
      `v1,${referenceSignature(SPEC_SECRET, SPEC_MSG_ID, SPEC_TIMESTAMP, '')}`,
    );
  });

  it.each([
    { name: 'no secret', secrets: [] as string[], msg: message },
    { name: 'malformed secret', secrets: ['whsec_short'], msg: message },
    { name: 'fractional timestamp', secrets: [SPEC_SECRET], msg: { ...message, timestamp: 1.5 } },
    { name: 'negative timestamp', secrets: [SPEC_SECRET], msg: { ...message, timestamp: -1 } },
    { name: 'empty id', secrets: [SPEC_SECRET], msg: { ...message, id: '' } },
    { name: 'id with a space', secrets: [SPEC_SECRET], msg: { ...message, id: 'msg 1' } },
  ])('throws on $name', ({ secrets, msg }) => {
    expect(() => signWebhook(msg, secrets)).toThrow(RangeError);
  });
});

describe('verifyWebhook', () => {
  const bad = (reason: string): WebhookVerifyResult =>
    ({ ok: false, reason }) as WebhookVerifyResult;
  const ok: WebhookVerifyResult = { ok: true };
  const flippedBody = `${SPEC_PAYLOAD.slice(0, -2)}5}`; // one byte changed

  const cases: {
    name: string;
    headers: WebhookHeaders;
    body?: string | Buffer;
    secrets?: string[];
    now?: Date;
    tolerance?: number;
    expected: WebhookVerifyResult;
  }[] = [
    { name: 'valid', headers: headers(), expected: ok },
    {
      name: 'valid, Buffer body',
      headers: headers(),
      body: Buffer.from(SPEC_PAYLOAD),
      expected: ok,
    },
    {
      name: 'header names are case-insensitive',
      headers: {
        'Webhook-Id': SPEC_MSG_ID,
        'WEBHOOK-TIMESTAMP': String(SPEC_TIMESTAMP),
        'Webhook-Signature': VALID_SIG,
      },
      expected: ok,
    },
    {
      name: 'rotation: two signatures, the new one matches',
      headers: headers({ 'webhook-signature': `${VALID_SIG} v1,${SPEC_FOREIGN_SIGNATURE}` }),
      expected: ok,
    },
    {
      name: 'rotation: two signatures, the old one matches the old secret',
      headers: headers({ 'webhook-signature': `v1,${SPEC_FOREIGN_SIGNATURE} ${OLD_SIG}` }),
      secrets: [SPEC_SECRET, OLD_SECRET],
      expected: ok,
    },
    {
      name: 'rotation: receiver holds two secrets, sender signed with the new one only',
      headers: headers(),
      secrets: [OLD_SECRET, SPEC_SECRET],
      expected: ok,
    },
    {
      name: 'spec multi-signature header (v1, v2, valid, v1)',
      headers: headers({
        'webhook-signature': [
          `v1,${SPEC_FOREIGN_SIGNATURE}`,
          `v2,${SPEC_FOREIGN_SIGNATURE}`,
          VALID_SIG,
          `v1,${SPEC_FOREIGN_SIGNATURE}`,
        ].join(' '),
      }),
      expected: ok,
    },
    {
      name: 'unknown version prefixes v1a and v2 are ignored',
      headers: headers({
        'webhook-signature': `v1a,${VALID_SIG.slice(3)} v2,${VALID_SIG.slice(3)}`,
      }),
      expected: bad('bad_signature'),
    },
    {
      name: 'v1a entry next to a valid v1 entry',
      headers: headers({
        'webhook-signature': `v1a,hnO3f9T8Ytu9HwrXslvumlUpqtNVqkhqw== ${VALID_SIG}`,
      }),
      expected: ok,
    },
    {
      name: 'extra spaces between signatures',
      headers: headers({ 'webhook-signature': `  v1,${SPEC_FOREIGN_SIGNATURE}   ${VALID_SIG} ` }),
      expected: ok,
    },
    {
      name: 'body changed by one byte',
      headers: headers(),
      body: flippedBody,
      expected: bad('bad_signature'),
    },
    {
      name: 'signature for another id',
      headers: headers({ 'webhook-id': 'msg_other' }),
      expected: bad('bad_signature'),
    },
    {
      name: 'signature for another timestamp',
      headers: headers({ 'webhook-timestamp': String(SPEC_TIMESTAMP + 1) }),
      expected: bad('bad_signature'),
    },
    {
      name: 'wrong secret',
      headers: headers(),
      secrets: [OLD_SECRET],
      expected: bad('bad_signature'),
    },
    {
      name: 'no secret configured',
      headers: headers(),
      secrets: [],
      expected: bad('bad_signature'),
    },
    {
      name: 'malformed configured secret is skipped',
      headers: headers(),
      secrets: ['whsec_short', SPEC_SECRET],
      expected: ok,
    },
    {
      name: 'spec "invalid signature"',
      headers: headers({ 'webhook-signature': 'v1,dawfeoifkpqwoekfpqoekf' }),
      expected: bad('bad_signature'),
    },
    {
      name: 'spec "partial signature" (first 8 chars)',
      headers: headers({ 'webhook-signature': VALID_SIG.slice(0, 8) }),
      expected: bad('bad_signature'),
    },
    {
      name: 'spec "partial signature" (v1, only)',
      headers: headers({ 'webhook-signature': 'v1,' }),
      expected: bad('bad_signature'),
    },
    {
      name: 'signature without a version',
      headers: headers({ 'webhook-signature': VALID_SIG.slice(3) }),
      expected: bad('bad_signature'),
    },
    {
      name: 'broken base64 in the signature',
      headers: headers({ 'webhook-signature': `v1,${VALID_SIG.slice(3, -2)}!=` }),
      expected: bad('bad_signature'),
    },
    {
      name: 'missing webhook-id',
      headers: headers({ 'webhook-id': undefined }),
      expected: bad('missing_header'),
    },
    {
      name: 'missing webhook-timestamp',
      headers: headers({ 'webhook-timestamp': undefined }),
      expected: bad('missing_header'),
    },
    {
      name: 'missing webhook-signature',
      headers: headers({ 'webhook-signature': undefined }),
      expected: bad('missing_header'),
    },
    {
      name: 'empty webhook-signature',
      headers: headers({ 'webhook-signature': '' }),
      expected: bad('missing_header'),
    },
    {
      name: 'repeated header (array value)',
      headers: { ...headers(), 'webhook-signature': [VALID_SIG, VALID_SIG] },
      expected: bad('missing_header'),
    },
    {
      name: 'spec "invalid timestamp" (hello)',
      headers: headers({ 'webhook-timestamp': 'hello' }),
      expected: bad('bad_timestamp'),
    },
    {
      name: 'timestamp with trailing junk',
      headers: headers({ 'webhook-timestamp': `${String(SPEC_TIMESTAMP)}abc` }),
      expected: bad('bad_timestamp'),
    },
    {
      name: 'timestamp in milliseconds',
      headers: headers({ 'webhook-timestamp': String(SPEC_TIMESTAMP * 1000) }),
      expected: bad('expired'),
    },
    {
      name: 'negative timestamp',
      headers: headers({ 'webhook-timestamp': '-1' }),
      expected: bad('bad_timestamp'),
    },
    {
      name: 'fractional timestamp',
      headers: headers({ 'webhook-timestamp': `${String(SPEC_TIMESTAMP)}.5` }),
      expected: bad('bad_timestamp'),
    },
    {
      name: 'now = timestamp + 300 s',
      headers: headers(),
      now: new Date((SPEC_TIMESTAMP + 300) * 1000),
      expected: ok,
    },
    {
      name: 'now = timestamp - 300 s',
      headers: headers(),
      now: new Date((SPEC_TIMESTAMP - 300) * 1000),
      expected: ok,
    },
    {
      name: 'now = timestamp + 301 s (too old)',
      headers: headers(),
      now: new Date((SPEC_TIMESTAMP + 301) * 1000),
      expected: bad('expired'),
    },
    {
      name: 'now = timestamp - 301 s (too new)',
      headers: headers(),
      now: new Date((SPEC_TIMESTAMP - 301) * 1000),
      expected: bad('expired'),
    },
    {
      name: 'custom tolerance 60 s, 61 s old',
      headers: headers(),
      now: new Date((SPEC_TIMESTAMP + 61) * 1000),
      tolerance: 60,
      expected: bad('expired'),
    },
    {
      name: 'expired wins over a bad signature',
      headers: headers({ 'webhook-signature': 'v1,dawfeoifkpqwoekfpqoekf' }),
      now: new Date((SPEC_TIMESTAMP + 3600) * 1000),
      expected: bad('expired'),
    },
    {
      name: 'empty body signed as empty',
      headers: headers({
        'webhook-signature': `v1,${referenceSignature(SPEC_SECRET, SPEC_MSG_ID, SPEC_TIMESTAMP, '')}`,
      }),
      body: '',
      expected: ok,
    },
  ];

  it.each(cases)('$name', (c) => {
    expect(
      verifyWebhook(
        c.headers,
        c.body ?? SPEC_PAYLOAD,
        c.secrets ?? [SPEC_SECRET],
        c.now ?? NOW,
        c.tolerance,
      ),
    ).toEqual(c.expected);
  });

  it('round-trips signWebhook with a rotating pair', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'xin chào', n: 1 }));
    const signature = signWebhook({ id: 'evt_A1b2C3d4E5f6G7h8', timestamp: SPEC_TIMESTAMP, body }, [
      generateSigningSecret(),
      OLD_SECRET,
    ]);
    expect(signature.split(' ')).toHaveLength(2);
    expect(
      verifyWebhook(
        {
          'webhook-id': 'evt_A1b2C3d4E5f6G7h8',
          'webhook-timestamp': String(SPEC_TIMESTAMP),
          'webhook-signature': signature,
        },
        body,
        [OLD_SECRET],
        NOW,
      ),
    ).toEqual({ ok: true });
  });
});
