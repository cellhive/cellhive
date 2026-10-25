import { asciiDomain } from '../config/env-schema.js';

/**
 * Email addresses and header text (ADR-32 §3, `docs/reviews/S5-email-research.md`
 * §7.5): every address is parsed and validated on its own (never a string
 * joined into a header), IDN domains become punycode, and free text that
 * ends up in a header loses CR/LF and control characters.
 */

/** RFC 5321 dot-atom local part, ASCII only (no quoted strings, no SMTPUTF8). */
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

const MAX_LOCAL_LENGTH = 64;
const MAX_ADDRESS_LENGTH = 254;

/**
 * `An@Bücher.Example` → `An@xn--bcher-kva.example`; `null` when it is not a
 * single plain address (display names, comments, IP literals and
 * non-ASCII local parts are rejected).
 */
export function normalizeAddress(input: string): string | null {
  const value = input.trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  if (local.length > MAX_LOCAL_LENGTH || !LOCAL_PART.test(local)) return null;
  const domain = asciiDomain(value.slice(at + 1));
  if (domain === null) return null;
  const address = `${local}@${domain}`;
  return address.length > MAX_ADDRESS_LENGTH ? null : address;
}

/** Lower-case domain of a normalized address. */
export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * What logs, run steps and API responses may show of an address:
 * `a***@example.com` (first character of the local part, then the domain).
 */
export function maskAddress(input: string): string {
  const value = input.trim();
  const at = value.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${value.slice(0, 1)}***@${value.slice(at + 1).toLowerCase()}`;
}

/** C0/C1 controls, DEL and the Unicode line/paragraph separators. */
// eslint-disable-next-line no-control-regex -- the point is to match control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Subject or display name: control characters (CR/LF included) become a
 * space, runs of white space collapse, at most `maxLength` code points.
 */
export function sanitizeHeaderText(value: string, maxLength = 255): string {
  const cleaned = value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(cleaned);
  return points.length <= maxLength ? cleaned : points.slice(0, maxLength).join('').trimEnd();
}

export type RecipientKind = 'to' | 'cc' | 'bcc';

export interface RecipientLists {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}

export interface NormalizedRecipients extends RecipientLists {
  /** Unique valid addresses over the three lists. */
  readonly count: number;
  /** Inputs that are not valid addresses, masked. */
  readonly invalid: readonly string[];
}

/**
 * Validates and de-duplicates (case-insensitively, across the lists: `to`
 * wins over `cc`, `cc` over `bcc`) the recipients of one message.
 */
export function normalizeRecipients(lists: RecipientLists): NormalizedRecipients {
  const seen = new Set<string>();
  const invalid: string[] = [];
  const pick = (inputs: readonly string[]): string[] => {
    const kept: string[] = [];
    for (const input of inputs) {
      const address = normalizeAddress(input);
      if (address === null) {
        invalid.push(maskAddress(input));
        continue;
      }
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(address);
    }
    return kept;
  };
  const to = pick(lists.to);
  const cc = pick(lists.cc);
  const bcc = pick(lists.bcc);
  return { to, cc, bcc, count: seen.size, invalid };
}
