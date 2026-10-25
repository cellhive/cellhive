import { Buffer } from 'node:buffer';
import { createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { BASE62_ALPHABET, ID_RANDOM_LENGTH, type Id } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  CAUSATION_HOOK_PATH_PREFIX,
  CAUSATION_TOKEN_TTL_S,
  causationTarget,
  decodeCausationToken,
  deriveCausationKey,
  encodeCausationToken,
  type CausationTokenResult,
} from '../../src/automation/index.js';
import {
  MAX_CAUSATION_CHAIN,
  MAX_CAUSATION_DEPTH,
  type Causation,
} from '../../src/events/index.js';

const MASTER = Buffer.alloc(32, 0x11).toString('base64');
const OTHER_MASTER = Buffer.alloc(32, 0x22).toString('base64');
const KEY = deriveCausationKey(MASTER);
const OTHER_KEY = deriveCausationKey(OTHER_MASTER);

const HOST = 'cellhive.example.com';
const PATH = '/api/v1/hooks/obh_AbCdEfGhIjKlMnOpQrStUvWx';
const NOW = new Date('2026-10-18T08:00:00.000Z');

const CAUSATION: Causation = {
  root_event_id: 'evt_Root000000000001',
  depth: 2,
  automation_chain: ['aut_Automation000001', 'aut_Automation000002'],
};

function at(offsetS: number): Date {
  return new Date(NOW.getTime() + offsetS * 1000);
}

function encode(
  overrides: { key?: Buffer; host?: string; path?: string; now?: Date } = {},
): string {
  return encodeCausationToken(CAUSATION, {
    key: overrides.key ?? KEY,
    host: overrides.host ?? HOST,
    path: overrides.path ?? PATH,
    now: overrides.now ?? NOW,
  });
}

/** Flips one bit of byte `index` of the token body (after `v1.`). */
function flipByte(token: string, index: number): string {
  const raw = Buffer.from(token.slice(3), 'base64url');
  raw[index] = (raw[index] ?? 0) ^ 0x01;
  return `v1.${raw.toString('base64url')}`;
}

describe('deriveCausationKey', () => {
  it('is HKDF-SHA256(APP_MASTER_KEY, info "automation-causation-v1"), 32 bytes (ADR-27)', () => {
    const expected = Buffer.from(
      hkdfSync('sha256', MASTER, Buffer.alloc(0), 'automation-causation-v1', 32),
    );
    expect(KEY.equals(expected)).toBe(true);
    expect(KEY).toHaveLength(32);
  });
});

describe('causationTarget', () => {
  const cases: { name: string; a: [string, string]; b: [string, string]; same: boolean }[] = [
    { name: 'identical', a: [HOST, PATH], b: [HOST, PATH], same: true },
    { name: 'host case', a: [HOST, PATH], b: [HOST.toUpperCase(), PATH], same: true },
    { name: 'host trailing dot', a: [HOST, PATH], b: [`${HOST}.`, PATH], same: true },
    { name: 'default port 443', a: [HOST, PATH], b: [`${HOST}:443`, PATH], same: true },
    { name: 'default port 80', a: [HOST, PATH], b: [`${HOST}:80`, PATH], same: true },
    { name: 'query is ignored', a: [HOST, PATH], b: [HOST, `${PATH}?x=1`], same: true },
    { name: 'fragment is ignored', a: [HOST, PATH], b: [HOST, `${PATH}#x`], same: true },
    { name: 'other port', a: [HOST, PATH], b: [`${HOST}:3000`, PATH], same: false },
    { name: 'other host', a: [HOST, PATH], b: ['api', PATH], same: false },
    { name: 'path case', a: [HOST, PATH], b: [HOST, PATH.toUpperCase()], same: false },
    { name: 'trailing slash', a: [HOST, PATH], b: [HOST, `${PATH}/`], same: false },
    {
      name: 'IPv6 literal with port',
      a: ['[::1]:3000', PATH],
      b: ['[::1]:3000', PATH],
      same: true,
    },
  ];

  it.each(cases)('$name', ({ a, b, same }) => {
    expect(causationTarget(a[0], a[1]).equals(causationTarget(b[0], b[1]))).toBe(same);
  });

  it('is SHA-256 of host + path', () => {
    expect(
      causationTarget(HOST, PATH).equals(createHash('sha256').update(`${HOST}${PATH}`).digest()),
    ).toBe(true);
  });
});

describe('encodeCausationToken', () => {
  it('produces v1.<base64url> and a different token every call (fresh IV)', () => {
    const a = encode();
    const b = encode();
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });

  it('is AES-256-GCM over { root_event_id, depth, automation_chain, target, exp }', () => {
    const raw = Buffer.from(encode().slice(3), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const payload = JSON.parse(
      Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload).toEqual({
      root_event_id: CAUSATION.root_event_id,
      depth: CAUSATION.depth,
      automation_chain: CAUSATION.automation_chain,
      target: causationTarget(HOST, PATH).toString('base64url'),
      exp: Math.floor(NOW.getTime() / 1000) + CAUSATION_TOKEN_TTL_S,
    });
    expect(CAUSATION_TOKEN_TTL_S).toBe(3600);
  });

  it('does not reveal ids in clear text', () => {
    const token = encode();
    const decoded = Buffer.from(token.slice(3), 'base64url').toString('latin1');
    expect(decoded).not.toContain('evt_');
    expect(decoded).not.toContain('aut_');
  });

  it.each<{ name: string; causation: Causation }>([
    { name: 'depth above the limit', causation: { ...CAUSATION, depth: MAX_CAUSATION_DEPTH + 1 } },
    { name: 'negative depth', causation: { ...CAUSATION, depth: -1 } },
    { name: 'bad root id', causation: { ...CAUSATION, root_event_id: 'evt_x' } },
    {
      name: 'chain too long',
      causation: {
        ...CAUSATION,
        automation_chain: Array.from(
          { length: MAX_CAUSATION_CHAIN + 1 },
          () => 'aut_Automation000001',
        ),
      },
    },
  ])('throws on $name', ({ causation }) => {
    expect(() =>
      encodeCausationToken(causation, { key: KEY, host: HOST, path: PATH, now: NOW }),
    ).toThrow(RangeError);
  });
});

describe('decodeCausationToken', () => {
  const fail = (reason: string): CausationTokenResult =>
    ({ ok: false, reason }) as CausationTokenResult;
  const ok: CausationTokenResult = { ok: true, causation: CAUSATION };
  const valid = encode();

  const cases: {
    name: string;
    token: string;
    hosts?: (string | null | undefined)[];
    path?: string;
    now?: Date;
    key?: Buffer;
    expected: CausationTokenResult;
  }[] = [
    { name: 'valid', token: valid, expected: ok },
    {
      name: 'valid, matched by the Host header (2nd host)',
      token: encode({ host: 'api:3000' }),
      hosts: [HOST, 'api:3000'],
      expected: ok,
    },
    { name: 'valid, Host header missing', token: valid, hosts: [HOST, undefined], expected: ok },
    {
      name: 'valid, PUBLIC_URL host unset',
      token: encode({ host: 'api:3000' }),
      hosts: [null, 'api:3000'],
      expected: ok,
    },
    {
      name: 'valid, request path carries a query',
      token: valid,
      path: `${PATH}?a=1`,
      expected: ok,
    },
    { name: 'valid just before exp (+3600 s)', token: valid, now: at(3600), expected: ok },
    { name: 'expired (+3601 s)', token: valid, now: at(3601), expected: fail('expired') },
    { name: 'expired a day later', token: valid, now: at(86_400), expected: fail('expired') },
    {
      name: 'other path',
      token: valid,
      path: '/api/v1/hooks/obh_Other',
      expected: fail('target_mismatch'),
    },
    {
      name: 'other host',
      token: valid,
      hosts: ['evil.example.com', 'api:3000'],
      expected: fail('target_mismatch'),
    },
    {
      name: 'no host at all',
      token: valid,
      hosts: [null, undefined],
      expected: fail('target_mismatch'),
    },
    {
      name: 'other port on the same host',
      token: valid,
      hosts: [`${HOST}:8443`],
      expected: fail('target_mismatch'),
    },
    { name: 'other master key', token: valid, key: OTHER_KEY, expected: fail('bad_tag') },
    {
      name: 'made under another master key',
      token: encode({ key: OTHER_KEY }),
      expected: fail('bad_tag'),
    },
    { name: 'one byte changed in the IV', token: flipByte(valid, 0), expected: fail('bad_tag') },
    { name: 'one byte changed in the tag', token: flipByte(valid, 13), expected: fail('bad_tag') },
    {
      name: 'one byte changed in the ciphertext',
      token: flipByte(valid, 40),
      expected: fail('bad_tag'),
    },
    {
      name: 'last byte changed',
      token: flipByte(valid, Buffer.from(valid.slice(3), 'base64url').length - 1),
      expected: fail('bad_tag'),
    },
    { name: 'empty', token: '', expected: fail('malformed') },
    { name: 'version only', token: 'v1.', expected: fail('malformed') },
    { name: 'unknown version', token: `v2.${valid.slice(3)}`, expected: fail('malformed') },
    { name: 'no version', token: valid.slice(3), expected: fail('malformed') },
    {
      name: 'standard base64 characters',
      token: `v1.${valid.slice(3, -1)}+`,
      expected: fail('malformed'),
    },
    { name: 'padding', token: `${valid}=`, expected: fail('malformed') },
    { name: 'whitespace', token: ` ${valid}`, expected: fail('malformed') },
    {
      name: 'too short for IV + tag',
      token: `v1.${Buffer.alloc(27).toString('base64url')}`,
      expected: fail('malformed'),
    },
    { name: 'oversized', token: `v1.${'A'.repeat(8192)}`, expected: fail('malformed') },
    { name: 'truncated by 3 bytes', token: valid.slice(0, -4), expected: fail('bad_tag') },
    {
      name: 'impossible base64url length',
      token: `v1.${'A'.repeat(41)}`,
      expected: fail('malformed'),
    },
  ];

  it.each(cases)('$name', (c) => {
    expect(
      decodeCausationToken(c.token, {
        key: c.key ?? KEY,
        hosts: c.hosts ?? [HOST, 'api:3000'],
        path: c.path ?? PATH,
        now: c.now ?? NOW,
      }),
    ).toEqual(c.expected);
  });

  it('decode(encode(x)) = x for 1,000 generated causations (property)', () => {
    const random = mulberry32(0x5eed601);
    const pick = (n: number): number => Math.floor(random() * n);
    const id = <P extends 'evt' | 'aut'>(prefix: P): Id<P> =>
      `${prefix}_${Array.from({ length: ID_RANDOM_LENGTH }, () => BASE62_ALPHABET[pick(62)]).join('')}`;
    const hosts = [
      'cellhive.example.com',
      'api:3000',
      '10.0.0.5:8080',
      'xn--bcher-kva.example',
      '[::1]:3000',
    ];

    for (let i = 0; i < 1000; i += 1) {
      const causation: Causation = {
        root_event_id: id('evt'),
        depth: pick(MAX_CAUSATION_DEPTH + 1),
        automation_chain: Array.from({ length: pick(MAX_CAUSATION_CHAIN + 1) }, () => id('aut')),
      };
      const host = hosts[pick(hosts.length)] ?? HOST;
      const path = `/api/v1/hooks/obh_${String(i)}`;
      const now = new Date(1_700_000_000_000 + pick(1_000_000_000) * 1000);
      const token = encodeCausationToken(causation, { key: KEY, host, path, now });
      const result = decodeCausationToken(token, {
        key: KEY,
        hosts: [HOST, host],
        path,
        now: new Date(now.getTime() + pick(3601) * 1000),
      });
      expect(result).toEqual({ ok: true, causation });
    }
  });
});

describe('decodeCausationToken, path-prefix mode (instance-bound, ADR-27 §5 amendment)', () => {
  const fail = (reason: string): CausationTokenResult =>
    ({ ok: false, reason }) as CausationTokenResult;
  const ok: CausationTokenResult = { ok: true, causation: CAUSATION };
  /** What the outbound side sends: `PUBLIC_URL` host + the hook prefix. */
  const instance = encode({ path: CAUSATION_HOOK_PATH_PREFIX });

  const cases: {
    name: string;
    token: string;
    hosts?: (string | null | undefined)[];
    path: string;
    expected: CausationTokenResult;
  }[] = [
    { name: 'a hook below the prefix', token: instance, path: PATH, expected: ok },
    {
      name: 'any other hook of this instance (forwarded or copied)',
      token: instance,
      path: '/api/v1/hooks/obh_Other',
      expected: ok,
    },
    {
      name: 'a hook path with a query',
      token: instance,
      path: `${PATH}?x=1#f`,
      expected: ok,
    },
    { name: 'the prefix itself', token: instance, path: CAUSATION_HOOK_PATH_PREFIX, expected: ok },
    {
      name: 'matched by the Host header after TRUSTED_PROXIES',
      token: encode({ host: 'api:3000', path: CAUSATION_HOOK_PATH_PREFIX }),
      hosts: [HOST, 'api:3000'],
      path: PATH,
      expected: ok,
    },
    {
      name: 'path outside the prefix',
      token: instance,
      path: '/api/v1/records',
      expected: fail('target_mismatch'),
    },
    {
      name: 'prefix without a segment boundary',
      token: instance,
      path: '/api/v1/hooksX/obh_A',
      expected: fail('target_mismatch'),
    },
    {
      name: 'bound to the destination URL (n8n), not this instance',
      token: encode({ host: 'n8n.internal:5678', path: '/webhook/abc' }),
      path: PATH,
      expected: fail('target_mismatch'),
    },
    {
      name: 'bound to an exact hook path (pre-amendment token)',
      token: encode(),
      path: PATH,
      expected: fail('target_mismatch'),
    },
    {
      name: 'bound to another instance',
      token: encode({ host: 'other.example.com', path: CAUSATION_HOOK_PATH_PREFIX }),
      path: PATH,
      expected: fail('target_mismatch'),
    },
    {
      name: 'forged (one byte changed)',
      token: flipByte(instance, 40),
      path: PATH,
      expected: fail('bad_tag'),
    },
    { name: 'broken', token: 'v1.garbage', path: PATH, expected: fail('malformed') },
  ];

  it.each(cases)('$name', (c) => {
    expect(
      decodeCausationToken(c.token, {
        key: KEY,
        hosts: c.hosts ?? [HOST, 'api:3000'],
        path: c.path,
        pathPrefix: CAUSATION_HOOK_PATH_PREFIX,
        now: NOW,
      }),
    ).toEqual(c.expected);
  });

  it('still expires after 1 h', () => {
    expect(
      decodeCausationToken(instance, {
        key: KEY,
        hosts: [HOST],
        path: PATH,
        pathPrefix: CAUSATION_HOOK_PATH_PREFIX,
        now: at(CAUSATION_TOKEN_TTL_S + 1),
      }),
    ).toEqual(fail('expired'));
  });

  it('a trailing slash on the prefix is the same prefix', () => {
    expect(
      decodeCausationToken(instance, {
        key: KEY,
        hosts: [HOST],
        path: PATH,
        pathPrefix: `${CAUSATION_HOOK_PATH_PREFIX}/`,
        now: NOW,
      }),
    ).toEqual(ok);
  });
});

describe('golden rules', () => {
  it.each(['src/automation/causation/token.ts', 'src/webhooks/standard-webhooks.ts'])(
    '%s uses no eval / new Function / vm and logs nothing',
    (file) => {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/\beval\s*\(|new\s+Function\b|from\s+'node:vm'|\bconsole\./);
      expect(source).not.toMatch(/\blogger\b|\bLogger\b/);
    },
  );
});

/** Small seeded PRNG so the property test is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
