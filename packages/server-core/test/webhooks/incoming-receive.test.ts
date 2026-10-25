import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  INCOMING_WEBHOOK_MAX_HEADER_VALUE_LENGTH,
  INCOMING_WEBHOOK_SAMPLE_MAX_BODY_BYTES,
  INCOMING_WEBHOOK_SENSITIVE_HEADERS,
  newId,
} from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { deriveCausationKey, encodeCausationToken } from '../../src/automation/causation/token.js';
import {
  authenticateHookRequest,
  buildSample,
  causationRejectedCounts,
  hashHookSecret,
  inboundCausation,
  messageIdOf,
  parseWebhookBody,
  parseWebhookQuery,
  readLimitedBody,
  sampleFromJson,
  sampleToJson,
  storedWebhookHeaders,
} from '../../src/webhooks/incoming/index.js';
import * as incoming from '../../src/webhooks/incoming/index.js';
import { generateSigningSecret, signWebhook } from '../../src/webhooks/index.js';

const MiB = 1_048_576;
const json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

/**
 * Pure parts of the public route `POST /api/v1/hooks/:token` (BACKLOG
 * T603, ADR-35 §1, CONTRACTS §25.2–§25.3): body by `Content-Type`, query,
 * stored headers, the bounded body reader, credentials, the causation
 * header and the sample.
 */
describe('parseWebhookBody', () => {
  it.each([
    ['JSON object', 'application/json', json({ a: 1 }), { a: 1 }],
    ['JSON array (one request)', 'application/json; charset=utf-8', json([1, 2]), [1, 2]],
    ['JSON charset quoted', 'Application/JSON; charset="UTF-8"', json({ b: true }), { b: true }],
    ['empty body, any type', 'text/plain', Buffer.alloc(0), null],
    ['empty body, no type', undefined, Buffer.alloc(0), null],
    [
      'form with a repeated key',
      'application/x-www-form-urlencoded',
      Buffer.from('a=1&b=x%20y&a=2&c='),
      { a: ['1', '2'], b: 'x y', c: '' },
    ],
    [
      '64 nested arrays (the deepest allowed)',
      'application/json',
      Buffer.from(`${'['.repeat(64)}${']'.repeat(64)}`),
      JSON.parse(`${'['.repeat(64)}${']'.repeat(64)}`) as unknown,
    ],
    [
      '__proto__ stays a plain key',
      'application/x-www-form-urlencoded',
      Buffer.from('__proto__=x'),
      JSON.parse('{"__proto__":"x"}') as unknown,
    ],
  ])('accepts %s', (_name, type, raw, expected) => {
    expect(parseWebhookBody(raw, type)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['text/plain', 'text/plain', Buffer.from('hi'), 'unsupported'],
    ['no Content-Type', undefined, json({ a: 1 }), 'unsupported'],
    ['another charset', 'application/json; charset=latin1', json({ a: 1 }), 'unsupported'],
    ['application/*+json', 'application/vnd.api+json', json({ a: 1 }), 'unsupported'],
    ['broken JSON', 'application/json', Buffer.from('{"a":'), 'malformed'],
    ['JSON scalar', 'application/json', Buffer.from('42'), 'malformed'],
    ['JSON null', 'application/json', Buffer.from('null'), 'malformed'],
    ['invalid UTF-8', 'application/json', Buffer.from([0x7b, 0xff, 0x7d]), 'malformed'],
    ['NUL in a value', 'application/json', Buffer.from('{"a":"x\\u0000"}'), 'malformed'],
    ['NUL in a key', 'application/json', Buffer.from('{"\\u0000":1}'), 'malformed'],
    ['lone surrogate', 'application/json', Buffer.from('["\\ud800"]'), 'malformed'],
    ['NUL in a form', 'application/x-www-form-urlencoded', Buffer.from('a=%00'), 'malformed'],
    // QA S5c: nesting deeper than 64 (a 1 MiB body of `[` made a later JSON.stringify throw).
    [
      '65 nested arrays',
      'application/json',
      Buffer.from(`${'['.repeat(65)}${']'.repeat(65)}`),
      'malformed',
    ],
    [
      '64 nested objects + an array',
      'application/json',
      Buffer.from(`${'{"a":'.repeat(64)}[]${'}'.repeat(64)}`),
      'malformed',
    ],
    [
      '1 MiB of [',
      'application/json',
      Buffer.from(`${'['.repeat(524_288)}${']'.repeat(524_288)}`),
      'malformed',
    ],
  ])('refuses %s', (_name, type, raw, error) => {
    expect(parseWebhookBody(raw, type)).toEqual({ ok: false, error });
  });

  it('keeps a pair of surrogates (emoji)', () => {
    expect(parseWebhookBody(json({ e: '😀' }), 'application/json')).toEqual({
      ok: true,
      value: { e: '😀' },
    });
  });
});

describe('parseWebhookQuery', () => {
  it.each([
    ['', {}],
    ['a=1', { a: '1' }],
    ['a=1&a=2&b', { a: ['1', '2'], b: '' }],
    ['x=%00y', { x: '�y' }],
  ])('parses %j', (search, expected) => {
    expect(parseWebhookQuery(search)).toEqual(expected);
  });
});

describe('storedWebhookHeaders', () => {
  it('drops every sensitive header, keeps order, joins repeated values, cuts long ones', () => {
    const headers: Record<string, string | string[]> = {
      'content-type': 'application/json',
      'x-many': ['a', 'b'],
      'x-long': 'v'.repeat(INCOMING_WEBHOOK_MAX_HEADER_VALUE_LENGTH + 10),
    };
    for (const name of INCOMING_WEBHOOK_SENSITIVE_HEADERS) headers[name] = 'secret';
    headers['Webhook-Signature'] = 'secret';
    const stored = storedWebhookHeaders(headers);
    expect(Object.keys(stored)).toEqual(['content-type', 'x-many', 'x-long']);
    expect(stored['x-many']).toBe('a, b');
    expect(stored['x-long']).toHaveLength(INCOMING_WEBHOOK_MAX_HEADER_VALUE_LENGTH);
    expect(JSON.stringify(stored)).not.toContain('secret');
  });

  it('keeps at most 50 headers', () => {
    const headers = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`x-h${String(index)}`, 'v']),
    );
    expect(Object.keys(storedWebhookHeaders(headers))).toHaveLength(50);
  });
});

describe('readLimitedBody', () => {
  /** A stream of `total` bytes in 16 KiB chunks that counts how much was pulled. */
  function counted(total: number) {
    let pulled = 0;
    const chunk = 16 * 1024;
    const stream = new Readable({
      highWaterMark: 64 * 1024,
      read() {
        if (pulled >= total) {
          this.push(null);
          return;
        }
        const size = Math.min(chunk, total - pulled);
        pulled += size;
        this.push(Buffer.alloc(size, 0x61));
      },
    });
    return { stream, pulled: () => pulled };
  }

  it('reads a body up to the limit', async () => {
    const { stream } = counted(MiB);
    const result = await readLimitedBody(stream, MiB);
    expect(result.ok && result.body.length).toBe(MiB);
  });

  it('stops at limit + 1 byte and pulls at most one stream buffer more', async () => {
    const { stream, pulled } = counted(8 * MiB);
    const result = await readLimitedBody(stream, MiB);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
    // Let the paused stream settle: nothing more is read.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pulled()).toBeLessThanOrEqual(MiB + 64 * 1024 + 16 * 1024);
  });

  it('answers an empty body for an ended stream', async () => {
    const stream = Readable.from([]);
    await new Promise((resolve) => stream.on('end', resolve).resume());
    expect(await readLimitedBody(stream, 10)).toEqual({ ok: true, body: Buffer.alloc(0) });
  });

  it('rejects when the client goes away mid-body', async () => {
    const stream = new Readable({ read() {} });
    const reading = readLimitedBody(stream, MiB);
    stream.push(Buffer.from('partial'));
    stream.destroy();
    await expect(reading).rejects.toThrow('aborted');
  });
});

describe('authenticateHookRequest', () => {
  const now = new Date('2026-10-18T10:00:00Z');
  const secret = generateSigningSecret();
  const previous = generateSigningSecret();
  const bearer = 'b'.repeat(43);
  const body = json({ order: 1 });
  const signed = (secrets: string[], id = 'msg_1', at = now) => ({
    'webhook-id': id,
    'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
    'webhook-signature': signWebhook(
      { id, timestamp: Math.floor(at.getTime() / 1000), body },
      secrets,
    ),
  });
  const hook = (auth: 'signature' | 'bearer' | 'both' | 'none', secrets = [secret]) => ({
    auth,
    bearerHash: auth === 'bearer' || auth === 'both' ? hashHookSecret(bearer) : null,
    signingSecrets: auth === 'signature' || auth === 'both' ? secrets : [],
  });

  it.each([
    ['none: anyone', hook('none'), {}, { ok: true, messageId: null }],
    [
      'bearer: right token',
      hook('bearer'),
      { authorization: `Bearer ${bearer}` },
      { ok: true, messageId: null },
    ],
    [
      'bearer: scheme in any case',
      hook('bearer'),
      { authorization: `bearer ${bearer}` },
      { ok: true, messageId: null },
    ],
    ['bearer: missing', hook('bearer'), {}, { ok: false }],
    ['bearer: wrong', hook('bearer'), { authorization: `Bearer ${'c'.repeat(43)}` }, { ok: false }],
    ['bearer: Basic', hook('bearer'), { authorization: `Basic ${bearer}` }, { ok: false }],
    ['signature: valid', hook('signature'), signed([secret]), { ok: true, messageId: 'msg_1' }],
    [
      'signature: previous secret still valid',
      hook('signature', [secret, previous]),
      signed([previous]),
      { ok: true, messageId: 'msg_1' },
    ],
    ['signature: missing', hook('signature'), {}, { ok: false }],
    ['signature: other secret', hook('signature'), signed([previous]), { ok: false }],
    [
      'signature: 301 s old',
      hook('signature'),
      signed([secret], 'msg_1', new Date(now.getTime() - 301_000)),
      { ok: false },
    ],
    ['both: signature without Bearer', hook('both'), signed([secret]), { ok: false }],
    [
      'both: both right',
      hook('both'),
      { ...signed([secret]), authorization: `Bearer ${bearer}` },
      { ok: true, messageId: 'msg_1' },
    ],
  ])('%s', (_name, input, headers, expected) => {
    expect(authenticateHookRequest(input, headers, body, now)).toEqual(expected);
  });

  it('stores a webhook-id over 256 characters as its SHA-256', () => {
    const id = 'x'.repeat(300);
    expect(messageIdOf('x'.repeat(256))).toBe('x'.repeat(256));
    expect(messageIdOf(id)).toBe(`sha256:${createHash('sha256').update(id).digest('hex')}`);
    const ts = String(Math.floor(now.getTime() / 1000));
    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    const sig = createHmac('sha256', key).update(`${id}.${ts}.`).update(body).digest('base64');
    const headers = { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` };
    expect(authenticateHookRequest(hook('signature'), headers, body, now)).toEqual({
      ok: true,
      messageId: messageIdOf(id),
    });
  });
});

describe('inboundCausation', () => {
  const key = deriveCausationKey(Buffer.alloc(32, 7));
  const now = new Date('2026-10-18T10:00:00Z');
  const path = '/api/v1/hooks/tok';
  const chain = (depth: number) => ({
    root_event_id: newId('evt'),
    depth,
    automation_chain: [newId('aut')],
  });
  /** Bound to this instance (host + `/api/v1/hooks`), as `HttpDeliverer` sends it. */
  const token = (depth: number, host = 'api:3000', tokenPath = '/api/v1/hooks') =>
    encodeCausationToken(chain(depth), { key, host, path: tokenPath, now });
  const decode = (header: string | string[] | undefined, host = 'api:3000', requestPath = path) =>
    inboundCausation(header, {
      key,
      hosts: ['cellhive.example.com', host],
      path: requestPath,
      now,
    });

  it('starts a new chain without the header', () => {
    expect(decode(undefined)).toEqual({ causation: undefined, accepted: false });
  });

  it('continues a valid chain with depth + 1 (Host api:3000 after TRUSTED_PROXIES)', () => {
    const result = decode(token(2));
    expect(result.accepted).toBe(true);
    expect(result.causation?.depth).toBe(3);
    expect(result.causation?.automation_chain).toHaveLength(1);
  });

  it('accepts the PUBLIC_URL host as target too', () => {
    expect(decode(token(0, 'cellhive.example.com'), 'other:3000').accepted).toBe(true);
  });

  it('accepts the token on any hook of this instance (forwarded by n8n, or copied)', () => {
    const header = token(1, 'cellhive.example.com');
    expect(decode(header, 'n8n-callback:3000', '/api/v1/hooks/first').causation?.depth).toBe(2);
    expect(decode(header, 'n8n-callback:3000', '/api/v1/hooks/second?q=1').accepted).toBe(true);
  });

  it('caps depth 5 + 1 at 5, which the loop guard still stops', () => {
    expect(decode(token(5)).causation?.depth).toBe(5);
  });

  it.each([
    ['malformed', 'garbage'],
    ['malformed', ['a', 'b']],
    ['bad_tag', `${token(1).slice(0, -4)}AAAA`],
    ['target_mismatch', token(1, 'n8n.internal:5678', '/webhook/abc')],
    ['target_mismatch', token(1, 'api:3000', '/api/v1/hooks/tok')],
    ['target_mismatch', token(1, 'other-instance.example.com')],
  ] as const)('rejects a %s token: depth 0 and the metric', (reason, header) => {
    const before = causationRejectedCounts().get(reason) ?? 0;
    expect(decode(header as string | string[])).toEqual({ causation: undefined, accepted: false });
    expect(causationRejectedCounts().get(reason)).toBe(before + 1);
  });
});

describe('inboundCausation outside the hook prefix', () => {
  it('rejects a valid instance token on a path outside /api/v1/hooks', () => {
    const key = deriveCausationKey(Buffer.alloc(32, 7));
    const now = new Date('2026-10-18T10:00:00Z');
    const header = encodeCausationToken(
      { root_event_id: newId('evt'), depth: 1, automation_chain: [newId('aut')] },
      { key, host: 'cellhive.example.com', path: '/api/v1/hooks', now },
    );
    const before = causationRejectedCounts().get('target_mismatch') ?? 0;
    expect(
      inboundCausation(header, {
        key,
        hosts: ['cellhive.example.com'],
        path: '/api/v1/hooksX/tok',
        now,
      }),
    ).toEqual({ causation: undefined, accepted: false });
    expect(causationRejectedCounts().get('target_mismatch')).toBe(before + 1);
  });
});

describe('sample', () => {
  it('keeps a small body and round-trips through jsonb form', () => {
    const sample = buildSample({ body: { a: 1 }, headers: { h: 'v' }, query: { q: ['1', '2'] } });
    expect(sample.truncated).toBe(false);
    expect(sampleFromJson(sampleToJson(sample))).toEqual(sample);
  });

  it('cuts a 100 KB body to 64 KB of whole UTF-8 characters', () => {
    const body = { text: 'é'.repeat(50_000) };
    const sample = buildSample({ body, headers: {}, query: {} });
    expect(sample.truncated).toBe(true);
    expect(typeof sample.body).toBe('string');
    const bytes = Buffer.byteLength(sample.body as string, 'utf8');
    expect(bytes).toBeLessThanOrEqual(INCOMING_WEBHOOK_SAMPLE_MAX_BODY_BYTES);
    expect(bytes).toBeGreaterThan(INCOMING_WEBHOOK_SAMPLE_MAX_BODY_BYTES - 4);
    expect(sample.body as string).not.toContain('�');
  });

  it('reads nothing back from a value that is not a sample', () => {
    expect(sampleFromJson(null)).toBeNull();
    expect(sampleFromJson({ body: 1, headers: { a: 2 }, query: {}, truncated: false })).toBeNull();
  });

  it('is exported from the incoming webhook module', () => {
    expect(typeof incoming.recordIncomingWebhookRequest).toBe('function');
  });
});
