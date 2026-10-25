/**
 * Unbiased random strings from a CSPRNG.
 *
 * Uses the Web Crypto `crypto.getRandomValues`, available as a global in
 * Node.js 24 and every supported browser, so this module needs no Node
 * built-ins and no third-party dependency.
 */

const MAX_RANDOM_BYTES = 65_536;

interface RandomSource {
  getRandomValues<T extends Uint8Array>(array: T): T;
}

function randomSource(): RandomSource {
  const source = (globalThis as { crypto?: RandomSource }).crypto;
  if (source === undefined) {
    // Plain Error is intentional: this is an environment fault, not an API error.
    throw new Error('Web Crypto API (globalThis.crypto.getRandomValues) is not available');
  }
  return source;
}

/**
 * Returns `length` characters drawn uniformly from `alphabet`.
 *
 * Rejection sampling: a byte is accepted only if it is below the largest
 * multiple of the alphabet size that fits in 256, so `byte % size` carries no
 * modulo bias.
 */
export function randomString(alphabet: string, length: number): string {
  const size = alphabet.length;
  if (size < 2 || size > 256) {
    throw new RangeError('Alphabet size must be between 2 and 256');
  }
  const limit = 256 - (256 % size);
  const source = randomSource();
  let out = '';
  // Request a little more than needed so one round is almost always enough,
  // capped at the 65,536-byte limit of a single getRandomValues call.
  const batch = new Uint8Array(Math.min(Math.ceil(length * 1.25) + 4, MAX_RANDOM_BYTES));
  while (out.length < length) {
    source.getRandomValues(batch);
    for (const byte of batch) {
      if (byte < limit) {
        out += alphabet.charAt(byte % size);
        if (out.length === length) break;
      }
    }
  }
  return out;
}
