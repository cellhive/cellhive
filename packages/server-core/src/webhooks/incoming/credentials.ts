import { INCOMING_WEBHOOK_TOKEN_PATTERN } from '@cellhive/contracts';

import { deriveSecretKey, sealSecret, unsealSecret } from '../../auth/secret-box.js';
import { generateToken, hashToken } from '../../auth/tokens.js';
import { generateSigningSecret } from '../standard-webhooks.js';

import type { Buffer } from 'node:buffer';

/**
 * Credentials of an incoming webhook at rest (ADR-35 §1, BACKLOG T602):
 *
 * - the **URL token** (32 random bytes, base64url): its hex SHA-256 is the
 *   lookup key (`token_hash`), and a copy sealed with AES-256-GCM under the
 *   HKDF key `incoming-webhook:v1` (`token_enc`) lets base admins read
 *   the URL again (BACKLOG "Quyết định S5c" #8);
 * - the **signing secret** (`whsec_…`, Standard Webhooks): sealed under its
 *   own HKDF key `incoming-webhook-signing:v1` (the public route needs
 *   the secret itself to verify an HMAC);
 * - the **Bearer token** (32 random bytes, base64url): only its hex
 *   SHA-256 is kept (`bearer_hash`).
 *
 * Plain values exist only in memory: in the response that issues them, or
 * while the public route verifies a request. Never log them.
 */
export class IncomingWebhookCredentials {
  readonly #tokenKey: Buffer;
  readonly #signingKey: Buffer;

  constructor(masterKey: Buffer | string) {
    this.#tokenKey = deriveSecretKey(masterKey, 'incoming-webhook');
    this.#signingKey = deriveSecretKey(masterKey, 'incoming-webhook-signing');
  }

  /** A new URL token with its lookup hash and sealed copy. */
  issueToken(): IssuedHookToken {
    const token = generateToken();
    return { token, tokenHash: hashHookSecret(token), tokenEnc: this.sealToken(token) };
  }

  sealToken(token: string): string {
    return sealSecret(this.#tokenKey, token);
  }

  /** Throws when `sealed` was altered or sealed under another master key. */
  unsealToken(sealed: string): string {
    return unsealSecret(this.#tokenKey, sealed);
  }

  /** A new `whsec_` signing secret (32 bytes) with its sealed copy. */
  issueSigningSecret(): IssuedSigningSecret {
    const secret = generateSigningSecret();
    return { secret, secretEnc: sealSecret(this.#signingKey, secret) };
  }

  /** Throws when `sealed` was altered or sealed under another master key. */
  unsealSigningSecret(sealed: string): string {
    return unsealSecret(this.#signingKey, sealed);
  }

  /** A new Bearer token with the hash that is stored. */
  issueBearer(): IssuedBearer {
    const token = generateToken();
    return { token, bearerHash: hashHookSecret(token) };
  }
}

export interface IssuedHookToken {
  readonly token: string;
  readonly tokenHash: string;
  readonly tokenEnc: string;
}

export interface IssuedSigningSecret {
  readonly secret: string;
  readonly secretEnc: string;
}

export interface IssuedBearer {
  readonly token: string;
  readonly bearerHash: string;
}

/** Hex SHA-256 of a URL token or Bearer token (what `token_hash`/`bearer_hash` hold). */
export function hashHookSecret(value: string): string {
  return hashToken(value);
}

/** Whether `token` has the shape of a hook URL token (else the public route answers `404`). */
export function isWellFormedHookToken(token: string): boolean {
  return INCOMING_WEBHOOK_TOKEN_PATTERN.test(token);
}

/** The public URL of a hook: `PUBLIC_URL/api/v1/hooks/<token>`. */
export function incomingWebhookUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/u, '')}/api/v1/hooks/${token}`;
}
