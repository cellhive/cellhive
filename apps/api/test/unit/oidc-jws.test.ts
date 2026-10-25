import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { jwsHeaderOf, verifyJws, type Jwk } from '../../src/common/auth/oidc/jws.js';
import { OidcFailure, readCappedText } from '../../src/common/auth/oidc/oidc-client.js';

function rs256(modulusLength: number): { jws: string; jwk: Jwk } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey);
  return {
    jws: `${header}.${payload}.${signature.toString('base64url')}`,
    jwk: { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k1' },
  };
}

describe('verifyJws: RSA key size (T707)', () => {
  it.each([
    [1024, false],
    [1536, false],
    [2048, true],
    [3072, true],
  ])('RS256 with a %i-bit modulus → %s', (bits, expected) => {
    const { jws, jwk } = rs256(bits);
    const header = jwsHeaderOf(jws);
    if (header === undefined) throw new Error('malformed test JWS');
    expect(verifyJws(jws, header, jwk)).toBe(expected);
  });
});

function streamOf(chunks: readonly Uint8Array[], onCancel: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel: onCancel,
  });
}

async function tooLarge(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(OidcFailure);
  await expect(promise).rejects.toMatchObject({ reason: 'jwks_failed', libraryCode: 'TOO_LARGE' });
}

describe('readCappedText (JWKS body cap, T707)', () => {
  it('reads a body within the limit, counting bytes', async () => {
    // 'é' is 2 bytes in UTF-8: 4 characters, 8 bytes.
    expect(await readCappedText(new Response('éééé'), 8)).toBe('éééé');
    await tooLarge(readCappedText(new Response('éééé'), 7));
  });

  it('refuses a declared content-length over the limit before reading', async () => {
    let cancelled = false;
    const body = streamOf([new Uint8Array(4)], () => {
      cancelled = true;
    });
    const response = new Response(body, { headers: { 'content-length': '1000' } });
    await tooLarge(readCappedText(response, 100));
    expect(cancelled).toBe(true);
  });

  it('stops reading a stream (no content-length) at the first chunk over the limit', async () => {
    let cancelled = false;
    let pulled = 0;
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(40));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulled];
        pulled += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    await tooLarge(readCappedText(new Response(body), 100));
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it('an empty body is the empty string', async () => {
    expect(await readCappedText(new Response(null), 10)).toBe('');
  });
});
