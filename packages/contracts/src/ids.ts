import { z } from 'zod';

import { randomString } from './random.js';

/**
 * Public ID prefixes (CONTRACTS §1.2). Keys name the entity; values are the
 * prefixes that appear on the wire. Adding a prefix means updating
 * CONTRACTS §1.2 in the same change.
 */
export const ID_PREFIX = {
  organization: 'org',
  user: 'usr',
  group: 'grp',
  workspace: 'wsp',
  base: 'bse',
  table: 'tbl',
  field: 'fld',
  record: 'rec',
  selectOption: 'opt',
  apiToken: 'tok',
  secret: 'sec',
  request: 'req',
  session: 'ses',
  invitation: 'inv',
  httpAllowlistEntry: 'hal',
  httpDelivery: 'hdl',
  view: 'viw',
  colorRule: 'clr',
  baseRole: 'rol',
  dashboard: 'dsh',
  widget: 'wgt',
  automation: 'aut',
  automationRun: 'run',
  automationStep: 'stp',
  event: 'evt',
  attachment: 'att',
  shareLink: 'shl',
  incomingWebhook: 'hok',
  incomingWebhookRequest: 'whr',
  job: 'job',
  auditLog: 'aud',
  userIdentity: 'idn',
  passwordReset: 'pwr',
  importUpload: 'imp',
  notification: 'ntf',
  emailIdentity: 'eid',
  userChannel: 'uch',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/** Every prefix from CONTRACTS §1.2, in table order. */
export const ID_PREFIXES = Object.values(ID_PREFIX) as readonly IdPrefix[];

export const idPrefixSchema = z.enum(ID_PREFIXES as [IdPrefix, ...IdPrefix[]]);

/** Alphabet for public IDs: `0-9A-Za-z`. */
export const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Number of random characters after `<prefix>_`. */
export const ID_RANDOM_LENGTH = 16;

/** Alphabet for physical table/column short IDs (SPEC §5.3): lower-case so they are valid unquoted identifiers. */
export const BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export const SHORT_ID_LENGTH = 12;

/** A public ID with a known prefix, e.g. `tbl_A1b2C3d4E5f6G7h8`. */
export type Id<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

const ID_BODY_PATTERN = `[0-9A-Za-z]{${String(ID_RANDOM_LENGTH)}}`;
const SHORT_ID_PATTERN = new RegExp(`^[0-9a-z]{${String(SHORT_ID_LENGTH)}}$`);
const idPatternCache = new Map<IdPrefix, RegExp>();

function idPattern(prefix: IdPrefix): RegExp {
  let pattern = idPatternCache.get(prefix);
  if (pattern === undefined) {
    // Prefixes are compile-time constants of `[a-z]{3}`, never user input.
    pattern = new RegExp(`^${prefix}_${ID_BODY_PATTERN}$`);
    idPatternCache.set(prefix, pattern);
  }
  return pattern;
}

/** Generates a new public ID `<prefix>_<16 base62>` from a CSPRNG. */
export function newId<P extends IdPrefix>(prefix: P): Id<P> {
  return `${prefix}_${randomString(BASE62_ALPHABET, ID_RANDOM_LENGTH)}`;
}

/** True when `value` is a well-formed ID with exactly this prefix. */
export function isId<P extends IdPrefix>(prefix: P, value: unknown): value is Id<P> {
  return typeof value === 'string' && idPattern(prefix).test(value);
}

/**
 * Zod schema for an ID of one prefix. Rejects other prefixes, wrong length
 * and characters outside base62.
 */
export function idOf<P extends IdPrefix>(prefix: P): z.ZodType<Id<P>, string> {
  return z
    .string()
    .regex(idPattern(prefix), { message: `Expected an ID of the form ${prefix}_<16 base62>` })
    .meta({ description: `${prefix} ID`, example: `${prefix}_A1b2C3d4E5f6G7h8` }) as z.ZodType<
    Id<P>,
    string
  >;
}

/** Generates a 12-character base36 short ID for physical names (`data.t_<shortId>`, `f_<shortId>`). */
export function newShortId(): string {
  return randomString(BASE36_ALPHABET, SHORT_ID_LENGTH);
}

export function isShortId(value: unknown): value is string {
  return typeof value === 'string' && SHORT_ID_PATTERN.test(value);
}
