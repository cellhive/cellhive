import { deriveSecretKey, hmacHex, sealSecret, unsealSecret } from '../../../auth/secret-box.js';

import type { Id } from '@cellhive/contracts';
import type { Buffer } from 'node:buffer';

/**
 * The chat id of a personal Telegram channel at rest (ADR-34 §3, T549):
 * sealed with AES-256-GCM under the HKDF key `user-channel:v1`
 * (`address_enc`, a new IV each time), plus an HMAC-SHA256 under another
 * derived key `user-channel-lookup:v1` (`address_hmac`) so that a
 * `/stop` from a chat finds its channels. Neither value reveals the chat id
 * without `APP_MASTER_KEY`; the chat id itself is only ever in memory.
 */
export class TelegramChatAddress {
  readonly #sealKey: Buffer;
  readonly #lookupKey: Buffer;

  constructor(masterKey: Buffer | string) {
    this.#sealKey = deriveSecretKey(masterKey, 'user-channel');
    this.#lookupKey = deriveSecretKey(masterKey, 'user-channel-lookup');
  }

  seal(chatId: string): string {
    return sealSecret(this.#sealKey, chatId);
  }

  /** Throws when `sealed` was altered or sealed under another master key. */
  unseal(sealed: string): string {
    return unsealSecret(this.#sealKey, sealed);
  }

  /** Lookup key of a chat of one bot (the same chat of two bots differs). */
  lookup(secretId: Id<'sec'>, chatId: string): string {
    return hmacHex(this.#lookupKey, `${secretId}:${chatId}`);
  }
}
