import { describe, expect, it } from 'vitest';

import {
  deriveLocalSigningKey,
  localGrantQuery,
  verifyLocalRequest,
  type LocalGrant,
} from '../../src/storage/index.js';

const KEY = deriveLocalSigningKey('test-session-secret-0123456789abcdef');
const OTHER_KEY = deriveLocalSigningKey('another-session-secret-0123456789abc');
const NOW = 1_800_000_000;

const PUT: LocalGrant = {
  method: 'PUT',
  key: 'org_A1b2C3d4E5f6G7h8/att_A1b2C3d4E5f6G7h8',
  expiresAt: NOW + 600,
  contentType: 'image/png',
  maxBytes: 1024,
};
const GET: LocalGrant = {
  method: 'GET',
  key: 'org_A1b2C3d4E5f6G7h8/att_A1b2C3d4E5f6G7h8',
  expiresAt: NOW + 60,
  filename: 'Báo cáo.pdf',
  disposition: 'attachment',
};

function queryOf(grant: LocalGrant, key = KEY): Record<string, string> {
  return Object.fromEntries(localGrantQuery(key, grant));
}

describe('local storage URL signing', () => {
  it('derives a key that differs from the raw secret', () => {
    expect(KEY).toHaveLength(32);
    expect(KEY.toString('utf8')).not.toContain('test-session-secret');
  });

  it('is deterministic', () => {
    expect(queryOf(PUT)).toEqual(queryOf(PUT));
    expect(queryOf(PUT).sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each([PUT, GET])('accepts an untampered $method URL', (grant) => {
    expect(
      verifyLocalRequest(KEY, {
        method: grant.method,
        key: grant.key,
        query: queryOf(grant),
        now: NOW,
      }),
    ).toEqual({ ok: true, grant });
  });

  it('accepts HEAD with a GET signature', () => {
    expect(
      verifyLocalRequest(KEY, { method: 'HEAD', key: GET.key, query: queryOf(GET), now: NOW }).ok,
    ).toBe(true);
  });

  const tampered: { name: string; method: string; key: string; query: Record<string, unknown> }[] =
    [
      { name: 'other key', method: 'PUT', key: 'org_x/att_y', query: queryOf(PUT) },
      { name: 'GET with a PUT signature', method: 'GET', key: PUT.key, query: queryOf(PUT) },
      { name: 'PUT with a GET signature', method: 'PUT', key: GET.key, query: queryOf(GET) },
      { name: 'DELETE', method: 'DELETE', key: PUT.key, query: queryOf(PUT) },
      {
        name: 'raised max',
        method: 'PUT',
        key: PUT.key,
        query: { ...queryOf(PUT), max: '999999' },
      },
      {
        name: 'changed ct',
        method: 'PUT',
        key: PUT.key,
        query: { ...queryOf(PUT), ct: 'text/html' },
      },
      {
        name: 'extended exp',
        method: 'PUT',
        key: PUT.key,
        query: { ...queryOf(PUT), exp: String(NOW + 9999) },
      },
      { name: 'changed fn', method: 'GET', key: GET.key, query: { ...queryOf(GET), fn: 'x.html' } },
      { name: 'inline', method: 'GET', key: GET.key, query: { ...queryOf(GET), disp: 'inline' } },
      { name: 'other secret', method: 'PUT', key: PUT.key, query: queryOf(PUT, OTHER_KEY) },
      {
        name: 'flipped sig',
        method: 'PUT',
        key: PUT.key,
        query: { ...queryOf(PUT), sig: 'A'.repeat(43) },
      },
      { name: 'short sig', method: 'PUT', key: PUT.key, query: { ...queryOf(PUT), sig: 'abc' } },
      {
        name: 'missing sig',
        method: 'PUT',
        key: PUT.key,
        query: { ...queryOf(PUT), sig: undefined },
      },
      {
        name: 'array sig',
        method: 'PUT',
        key: PUT.key,
        query: { ...queryOf(PUT), sig: ['a', 'b'] },
      },
      { name: 'bad exp', method: 'PUT', key: PUT.key, query: { ...queryOf(PUT), exp: '-1' } },
    ];

  it.each(tampered)('rejects $name as invalid', ({ method, key, query }) => {
    expect(verifyLocalRequest(KEY, { method, key, query, now: NOW })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects an expired URL (expiry is exclusive)', () => {
    const query = queryOf(GET);
    expect(
      verifyLocalRequest(KEY, { method: 'GET', key: GET.key, query, now: GET.expiresAt }),
    ).toEqual({ ok: false, reason: 'expired' });
    expect(
      verifyLocalRequest(KEY, { method: 'GET', key: GET.key, query, now: GET.expiresAt - 1 }).ok,
    ).toBe(true);
  });
});
