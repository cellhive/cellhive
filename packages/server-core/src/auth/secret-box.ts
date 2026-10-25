import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Secrets stored encrypted at rest (SPEC §20 `APP_MASTER_KEY`, ADR-27,
 * ADR-33 §1A): AES-256-GCM under a key derived from the master key with
 * HKDF-SHA256 and a purpose-specific `info`, so a key never serves two
 * purposes (idempotent responses, identity SMTP passwords, `meta.secrets`).
 * The format is `iv ‖ tag ‖ ciphertext`, base64url; every seal uses a new
 * random IV, so sealing the same text twice gives different ciphertexts.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Purposes of keys derived from `APP_MASTER_KEY` (the HKDF `info` is `<purpose>:v1`). */
export type SecretPurpose =
  | 'idempotency-response'
  | 'email-identity-smtp'
  | 'email-identity-code'
  | 'org-secret'
  /** Chat id of a personal notification channel (T549, `meta.user_channels.address_enc`). */
  | 'user-channel'
  /** Lookup HMAC of a channel's chat (T549, `meta.user_channels.address_hmac`). */
  | 'user-channel-lookup'
  /** URL token of an incoming webhook (T602, `meta.incoming_webhooks.token_enc`, ADR-35 §1). */
  | 'incoming-webhook'
  /** Signing secrets of an incoming webhook (T602, `signing_secret_enc`, `signing_secret_prev_enc`). */
  | 'incoming-webhook-signing'
  /** Rendered outbound HTTP request (T605, `meta.http_deliveries.request_enc`, ADR-35 §4). */
  | 'http-delivery'
  /** `secret_token` of a notification bot's webhook (T609, `meta.telegram_webhooks`, ADR-35 §7). */
  | 'telegram-webhook';

/** 32-byte key for `purpose` (HKDF-SHA256, empty salt). */
export function deriveSecretKey(masterKey: Buffer | string, purpose: SecretPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), `${purpose}:v1`, 32));
}

/** Encrypts `text` (UTF-8). */
export function sealSecret(key: Buffer, text: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/**
 * Decrypts what `sealSecret` produced with the same key; throws when it was
 * altered. Only the canonical base64url text `sealSecret` writes is
 * accepted: Node's decoder skips unknown characters and ignores the unused
 * low bits of the last character, so other spellings of the same bytes
 * would otherwise open too.
 */
export function unsealSecret(key: Buffer, sealed: string): string {
  const raw = Buffer.from(sealed, 'base64url');
  if (raw.toString('base64url') !== sealed) throw new Error('sealed secret is not canonical');
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('sealed secret is truncated');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}

/** Hex HMAC-SHA256 of `text` under `key` (a lookup key that reveals nothing without `key`). */
export function hmacHex(key: Buffer, text: string): string {
  return createHmac('sha256', key).update(text, 'utf8').digest('hex');
}
