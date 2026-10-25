import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  hashHookSecret,
  IncomingWebhookCredentials,
  incomingWebhookUrl,
  isWellFormedHookToken,
} from '../../src/webhooks/incoming/index.js';
import { parseSigningSecret } from '../../src/webhooks/standard-webhooks.js';

const MASTER = Buffer.alloc(32, 7);
const OTHER_MASTER = Buffer.alloc(32, 8);

/** BACKLOG T602, ADR-35 §1: credentials of an incoming webhook at rest. */
describe('IncomingWebhookCredentials', () => {
  const credentials = new IncomingWebhookCredentials(MASTER);

  it('issues a 32-byte URL token with its SHA-256 and a sealed copy that round-trips', () => {
    const issued = credentials.issueToken();
    expect(isWellFormedHookToken(issued.token)).toBe(true);
    expect(Buffer.from(issued.token, 'base64url')).toHaveLength(32);
    expect(issued.tokenHash).toBe(createHash('sha256').update(issued.token).digest('hex'));
    expect(issued.tokenEnc).not.toContain(issued.token);
    expect(credentials.unsealToken(issued.tokenEnc)).toBe(issued.token);
  });

  it('issues a whsec_ signing secret of 32 bytes, sealed under another key than the token', () => {
    const issued = credentials.issueSigningSecret();
    expect(parseSigningSecret(issued.secret)).toHaveLength(32);
    expect(issued.secretEnc).not.toContain(issued.secret.slice(6));
    expect(credentials.unsealSigningSecret(issued.secretEnc)).toBe(issued.secret);
    // Purpose-separated keys: a sealed signing secret does not open as a token.
    expect(() => credentials.unsealToken(issued.secretEnc)).toThrow();
  });

  it('issues a Bearer token and keeps only its hash', () => {
    const issued = credentials.issueBearer();
    expect(isWellFormedHookToken(issued.token)).toBe(true);
    expect(issued.bearerHash).toBe(hashHookSecret(issued.token));
    expect(issued.bearerHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never issues the same value twice and seals with a fresh IV', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => credentials.issueToken().token));
    expect(tokens.size).toBe(50);
    expect(credentials.sealToken('same')).not.toBe(credentials.sealToken('same'));
  });

  it.each([
    ['another master key', () => new IncomingWebhookCredentials(OTHER_MASTER)],
    ['the same master key', () => new IncomingWebhookCredentials(MASTER)],
  ])('opens a sealed token with %s only when it is the same key', (name, make) => {
    const sealed = credentials.issueToken().tokenEnc;
    if (name === 'another master key') expect(() => make().unsealToken(sealed)).toThrow();
    else expect(make().unsealToken(sealed)).toBe(credentials.unsealToken(sealed));
  });

  it('refuses an altered ciphertext', () => {
    const sealed = Buffer.from(credentials.issueToken().tokenEnc, 'base64url');
    sealed[sealed.length - 1] = (sealed.at(-1) ?? 0) ^ 1;
    expect(() => credentials.unsealToken(sealed.toString('base64url'))).toThrow();
  });
});

describe('isWellFormedHookToken', () => {
  it.each([
    ['A'.repeat(43), true],
    ['-_'.repeat(21) + 'a', true],
    ['A'.repeat(42), false],
    ['A'.repeat(44), false],
    ['A'.repeat(42) + '+', false],
    ['A'.repeat(42) + '=', false],
    ['', false],
    ['../' + 'A'.repeat(40), false],
  ])('%j → %s', (token, ok) => {
    expect(isWellFormedHookToken(token)).toBe(ok);
  });
});

describe('incomingWebhookUrl', () => {
  it.each([
    ['https://ob.example', 'https://ob.example/api/v1/hooks/TOKEN'],
    ['https://ob.example/', 'https://ob.example/api/v1/hooks/TOKEN'],
    ['https://ob.example/base//', 'https://ob.example/base/api/v1/hooks/TOKEN'],
    ['http://localhost:3000', 'http://localhost:3000/api/v1/hooks/TOKEN'],
  ])('%s → %s', (publicUrl, url) => {
    expect(incomingWebhookUrl(publicUrl, 'TOKEN')).toBe(url);
  });
});
