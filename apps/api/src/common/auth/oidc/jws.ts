import { Buffer } from 'node:buffer';
import { constants, createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Signature check of an ID token against the provider's JWKS (RFC 7515,
 * RFC 7518 §3), with `node:crypto` only. `openid-client` validates the
 * claims; it checks signatures only through a JWKS cache of 5 minutes that
 * reloads an unknown `kid` at most once a minute, while CONTRACTS §27.4 asks
 * for a 1-hour cache that reloads on an unknown `kid` (key rotation).
 */

/** A public key of a JWK Set (RFC 7517), as published by the provider. */
export interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly key_ops?: readonly string[];
  readonly crv?: string;
  readonly n?: string;
  readonly e?: string;
  readonly x?: string;
  readonly y?: string;
}

interface Algorithm {
  readonly kty: 'RSA' | 'EC' | 'OKP';
  /** Digest for `crypto.verify`; `null` for EdDSA. */
  readonly hash: 'sha256' | 'sha384' | 'sha512' | null;
  readonly crv?: string;
  readonly pss?: boolean;
}

/** Asymmetric JWS algorithms accepted for ID tokens (never `none` nor `HS*`). */
const ALGORITHMS: Readonly<Record<string, Algorithm>> = {
  RS256: { kty: 'RSA', hash: 'sha256' },
  RS384: { kty: 'RSA', hash: 'sha384' },
  RS512: { kty: 'RSA', hash: 'sha512' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true },
  PS384: { kty: 'RSA', hash: 'sha384', pss: true },
  PS512: { kty: 'RSA', hash: 'sha512', pss: true },
  ES256: { kty: 'EC', hash: 'sha256', crv: 'P-256' },
  ES384: { kty: 'EC', hash: 'sha384', crv: 'P-384' },
  ES512: { kty: 'EC', hash: 'sha512', crv: 'P-521' },
  EdDSA: { kty: 'OKP', hash: null, crv: 'Ed25519' },
  Ed25519: { kty: 'OKP', hash: null, crv: 'Ed25519' },
};

export interface JwsHeader {
  readonly alg: string;
  readonly kid: string | undefined;
}

/** The protected header of a compact JWS; `undefined` when malformed or not an accepted algorithm. */
export function jwsHeaderOf(jws: string): JwsHeader | undefined {
  const parts = jws.split('.');
  if (parts.length !== 3) return undefined;
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(parts[0] ?? '', 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof header !== 'object' || header === null) return undefined;
  const { alg, kid, crit } = header as { alg?: unknown; kid?: unknown; crit?: unknown };
  // No critical extension is understood (RFC 7515 §4.1.11).
  if (crit !== undefined) return undefined;
  if (typeof alg !== 'string' || !Object.hasOwn(ALGORITHMS, alg)) return undefined;
  if (kid !== undefined && typeof kid !== 'string') return undefined;
  return { alg, kid };
}

/** Keys of the set that may have signed a JWS with this header. */
export function candidateKeys(keys: readonly Jwk[], header: JwsHeader): Jwk[] {
  const algorithm = ALGORITHMS[header.alg];
  if (algorithm === undefined) return [];
  return keys.filter(
    (key) =>
      key.kty === algorithm.kty &&
      (header.kid === undefined || key.kid === header.kid) &&
      (key.alg === undefined || key.alg === header.alg) &&
      (key.use === undefined || key.use === 'sig') &&
      (key.key_ops === undefined || key.key_ops.includes('verify')) &&
      (algorithm.crv === undefined || key.crv === algorithm.crv),
  );
}

/** Smallest RSA modulus accepted (bits; RFC 7518 §3.3). */
export const MIN_RSA_MODULUS_BITS = 2048;

function publicKeyOf(key: Jwk): KeyObject | undefined {
  const members =
    key.kty === 'RSA'
      ? { kty: key.kty, n: key.n, e: key.e }
      : key.kty === 'EC'
        ? { kty: key.kty, crv: key.crv, x: key.x, y: key.y }
        : { kty: key.kty, crv: key.crv, x: key.x };
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: members as JsonWebKey, format: 'jwk' });
  } catch {
    return undefined;
  }
  if (publicKey.asymmetricKeyType === 'rsa') {
    const bits = publicKey.asymmetricKeyDetails?.modulusLength;
    if (bits === undefined || bits < MIN_RSA_MODULUS_BITS) return undefined;
  }
  return publicKey;
}

/** Whether `key` produced the signature of the compact JWS `jws` with `header.alg`. */
export function verifyJws(jws: string, header: JwsHeader, key: Jwk): boolean {
  const algorithm = ALGORITHMS[header.alg];
  const publicKey = publicKeyOf(key);
  if (algorithm === undefined || publicKey === undefined) return false;
  const [protectedHeader = '', payload = '', signature = ''] = jws.split('.');
  const data = Buffer.from(`${protectedHeader}.${payload}`, 'ascii');
  const sig = Buffer.from(signature, 'base64url');
  try {
    return verify(
      algorithm.hash,
      data,
      algorithm.kty === 'EC'
        ? { key: publicKey, dsaEncoding: 'ieee-p1363' }
        : algorithm.pss === true
          ? {
              key: publicKey,
              padding: constants.RSA_PKCS1_PSS_PADDING,
              saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
            }
          : publicKey,
      sig,
    );
  } catch {
    return false;
  }
}
