import { once } from 'node:events';

import { SMTPServer } from 'smtp-server';

import type { AddressInfo } from 'node:net';

export interface ReceivedMail {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
  /** Authenticated user, if any. */
  readonly user: string | null;
}

export interface SmtpReplyRule {
  readonly code: number;
  readonly message: string;
}

export interface TestSmtpOptions {
  /** Require AUTH with these credentials. */
  readonly auth?: { readonly user: string; readonly pass: string };
  /** Reply to `RCPT TO` for this address (default 250). */
  readonly rcpt?: (address: string) => SmtpReplyRule | null;
  /** Reply after `DATA` (default 250). */
  readonly data?: () => SmtpReplyRule | null;
}

export interface TestSmtpServer {
  readonly port: number;
  readonly url: string;
  readonly messages: ReceivedMail[];
  /** Number of TCP connections accepted. */
  connections: number;
  close(): Promise<void>;
}

function smtpError(rule: SmtpReplyRule): Error {
  return Object.assign(new Error(rule.message), { responseCode: rule.code });
}

/** An in-process SMTP server without TLS (clients run with `none` security). */
export async function startTestSmtp(options: TestSmtpOptions = {}): Promise<TestSmtpServer> {
  const messages: ReceivedMail[] = [];
  const state = { connections: 0 };
  const server = new SMTPServer({
    logger: false,
    disabledCommands: options.auth === undefined ? ['STARTTLS', 'AUTH'] : ['STARTTLS'],
    authOptional: options.auth === undefined,
    allowInsecureAuth: true,
    closeTimeout: 100,
    onConnect(_session, callback) {
      state.connections += 1;
      callback();
    },
    onAuth(auth, _session, callback) {
      if (auth.username === options.auth?.user && auth.password === options.auth?.pass) {
        callback(null, { user: auth.username });
        return;
      }
      callback(Object.assign(new Error('Invalid credentials'), { responseCode: 535 }));
    },
    onRcptTo(address, _session, callback) {
      const rule = options.rcpt?.(address.address) ?? null;
      callback(rule === null ? undefined : smtpError(rule));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const rule = options.data?.() ?? null;
        if (rule !== null) {
          callback(smtpError(rule));
          return;
        }
        messages.push({
          from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          raw: Buffer.concat(chunks).toString('utf8'),
          user: typeof session.user === 'string' ? session.user : null,
        });
        callback();
      });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server.server, 'listening');
  const { port } = server.server.address() as AddressInfo;
  return {
    port,
    url: `smtp://127.0.0.1:${String(port)}`,
    messages,
    get connections() {
      return state.connections;
    },
    set connections(value: number) {
      state.connections = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Header value of a raw message (first occurrence, unfolded). */
export function headerOf(raw: string, name: string): string | null {
  const head = raw.split(/\r?\n\r?\n/)[0] ?? '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0 && line.slice(0, colon).toLowerCase() === name.toLowerCase()) {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}
