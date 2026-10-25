import { createServer, type Server, AddressInfo, Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyAddress,
  guardedSmtpSocket,
  normalizeSmtpHost,
  resolveAllowedSmtpHost,
  SmtpHostError,
  type HostLookup,
} from '../../../src/mail/identities/index.js';

describe('classifyAddress (SPEC §14.3, ADR-33 §1A)', () => {
  it.each([
    // Public.
    ['93.184.216.34', 'public'],
    ['8.8.8.8', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['172.32.0.1', 'public'],
    // Private: allowed only with SMTP_ALLOW_PRIVATE_HOSTS.
    ['127.0.0.1', 'private'],
    ['127.255.255.254', 'private'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.10', 'private'],
    ['100.64.0.1', 'private'],
    ['169.254.10.10', 'private'],
    ['198.18.0.1', 'private'],
    ['::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fc00::1', 'private'],
    ['fe80::1', 'private'],
    ['fe80::1%en0', 'private'],
    // IPv4 inside IPv6 is judged by the IPv4 address.
    ['::ffff:127.0.0.1', 'private'],
    ['::ffff:7f00:1', 'private'],
    ['::ffff:10.0.0.5', 'private'],
    ['::ffff:93.184.216.34', 'public'],
    ['64:ff9b::a00:5', 'private'],
    ['2002:a00:5::1', 'private'],
    ['2002:5db8:d822::1', 'public'],
    // Always blocked, even with SMTP_ALLOW_PRIVATE_HOSTS.
    ['169.254.169.254', 'blocked'],
    ['::ffff:169.254.169.254', 'blocked'],
    ['169.254.170.2', 'blocked'],
    ['100.100.100.200', 'blocked'],
    ['fd00:ec2::254', 'blocked'],
    ['0.0.0.0', 'blocked'],
    ['::', 'blocked'],
    ['224.0.0.1', 'blocked'],
    ['ff02::1', 'blocked'],
    ['255.255.255.255', 'blocked'],
    ['240.0.0.1', 'blocked'],
    ['not-an-ip', 'blocked'],
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe('normalizeSmtpHost', () => {
  it.each([
    ['Mail.Example.COM', 'mail.example.com'],
    ['  smtp.office365.com  ', 'smtp.office365.com'],
    ['mail.example.com.', 'mail.example.com'],
    ['bücher.example', 'xn--bcher-kva.example'],
    ['mail', 'mail'],
    ['127.0.0.1', '127.0.0.1'],
    ['[::1]', '::1'],
    ['FE80::1', 'fe80::1'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeSmtpHost(input)).toBe(expected);
  });

  it.each([
    '',
    'smtp://mail.example.com',
    'mail.example.com:587',
    'user@mail.example.com',
    'mail.example.com/path',
    'mail example.com',
    '-mail.example.com',
    '1234',
    '0x7f.1',
    '127.1',
    'a'.repeat(254),
  ])('rejects %j', (input) => {
    expect(normalizeSmtpHost(input)).toBeNull();
  });
});

function lookupOf(table: Record<string, readonly string[]>): HostLookup {
  return (host) => {
    const addresses = table[host];
    return addresses === undefined
      ? Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }))
      : Promise.resolve(addresses);
  };
}

async function problemOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SmtpHostError) return error.problem;
    throw error;
  }
  return 'ok';
}

describe('resolveAllowedSmtpHost', () => {
  const lookup = lookupOf({
    'mail.example.com': ['93.184.216.34'],
    'mixed.example.com': ['93.184.216.34', '10.0.0.5'],
    'lan.example.com': ['192.168.1.20'],
    'meta.example.com': ['169.254.169.254'],
    'empty.example.com': [],
  });

  it.each([
    ['mail.example.com', false, 'ok'],
    ['93.184.216.34', false, 'ok'],
    ['127.0.0.1', false, 'not_allowed'],
    ['10.0.0.5', false, 'not_allowed'],
    ['169.254.169.254', false, 'not_allowed'],
    ['lan.example.com', false, 'not_allowed'],
    // One internal address among several refuses the host.
    ['mixed.example.com', false, 'not_allowed'],
    ['meta.example.com', false, 'not_allowed'],
    ['nowhere.example.com', false, 'unresolvable'],
    ['empty.example.com', false, 'unresolvable'],
    ['http://x', false, 'invalid'],
    // SMTP_ALLOW_PRIVATE_HOSTS=true: LAN servers, never metadata.
    ['127.0.0.1', true, 'ok'],
    ['10.0.0.5', true, 'ok'],
    ['lan.example.com', true, 'ok'],
    ['mixed.example.com', true, 'ok'],
    ['169.254.169.254', true, 'not_allowed'],
    ['meta.example.com', true, 'not_allowed'],
  ] as const)('%s (allowPrivate=%s) → %s', async (host, allowPrivate, expected) => {
    expect(await problemOf(resolveAllowedSmtpHost(host, { allowPrivate, lookup }))).toBe(expected);
  });

  it('gives up on a resolver that does not answer', async () => {
    const hanging: HostLookup = () => new Promise(() => undefined);
    expect(
      await problemOf(
        resolveAllowedSmtpHost('mail.example.com', {
          allowPrivate: false,
          lookup: hanging,
          lookupTimeoutMs: 50,
        }),
      ),
    ).toBe('unresolvable');
  });

  it('never puts the resolved addresses in the error', async () => {
    try {
      await resolveAllowedSmtpHost('lan.example.com', { allowPrivate: false, lookup });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('192.168');
      expect(error).toMatchObject({ code: 'EHOSTBLOCKED' });
    }
  });
});

describe('guardedSmtpSocket (checked on every connection)', () => {
  let server: Server | undefined;
  let accepted = 0;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
    });
    server = undefined;
    accepted = 0;
  });

  async function listen(): Promise<number> {
    server = createServer((socket) => {
      accepted += 1;
      socket.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  function open(
    getSocket: ReturnType<typeof guardedSmtpSocket>,
  ): Promise<{ error: Error | null; socket: Socket | null }> {
    return new Promise((resolve) => {
      getSocket({}, (error, options) => {
        resolve({ error, socket: options?.connection ?? null });
      });
    });
  }

  it('connects to the address it just checked', async () => {
    const port = await listen();
    const { error, socket } = await open(
      guardedSmtpSocket('lan.example.com', port, {
        allowPrivate: true,
        lookup: lookupOf({ 'lan.example.com': ['127.0.0.1'] }),
        connectTimeoutMs: 2_000,
      }),
    );
    expect(error).toBeNull();
    expect(socket?.remoteAddress).toBe('127.0.0.1');
    socket?.destroy();
  });

  it('refuses a host whose DNS answer changed to an internal address (rebinding)', async () => {
    const port = await listen();
    let calls = 0;
    // Public when the identity was saved, loopback when connecting.
    const rebinding: HostLookup = () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? ['93.184.216.34'] : ['127.0.0.1']);
    };
    const options = { allowPrivate: false, lookup: rebinding, connectTimeoutMs: 2_000 };
    await expect(resolveAllowedSmtpHost('rebind.example.com', options)).resolves.toEqual([
      '93.184.216.34',
    ]);
    const { error, socket } = await open(guardedSmtpSocket('rebind.example.com', port, options));
    expect(socket).toBeNull();
    expect(error).toMatchObject({ code: 'EHOSTBLOCKED' });
    expect(accepted).toBe(0);
  });

  it('times out a connection that never completes', async () => {
    const started = Date.now();
    // TEST-NET-1 is not routed: the SYN goes nowhere (or fails fast offline).
    const { error } = await open(
      guardedSmtpSocket('192.0.2.1', 25, { allowPrivate: true, connectTimeoutMs: 200 }),
    );
    expect(error).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
