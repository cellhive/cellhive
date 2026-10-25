import { isIP } from 'node:net';

import { createTransport, type SMTPTransportOptions, type Transporter } from 'nodemailer';

import type { SmtpGetSocket } from './identities/host-guard.js';
import type { MailConfig } from '../config/load-config.js';
import type { SmtpSecurity } from '@cellhive/contracts';

/**
 * SMTP transports (BACKLOG T513): the instance SMTP (`SMTP_URL`) and,
 * from T530, the SMTP of a sender identity (e.g. `hr@` logging into the
 * company mail server with its own account) chosen at send time. Both go
 * through the same `Mailer.send`: same validation, headers, limits and
 * error classification.
 */

/** Where and how to connect; never carries the password. */
export interface SmtpEndpoint {
  readonly host: string;
  readonly port: number;
  /**
   * `tls`: TLS from the first byte (465); `starttls`: STARTTLS required;
   * `none`: STARTTLS when offered, plain otherwise (instance: only with
   * `SMTP_ALLOW_INSECURE=true`; identities: as T530 allows).
   */
  readonly security: SmtpSecurity;
  readonly username: string | null;
}

export interface SmtpCredentials {
  readonly user: string;
  readonly pass: string;
}

/** Which SMTP a message goes through. */
export type MailTransportRef =
  | { readonly kind: 'instance' }
  | {
      readonly kind: 'identity';
      /** `eid_…` (T530); also the per-identity quota key. */
      readonly identityId: string;
      /**
       * Changes whenever the endpoint or the credentials change: the cached
       * transport of an older version is closed and a new one is built.
       */
      readonly version: string | number;
      readonly endpoint: SmtpEndpoint;
      /**
       * Credentials (password decrypted from `meta.secrets` by T530); called
       * only when a transport is built, the result is not kept elsewhere.
       */
      readonly credentials: () => Promise<SmtpCredentials | null>;
      /** The identity's address: the only `From` this transport sends. */
      readonly fromAddress: string;
    };

export const INSTANCE_TRANSPORT: MailTransportRef = { kind: 'instance' };

/** Connection timeouts: a slow server must not hold requests or jobs for long. */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
} as const;

/** Endpoint and credentials of `SMTP_URL` (validated by the config: no path, no query). */
export function instanceEndpoint(mail: MailConfig): {
  endpoint: SmtpEndpoint;
  credentials: SmtpCredentials | null;
} {
  const url = new URL(mail.url);
  const implicitTls = url.protocol === 'smtps:';
  const security: SmtpSecurity = implicitTls ? 'tls' : mail.allowInsecure ? 'none' : 'starttls';
  const user = decodeURIComponent(url.username);
  return {
    endpoint: {
      host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: url.port === '' ? (implicitTls ? 465 : 587) : Number(url.port),
      security,
      username: user === '' ? null : user,
    },
    credentials: user === '' ? null : { user, pass: decodeURIComponent(url.password) },
  };
}

/** `smtp.mail.example.com` → `***.example.com`; IP addresses → `***`. */
export function maskHost(host: string): string {
  if (isIP(host) !== 0) return '***';
  const labels = host.toLowerCase().split('.');
  if (labels.length <= 2) return `${(labels[0] ?? '').slice(0, 1)}***.${labels.slice(1).join('.')}`;
  return `***.${labels.slice(-2).join('.')}`;
}

export interface TransportBuildOptions {
  /** Keep connections open between messages (identity transports). */
  readonly pool: boolean;
  /**
   * Opens the TCP connection instead of nodemailer (identity transports:
   * the SSRF guard resolves and checks the host on every connection, T530).
   */
  readonly getSocket?: SmtpGetSocket;
  /** Overrides of `SMTP_TIMEOUTS` (tests). */
  readonly timeouts?: Partial<typeof SMTP_TIMEOUTS>;
}

/** nodemailer options for an endpoint: TLS ≥ 1.2, timeouts, no logging of message contents. */
export function transportOptions(
  endpoint: SmtpEndpoint,
  credentials: SmtpCredentials | null,
  options: TransportBuildOptions,
): SMTPTransportOptions {
  const pool = options.pool
    ? { pool: true, maxConnections: 1, maxMessages: 50 }
    : // Instance: one connection per message, as before T513.
      {};
  return {
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.security === 'tls',
    requireTLS: endpoint.security === 'starttls',
    ...(credentials === null ? {} : { auth: { user: credentials.user, pass: credentials.pass } }),
    tls: {
      minVersion: 'TLSv1.2',
      ...(isIP(endpoint.host) === 0 ? { servername: endpoint.host } : {}),
    },
    ...SMTP_TIMEOUTS,
    ...options.timeouts,
    ...(options.getSocket === undefined ? {} : { getSocket: options.getSocket }),
    ...pool,
    // Never let nodemailer write message contents or credentials to a logger.
    logger: false,
    debug: false,
  };
}

/** Builds a nodemailer transport; replaced in tests. */
export type TransportFactory = (
  endpoint: SmtpEndpoint,
  credentials: SmtpCredentials | null,
  options: TransportBuildOptions,
) => Transporter;

export const defaultTransportFactory: TransportFactory = (endpoint, credentials, options) =>
  createTransport(transportOptions(endpoint, credentials, options));

/**
 * Identity transports by `identityId` + `version`, bounded (least recently
 * used closed first); a new version closes the older transport of the
 * same identity.
 */
export class IdentityTransportCache {
  private readonly entries = new Map<
    string,
    { readonly version: string; readonly transport: Promise<Transporter> }
  >();

  constructor(
    private readonly factory: TransportFactory,
    private readonly maxEntries: number,
    /** Extra build options of an endpoint (SSRF-guarded socket, timeouts). */
    private readonly buildOptions: (
      endpoint: SmtpEndpoint,
    ) => Omit<TransportBuildOptions, 'pool'> = () => ({}),
  ) {}

  get size(): number {
    return this.entries.size;
  }

  async get(ref: Extract<MailTransportRef, { kind: 'identity' }>): Promise<Transporter> {
    const version = String(ref.version);
    const current = this.entries.get(ref.identityId);
    if (current !== undefined && current.version === version) {
      // Most recently used last.
      this.entries.delete(ref.identityId);
      this.entries.set(ref.identityId, current);
      return current.transport;
    }
    if (current !== undefined) this.drop(ref.identityId);
    const transport = ref
      .credentials()
      .then((credentials) =>
        this.factory(ref.endpoint, credentials, { ...this.buildOptions(ref.endpoint), pool: true }),
      );
    this.entries.set(ref.identityId, { version, transport });
    transport.catch(() => {
      if (this.entries.get(ref.identityId)?.transport === transport) {
        this.entries.delete(ref.identityId);
      }
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    return transport;
  }

  /** Closes the transport of an identity (disabled, deleted or changed). */
  drop(identityId: string): void {
    const entry = this.entries.get(identityId);
    if (entry === undefined) return;
    this.entries.delete(identityId);
    entry.transport.then(
      (transport) => {
        transport.close();
      },
      () => undefined,
    );
  }

  closeAll(): void {
    for (const identityId of [...this.entries.keys()]) this.drop(identityId);
  }
}
