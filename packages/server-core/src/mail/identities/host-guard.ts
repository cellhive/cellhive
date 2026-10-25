import { connect, isIP, type Socket } from 'node:net';

import { asciiDomain } from '../../config/env-schema.js';
import { classifyAddress } from '../../net/address-class.js';
import { systemHostLookup, type HostLookup } from '../../net/lookup.js';

// Moved to `net/` (T600, shared with outbound HTTP); re-exported for the SMTP callers.
export { classifyAddress, type AddressClass } from '../../net/address-class.js';
export { systemHostLookup, type HostLookup } from '../../net/lookup.js';

/**
 * SSRF guard for the SMTP servers of sender identities (ADR-33 §1A, SPEC
 * §14.3): the host is resolved and every address checked when the identity
 * is saved **and** each time a connection is opened — the socket goes to
 * the address that was just checked, so a DNS answer that changes between
 * the check and the connection (DNS rebinding) cannot reach an internal
 * address.
 *
 * Addresses are classified by `classifyAddress` (`net/address-class.ts`,
 * shared with outbound HTTP since T600):
 * - `blocked` (always refused): unspecified, multicast, broadcast, reserved
 *   and cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`…);
 * - `private` (refused unless `SMTP_ALLOW_PRIVATE_HOSTS=true`, for a mail
 *   server on the LAN): loopback, RFC 1918, link-local, CGNAT, IPv6 ULA and
 *   link-local, benchmarking and documentation ranges;
 * - `public`: everything else.
 */

export interface HostGuardOptions {
  /** `SMTP_ALLOW_PRIVATE_HOSTS`. */
  readonly allowPrivate: boolean;
  /** DNS resolution; the system resolver by default (tests replace it). */
  readonly lookup?: HostLookup;
  /** Give up resolving after this long (default 10 s). */
  readonly lookupTimeoutMs?: number;
}

export type SmtpHostProblem = 'invalid' | 'unresolvable' | 'not_allowed';

/**
 * A host that may not be used. `code` follows nodemailer's error codes so the
 * SMTP failure classification maps it (`EHOSTBLOCKED` → `host_not_allowed`,
 * `EDNS` → `connection_failed`). Never carries the resolved addresses.
 */
export class SmtpHostError extends Error {
  readonly problem: SmtpHostProblem;
  readonly code: 'EHOSTBLOCKED' | 'EDNS';

  constructor(problem: SmtpHostProblem) {
    super(
      problem === 'not_allowed'
        ? 'The SMTP host resolves to an address that is not allowed.'
        : problem === 'unresolvable'
          ? 'The SMTP host could not be resolved.'
          : 'The SMTP host is not a valid host name or IP address.',
    );
    this.name = 'SmtpHostError';
    this.problem = problem;
    this.code = problem === 'unresolvable' ? 'EDNS' : 'EHOSTBLOCKED';
  }
}

/**
 * `Mail.Example.COM` → `mail.example.com`, IDN → punycode, `[::1]` → `::1`;
 * `null` when it is not a host name or IP address (scheme, port, path,
 * user info and spaces are rejected).
 */
export function normalizeSmtpHost(input: string): string | null {
  const value = input.trim().replace(/^\[(.*)\]$/, '$1');
  if (value === '' || value.length > 253) return null;
  if (isIP(value) !== 0) return value.toLowerCase();
  if (/[\s/:@?#\\[\]]/.test(value)) return null;
  const name = value.replace(/\.$/, '').toLowerCase();
  // A single label (`mail`) is a LAN name resolved through the search domains.
  if (/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(name) && !/^\d+$/.test(name)) return name;
  const domain = asciiDomain(name);
  // URL host parsing turns `1234` or `0x7f.1` into IPv4 addresses: not host names.
  if (domain === null || isIP(domain) !== 0) return null;
  return domain.toLowerCase();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SmtpHostError('unresolvable'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * The addresses `host` may be reached at: every resolved address must be
 * allowed (one forbidden address refuses the host). Throws `SmtpHostError`.
 */
export async function resolveAllowedSmtpHost(
  host: string,
  options: HostGuardOptions,
): Promise<string[]> {
  const normalized = normalizeSmtpHost(host);
  if (normalized === null) throw new SmtpHostError('invalid');
  let addresses: readonly string[];
  if (isIP(normalized) !== 0) {
    addresses = [normalized];
  } else {
    try {
      addresses = await withTimeout(
        (options.lookup ?? systemHostLookup)(normalized),
        options.lookupTimeoutMs ?? 10_000,
      );
    } catch {
      throw new SmtpHostError('unresolvable');
    }
  }
  if (addresses.length === 0) throw new SmtpHostError('unresolvable');
  for (const address of addresses) {
    const kind = classifyAddress(address);
    if (kind === 'blocked' || (kind === 'private' && !options.allowPrivate)) {
      throw new SmtpHostError('not_allowed');
    }
  }
  return [...addresses];
}

function connectOnce(address: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      // Until nodemailer attaches its handlers: an unhandled 'error' would crash the process.
      socket.on('error', () => undefined);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

/** nodemailer's `getSocket` option: `{ connection }` = an already connected socket. */
export type SmtpGetSocket = (
  options: unknown,
  callback: (error: Error | null, socketOptions?: { connection: Socket }) => void,
) => void;

/**
 * `getSocket` for an identity transport: resolves and checks `host` again,
 * then opens the TCP connection to a checked address (trying them in turn).
 * nodemailer keeps the host name for TLS (SNI and certificate check).
 */
export function guardedSmtpSocket(
  host: string,
  port: number,
  options: HostGuardOptions & { readonly connectTimeoutMs: number },
): SmtpGetSocket {
  return (_options, callback) => {
    void (async () => {
      const addresses = await resolveAllowedSmtpHost(host, options);
      let lastError: unknown = null;
      for (const address of addresses) {
        try {
          return await connectOnce(address, port, options.connectTimeoutMs);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Connection failed');
    })().then(
      (socket) => {
        callback(null, { connection: socket });
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error('Connection failed'));
      },
    );
  };
}
