import { isIP } from 'node:net';

export interface Cidr {
  /** Network address as written (IPv6 lower-cased). */
  readonly address: string;
  readonly prefix: number;
  readonly family: 4 | 6;
}

/**
 * Parses `address/prefix` or a bare address (full-length prefix).
 * Returns `null` when the entry is not a valid IPv4/IPv6 CIDR.
 */
export function parseCidr(input: string): Cidr | null {
  const trimmed = input.trim();
  const slash = trimmed.indexOf('/');
  const address = (slash === -1 ? trimmed : trimmed.slice(0, slash)).toLowerCase();
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    return null;
  }
  const maxPrefix = family === 4 ? 32 : 128;
  if (slash === -1) {
    return { address, prefix: maxPrefix, family };
  }
  const prefixText = trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) {
    return null;
  }
  const prefix = Number(prefixText);
  if (prefix > maxPrefix) {
    return null;
  }
  return { address, prefix, family };
}

export function formatCidr(cidr: Cidr): string {
  return `${cidr.address}/${String(cidr.prefix)}`;
}
