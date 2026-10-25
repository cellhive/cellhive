import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { type AddressInfo } from 'node:net';

import { CSRF_COOKIE, CSRF_HEADER, newId, SESSION_COOKIE, type Id } from '@cellhive/contracts';
import {
  OrganizationsRepository,
  OrgMembersRepository,
  orgScope,
  UsersRepository,
  type Db,
  type OrgRole,
} from '@cellhive/server-core';
import { SMTPServer } from 'smtp-server';

import { PasswordHasher } from '../../src/common/auth/password/password-hasher.js';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { InjectOptions, LightMyRequestResponse as InjectResponse } from 'fastify';

/** Cheap argon2id parameters: the hash format is the same, tests stay fast. */
export const testHasher = new PasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });

export const PASSWORD = 'Correct-Horse-Battery-9';

export interface SetCookie {
  readonly value: string;
  readonly attributes: readonly string[];
  readonly raw: string;
}

/** `Set-Cookie` headers of a response by cookie name (the last one wins). */
export function setCookiesOf(response: InjectResponse): Map<string, SetCookie> {
  const header = response.headers['set-cookie'];
  const list = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const cookies = new Map<string, SetCookie>();
  for (const raw of list) {
    const [pair = '', ...attributes] = raw.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    cookies.set(pair.slice(0, index), {
      value: pair.slice(index + 1),
      attributes,
      raw,
    });
  }
  return cookies;
}

/** A client IP of the TEST-NET-2 range, distinct per call (rate limits are per IP). */
export function uniqueIp(): string {
  const bytes = randomBytes(2);
  return `198.51.${String(bytes[0] ?? 0)}.${String(bytes[1] ?? 0)}`;
}

/** A browser with a cookie jar that sends `X-CSRF-Token` like the SPA does. */
export class Browser {
  readonly cookies = new Map<string, string>();

  constructor(
    private readonly app: NestFastifyApplication,
    readonly ip: string = uniqueIp(),
  ) {}

  get sessionToken(): string | undefined {
    return this.cookies.get(SESSION_COOKIE);
  }

  get csrfToken(): string | undefined {
    return this.cookies.get(CSRF_COOKIE);
  }

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(options: InjectOptions & { readonly csrf?: boolean }): Promise<InjectResponse> {
    const { csrf = true, headers = {}, ...rest } = options;
    const method = (rest.method ?? 'GET').toUpperCase();
    const response = await this.app.inject({
      remoteAddress: this.ip,
      ...rest,
      headers: {
        ...(this.cookies.size > 0 ? { cookie: this.cookieHeader() } : {}),
        ...(csrf && method !== 'GET' && this.csrfToken !== undefined
          ? { [CSRF_HEADER]: this.csrfToken }
          : {}),
        ...headers,
      },
    });
    for (const [name, cookie] of setCookiesOf(response)) {
      if (cookie.attributes.includes('Max-Age=0')) this.cookies.delete(name);
      else this.cookies.set(name, cookie.value);
    }
    return response;
  }

  login(email: string, password: string = PASSWORD): Promise<InjectResponse> {
    return this.request({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
  }
}

/** Seeds an organization directly (T008 owns the org API). */
export async function seedOrg(db: Db, name: string): Promise<Id<'org'>> {
  const organizations = new OrganizationsRepository(db);
  const org = await organizations.create({
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomBytes(3).toString('hex')}`,
    settings: { locale: 'vi', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
  });
  return org.id;
}

export interface SeedUserOptions {
  readonly email?: string;
  /** `null` = no password (external sign-in). Defaults to `PASSWORD`. */
  readonly password?: string | null;
  readonly memberships?: readonly { readonly orgId: Id<'org'>; readonly role: OrgRole }[];
  readonly displayName?: string;
}

export interface SeededUser {
  readonly id: Id<'usr'>;
  readonly email: string;
}

export async function seedUser(db: Db, options: SeedUserOptions = {}): Promise<SeededUser> {
  const users = new UsersRepository(db);
  const orgMembers = new OrgMembersRepository(db);
  const email = options.email ?? `u-${randomBytes(4).toString('hex')}@example.test`;
  const password = options.password === undefined ? PASSWORD : options.password;
  const user = await users.create({
    id: newId('usr'),
    email,
    displayName: options.displayName ?? email.split('@')[0] ?? email,
    passwordHash: password === null ? null : await testHasher.hash(password),
  });
  for (const membership of options.memberships ?? []) {
    await orgMembers.add(orgScope(membership.orgId), user.id, membership.role);
  }
  return { id: user.id, email };
}

export interface CapturedMail {
  readonly to: readonly string[];
  readonly raw: string;
}

export interface SmtpCapture {
  readonly url: string;
  readonly messages: CapturedMail[];
  close(): Promise<void>;
}

/** Decodes quoted-printable soft line breaks and `=XX` escapes. */
export function decodeQuotedPrintable(value: string): string {
  return value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** A local SMTP server that keeps every message it receives. */
export async function startSmtpCapture(): Promise<SmtpCapture> {
  const messages: CapturedMail[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        messages.push({
          to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server.server, 'listening');
  const { port } = server.server.address() as AddressInfo;
  return {
    url: `smtp://127.0.0.1:${String(port)}`,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Polls until `predicate` holds (mail is sent after the response). */
export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
