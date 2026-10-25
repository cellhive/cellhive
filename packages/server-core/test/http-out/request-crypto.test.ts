import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  deriveDeliveryKey,
  openDeliveryRequest,
  sealDeliveryRequest,
  type HttpDeliveryRequest,
} from '../../src/http-out/request-crypto.js';

const MASTER = Buffer.alloc(32, 7);
const REQUEST: HttpDeliveryRequest = {
  method: 'POST',
  url: 'https://hooks.example.com/in?token=canary-url-token',
  headers: [
    ['Content-Type', 'application/json'],
    ['X-Trace', 'abc'],
  ],
  body: '{"name":"Đơn 1"}',
  authHeaderName: 'Authorization',
  causation: { root_event_id: 'evt_0123456789abcdef', depth: 1, automation_chain: [] },
  signed: true,
};

describe('sealed delivery request (T605, ADR-35 §4)', () => {
  it('round-trips the request', () => {
    const key = deriveDeliveryKey(MASTER);
    const sealed = sealDeliveryRequest(key, REQUEST);
    // A request sealed without the flag (T605) fails on HTTP errors (T606 default).
    expect(openDeliveryRequest(key, sealed)).toEqual({ ...REQUEST, failOnHttpError: true });
  });

  it('keeps fail_on_http_error: false (T606)', () => {
    const key = deriveDeliveryKey(MASTER);
    const sealed = sealDeliveryRequest(key, { ...REQUEST, failOnHttpError: false });
    expect(openDeliveryRequest(key, sealed)).toEqual({ ...REQUEST, failOnHttpError: false });
  });

  it('never shows the URL, headers or body in clear', () => {
    const sealed = sealDeliveryRequest(deriveDeliveryKey(MASTER), REQUEST);
    for (const canary of ['canary-url-token', 'hooks.example.com', 'X-Trace', 'Đơn']) {
      expect(sealed).not.toContain(canary);
    }
  });

  it('uses a key of its own (not the org-secret key)', () => {
    const sealed = sealDeliveryRequest(deriveDeliveryKey(MASTER), REQUEST);
    expect(openDeliveryRequest(deriveDeliveryKey(Buffer.alloc(32, 8)), sealed)).toBeNull();
  });

  it('refuses an altered or malformed value', () => {
    const key = deriveDeliveryKey(MASTER);
    const sealed = sealDeliveryRequest(key, REQUEST);
    // Every character of a sealed value carries data bits except the last one
    // (it may hold unused low bits): change one of them to another character.
    const at = sealed.length - 2;
    const altered = `${sealed.slice(0, at)}${sealed[at] === 'A' ? 'B' : 'A'}${sealed.slice(at + 1)}`;
    expect(altered).not.toBe(sealed);
    expect(openDeliveryRequest(key, altered)).toBeNull();
    expect(openDeliveryRequest(key, 'not sealed')).toBeNull();
    expect(openDeliveryRequest(key, '')).toBeNull();
  });

  it('refuses another spelling of the same bytes (non-canonical base64url)', () => {
    const key = deriveDeliveryKey(MASTER);
    const sealed = sealDeliveryRequest(key, REQUEST);
    const spellings = [
      `${sealed}=`,
      `${sealed.slice(0, 4)}.${sealed.slice(4)}`,
      `${sealed.slice(0, 4)}\n${sealed.slice(4)}`,
      sealed.replaceAll('-', '+').replaceAll('_', '/'),
    ];
    // The last character's unused low bits, when it has any.
    const last = Buffer.from(sealed, 'base64url').length % 3;
    if (last !== 0) {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const index = alphabet.indexOf(sealed.at(-1) ?? '');
      spellings.push(`${sealed.slice(0, -1)}${alphabet[index ^ 1] ?? ''}`);
    }
    for (const spelling of spellings) {
      if (spelling === sealed) continue;
      expect(Buffer.from(spelling, 'base64url').equals(Buffer.from(sealed, 'base64url'))).toBe(
        true,
      );
      expect(openDeliveryRequest(key, spelling)).toBeNull();
    }
  });
});
