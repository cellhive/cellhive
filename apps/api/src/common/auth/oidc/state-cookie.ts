import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
  OIDC_STATE_TTL_SECONDS,
} from '@cellhive/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { APP_CONFIG } from '../../tokens.js';
import { parseCookies } from '../cookies.js';
import { deriveKey } from '../secrets.js';
import { SessionService } from '../session.service.js';

import type { Id } from '@cellhive/contracts';
import type { AppConfig } from '@cellhive/server-core';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Random values of one sign-in attempt: 32 bytes each, base64url (RFC 9700 §2.1). */
const RANDOM_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Binds the ciphertext to its purpose and format version. */
const AAD = Buffer.from('ob_oidc:v1', 'utf8');
/** Upper bound of a cookie value (`next` ≤ 2 048 characters plus the rest). */
const MAX_COOKIE_LENGTH = 4096;

/**
 * `link` mode (CONTRACTS §27.3, T708): the attempt was started by a
 * signed-in user to connect an identity; the callback only accepts it with
 * the same user and the same session.
 */
export interface OidcLinkBinding {
  readonly userId: Id<'usr'>;
  readonly sessionId: Id<'ses'>;
}

/** What the state cookie of one sign-in attempt holds (never logged). */
export interface OidcState {
  readonly provider: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  /** Internal path to open after signing in. */
  readonly next: string;
  /** Epoch milliseconds after which the cookie is refused. */
  readonly expiresAt: number;
  /** Present when the attempt links an identity instead of signing in. */
  readonly link?: OidcLinkBinding;
}

const sealedStateSchema = z.strictObject({
  p: z.string().min(1).max(32),
  s: z.string().min(43).max(128),
  n: z.string().min(43).max(128),
  v: z.string().min(43).max(128),
  x: z.string().min(1).max(2048),
  e: z.number().int().positive(),
  // `link` mode: user and session that started the attempt (both or neither).
  u: z.string().min(1).max(64).optional(),
  i: z.string().min(1).max(64).optional(),
});

function randomValue(): string {
  return randomBytes(RANDOM_BYTES).toString('base64url');
}

/**
 * The `ob_oidc` cookie (CONTRACTS §27.2, ADR-36 §3): `state`, `nonce`, PKCE
 * `code_verifier` and `next` of one sign-in attempt, sealed with AES-256-GCM
 * under a key derived from `SESSION_SECRET` (HKDF, `info =
 * oidc-state:v1`). Nothing is stored server-side; the cookie is
 * `HttpOnly; SameSite=Lax; Path=/api/v1/auth/oidc/`, lives 10 minutes and is
 * cleared by the callback before anything else (one use).
 */
@Injectable()
export class OidcStateCookie {
  /** Clock (epoch milliseconds); tests move it to expire the cookie. */
  now: () => number = () => Date.now();
  private readonly key: Buffer;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {
    this.key = deriveKey(config.security.sessionSecret, 'oidc-state');
  }

  /**
   * Fresh random values for `provider`, and the sealed cookie value holding
   * them; with `link`, the attempt links an identity to that user + session.
   */
  create(
    provider: string,
    next: string,
    link?: OidcLinkBinding,
  ): { readonly state: OidcState; readonly value: string } {
    const state: OidcState = {
      provider,
      state: randomValue(),
      nonce: randomValue(),
      codeVerifier: randomValue(),
      next,
      expiresAt: this.now() + OIDC_STATE_TTL_SECONDS * 1000,
      ...(link === undefined ? {} : { link }),
    };
    return { state, value: this.seal(state) };
  }

  /** The state of a cookie value; `undefined` when forged, corrupted or expired. */
  open(value: string | undefined): OidcState | undefined {
    if (value === undefined || value.length > MAX_COOKIE_LENGTH) return undefined;
    const raw = Buffer.from(value, 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
    let plain: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES));
      decipher.setAAD(AAD);
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      plain = Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return undefined;
    }
    let json: unknown;
    try {
      json = JSON.parse(plain);
    } catch {
      return undefined;
    }
    const parsed = sealedStateSchema.safeParse(json);
    if (!parsed.success || parsed.data.e <= this.now()) return undefined;
    const { p, s, n, v, x, e, u, i } = parsed.data;
    if ((u === undefined) !== (i === undefined)) return undefined;
    return {
      provider: p,
      state: s,
      nonce: n,
      codeVerifier: v,
      next: x,
      expiresAt: e,
      ...(u === undefined || i === undefined
        ? {}
        : { link: { userId: u as Id<'usr'>, sessionId: i as Id<'ses'> } }),
    };
  }

  /** The cookie value sent with the request, if any. */
  read(request: FastifyRequest): string | undefined {
    return parseCookies(request.headers.cookie).get(OIDC_STATE_COOKIE);
  }

  set(reply: FastifyReply, request: FastifyRequest, value: string): void {
    void reply.header('set-cookie', this.serialize(request, value, OIDC_STATE_TTL_SECONDS));
  }

  clear(reply: FastifyReply, request: FastifyRequest): void {
    void reply.header('set-cookie', this.serialize(request, '', 0));
  }

  private seal(state: OidcState): string {
    const payload = JSON.stringify({
      p: state.provider,
      s: state.state,
      n: state.nonce,
      v: state.codeVerifier,
      x: state.next,
      e: state.expiresAt,
      ...(state.link === undefined ? {} : { u: state.link.userId, i: state.link.sessionId }),
    });
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(AAD);
    const body = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
  }

  /** `Set-Cookie` limited to the OIDC routes (`serializeCookie` always uses `Path=/`). */
  private serialize(request: FastifyRequest, value: string, maxAgeSeconds: number): string {
    const parts = [
      `${OIDC_STATE_COOKIE}=${value}`,
      `Path=${OIDC_STATE_COOKIE_PATH}`,
      `Max-Age=${String(maxAgeSeconds)}`,
      'SameSite=Lax',
      'HttpOnly',
    ];
    if (maxAgeSeconds === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    if (this.sessions.secureCookies(request)) parts.push('Secure');
    return parts.join('; ');
  }
}
