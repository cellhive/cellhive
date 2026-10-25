import { createHash } from 'node:crypto';

import { BASE62_ALPHABET } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  apiTokenChecksum,
  generateApiToken,
  hashApiToken,
  parseApiToken,
} from '../../src/api-tokens/format.js';

/** A well-formed token whose 30 random characters are `random`. */
function tokenOf(random: string): string {
  return `cht_${random}${apiTokenChecksum(random)}`;
}

const RANDOM = 'AbCdEfGh0123456789ijklmnopqrST';

/**
 * API token format (BACKLOG T703, ADR-36 §1, CONTRACTS §26.1): `cht_` +
 * 30 base62 characters + 6 base62 characters of the CRC32 of those 30.
 */
describe('API token format (T703)', () => {
  it('encodes the CRC32 of the random part as 6 base62 characters, zero-padded', () => {
    // CRC32("123456789") = 0xCBF43926 = 3421780262, the standard check value.
    expect(apiTokenChecksum('123456789')).toBe('3jZRME');
    // CRC32("") = 0: all padding.
    expect(apiTokenChecksum('')).toBe('000000');
  });

  it('generates cht_ + 30 base62 + a valid checksum, its 8-character prefix and SHA-256', () => {
    const { token, prefix, hash } = generateApiToken();
    expect(token).toMatch(/^cht_[0-9A-Za-z]{36}$/u);
    expect(token).toHaveLength(40);
    expect(prefix).toBe(token.slice(4, 12));
    expect(token.slice(-6)).toBe(apiTokenChecksum(token.slice(4, 34)));
    expect(hash).toEqual(createHash('sha256').update(token, 'utf8').digest());
    expect(hash).toHaveLength(32);
    expect(hashApiToken(token)).toEqual(hash);
  });

  it.each([
    ['a token with a valid checksum', tokenOf(RANDOM), 'ok'],
    ['the empty string', '', 'malformed'],
    ['another prefix', `ghp_${RANDOM}${apiTokenChecksum(RANDOM)}`, 'malformed'],
    ['an upper-case prefix', `OBT_${RANDOM}${apiTokenChecksum(RANDOM)}`, 'malformed'],
    ['one character short', tokenOf(RANDOM).slice(0, -1), 'malformed'],
    ['one character too many', `${tokenOf(RANDOM)}0`, 'malformed'],
    ['a non-base62 character', tokenOf(RANDOM).replace('A', '-'), 'malformed'],
    ['surrounding whitespace', ` ${tokenOf(RANDOM)}`, 'malformed'],
    ['a trailing newline', `${tokenOf(RANDOM)}\n`, 'malformed'],
    ['the Bearer scheme left in', `Bearer ${tokenOf(RANDOM)}`, 'malformed'],
    ['a non-ASCII letter', tokenOf(RANDOM).replace('A', 'Á'), 'malformed'],
    ['a wrong checksum', `cht_${RANDOM}000000`, 'bad_checksum'],
    ['a swapped random character', tokenOf(RANDOM).replace('AbCd', 'bACd'), 'bad_checksum'],
    ['an edited checksum', `${tokenOf(RANDOM).slice(0, -1)}z`, 'bad_checksum'],
  ] as const)('parses %s as %s', (_name, input, expected) => {
    expect(parseApiToken(input)).toBe(expected);
  });

  it('accepts 1,000 generated tokens and gives each a distinct value and hash', () => {
    const tokens = new Set<string>();
    const hashes = new Set<string>();
    for (let index = 0; index < 1_000; index += 1) {
      const { token, hash } = generateApiToken();
      expect(parseApiToken(token)).toBe('ok');
      tokens.add(token);
      hashes.add(hash.toString('hex'));
    }
    expect(tokens.size).toBe(1_000);
    expect(hashes.size).toBe(1_000);
  });

  it('flags a single changed character as bad_checksum (at least 99.9 % of 1,000 edits)', () => {
    let caught = 0;
    const edits = 1_000;
    for (let index = 0; index < edits; index += 1) {
      const { token } = generateApiToken();
      // Any position after `cht_`, replaced by another base62 character.
      const position = 4 + (index % 36);
      const current = token.charAt(position);
      const offset = 1 + (index % (BASE62_ALPHABET.length - 1));
      const replacement =
        BASE62_ALPHABET[(BASE62_ALPHABET.indexOf(current) + offset) % BASE62_ALPHABET.length];
      const edited = `${token.slice(0, position)}${replacement ?? ''}${token.slice(position + 1)}`;
      expect(edited).not.toBe(token);
      if (parseApiToken(edited) === 'bad_checksum') caught += 1;
    }
    expect(caught / edits).toBeGreaterThanOrEqual(0.999);
  });
});
