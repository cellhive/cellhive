import { describe, expect, it } from 'vitest';

import { randomString } from '../src/random.js';

describe('randomString', () => {
  it.each([
    { alphabet: '01', length: 64 },
    { alphabet: 'abc', length: 1 },
    { alphabet: '0123456789abcdefghijklmnopqrstuvwxyz', length: 12 },
    { alphabet: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', length: 16 },
  ])(
    'returns $length characters from a $alphabet.length-letter alphabet',
    ({ alphabet, length }) => {
      const value = randomString(alphabet, length);
      expect(value).toHaveLength(length);
      for (const char of value) expect(alphabet).toContain(char);
    },
  );

  it.each(['', 'a'])('rejects alphabet %j', (alphabet) => {
    expect(() => randomString(alphabet, 4)).toThrow(RangeError);
  });

  it('is roughly uniform (no modulo bias) over base62', () => {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const counts = new Map<string, number>();
    const sample = randomString(alphabet, 62_000);
    for (const char of sample) counts.set(char, (counts.get(char) ?? 0) + 1);
    // Expected 1000 each; a biased `byte % 62` would push the first 8 symbols to ~1190.
    for (const char of alphabet) {
      const count = counts.get(char) ?? 0;
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
  });
});
