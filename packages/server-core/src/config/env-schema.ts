import { Buffer } from 'node:buffer';
import { domainToASCII } from 'node:url';

import { z } from 'zod';

import { parseCidr, type Cidr } from './cidr.js';

/**
 * Environment variables of SPEC §20 (the canonical table). Adding a variable
 * means updating that table, this schema and `.env.example` together; a unit
 * test keeps `.env.example` and this schema in sync.
 *
 * Error messages never contain the received value: several variables carry
 * secrets (including credentials embedded in DATABASE_URL / CACHE_URL / SMTP_URL).
 */

/** Values applied when a variable is unset or empty (SPEC §20 "Mặc định"). */
export const ENV_DEFAULTS = {
  NODE_ENV: 'production',
  MODE: 'api',
  PORT: '3000',
  DATABASE_POOL_MAX: '10',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_PATH: '/data/files',
  S3_FORCE_PATH_STYLE: 'true',
  COOKIE_SECURE: 'auto',
  // Loopback plus the private range Docker allocates bridge networks from.
  TRUSTED_PROXIES: '127.0.0.0/8,::1/128,172.16.0.0/12',
  DEFAULT_LOCALE: 'en',
  DEFAULT_TIMEZONE: 'UTC',
  DEFAULT_CURRENCY: 'USD',
  ALLOW_ORG_CREATION: 'false',
  MAX_FIELDS_PER_TABLE: '500',
  COMPUTED_FIELDS_MAX_PER_BASE: '200',
  AUDIT_RETENTION_DAYS: '365',
  NOTIFICATION_RETENTION_DAYS: '90',
  EXPORT_MAX_ROWS: '1000000',
  // SPEC §14.2: 100 MB per attachment (T406).
  ATTACHMENT_MAX_FILE_BYTES: '104857600',
  AUTOMATION_MAX_RUNNING_PER_ORG: '5',
  // ADR-26 §4: runs one automation creates for one batch (request, import job, run).
  AUTOMATION_MAX_RUNS_PER_BATCH: '1000',
  // BACKLOG T518: automation runs older than this are deleted (cron `automation.runs_cleanup`).
  AUTOMATION_RUN_RETENTION_DAYS: '90',
  WORKER_CONCURRENCY: '5',
  // Email (T513, BACKLOG "Quyết định S5" #8): every limit can be overridden.
  SMTP_ALLOW_INSECURE: 'false',
  EMAIL_MAX_PER_HOUR_PER_ORG: '500',
  EMAIL_MAX_RECIPIENTS: '50',
  SMTP_MAX_PER_SEC: '5',
  EMAIL_TEST_SEND_PER_MIN: '5',
  // Gmail clips messages around 102 KB.
  EMAIL_MAX_HTML_BYTES: '102400',
  // Sender identities with their own SMTP (T530, ADR-33 §1A).
  SMTP_ALLOW_PRIVATE_HOSTS: 'false',
  EMAIL_MAX_PER_HOUR_PER_IDENTITY: '100',
  // Automation email footer policy (T531, ADR-33 §4).
  EMAIL_AUTOMATION_FOOTER: 'required',
  // Attachments of automation emails (T532): files, original bytes in all (15 MiB).
  EMAIL_MAX_ATTACHMENTS: '10',
  EMAIL_MAX_ATTACHMENT_BYTES: '15728640',
  // Inline images of one automation email, signature included (T534).
  EMAIL_MAX_INLINE_IMAGES: '5',
  // Outbound HTTP (T600, ADR-35 §3): organization allowlists may open private addresses.
  HTTP_PRIVATE_ALLOWLIST: 'org',
  // Incoming webhooks (SPEC §13.2, §20): highest `rate_limit_per_sec` of a hook.
  WEBHOOK_MAX_RATE_PER_SEC: '50',
  LOG_LEVEL: 'info',
} as const;

const MIN_SECRET_BYTES = 32;
const MASTER_KEY_BYTES = 32;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function text() {
  return z.string({
    error: (issue) => (issue.input === undefined ? 'is required' : 'must be a string'),
  });
}

function oneOf<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values, {
    error: (issue) =>
      issue.input === undefined ? 'is required' : `must be one of: ${values.join(', ')}`,
  });
}

function flag() {
  return oneOf(['true', 'false']).transform((value) => value === 'true');
}

function integer(min: number, max: number) {
  return text()
    .regex(/^\d+$/, `must be an integer between ${String(min)} and ${String(max)}`)
    .transform(Number)
    .refine(
      (value) => value >= min && value <= max,
      `must be an integer between ${String(min)} and ${String(max)}`,
    );
}

function parseUrl(value: string, protocols: readonly string[]): URL | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  return protocols.includes(url.protocol) ? url : null;
}

function urlOf(protocols: readonly string[]) {
  const expected = protocols.map((protocol) => `${protocol}//`).join(' or ');
  return text().refine(
    (value) => parseUrl(value, protocols) !== null,
    `must be a valid ${expected} URL`,
  );
}

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * `Example.COM` / `bücher.example` → `example.com` / `xn--bcher-kva.example`;
 * `null` when not a host name with at least two labels.
 */
export function asciiDomain(value: string): string | null {
  const ascii = domainToASCII(value.trim().toLowerCase());
  if (ascii === '' || ascii.length > 253 || !ascii.includes('.')) return null;
  const labels = ascii.split('.');
  const valid = labels.every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label));
  return valid ? ascii : null;
}

/** Plain `smtp(s)://[user[:pass]@]host[:port]`: no path, no query (they could turn TLS off). */
function isPlainSmtpUrl(value: string): boolean {
  const url = parseUrl(value, ['smtp:', 'smtps:']);
  return (
    url !== null &&
    url.hostname !== '' &&
    (url.pathname === '' || url.pathname === '/') &&
    url.search === '' &&
    url.hash === ''
  );
}

function toOrigin(value: string): string | null {
  const url = parseUrl(value, ['http:', 'https:']);
  if (url === null || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return null;
  }
  return url.origin;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function canonicalLocale(value: string): string | null {
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

const currencies = new Set(Intl.supportedValuesOf('currency'));

/** Slug of an OIDC provider in `OIDC_PROVIDERS` (ADR-36 §3, CONTRACTS §27.4). */
export const OIDC_SLUG_PATTERN = /^[a-z0-9-]{1,32}$/;
/** At most this many OIDC providers (CONTRACTS §27.4). */
export const OIDC_MAX_PROVIDERS = 10;
/** Scopes requested when `OIDC_<SLUG>_SCOPES` is unset. */
export const OIDC_DEFAULT_SCOPES = 'openid email profile';

/** `OIDC_<SLUG>_<suffix>` of a slug (`my-idp` → `OIDC_MY_IDP_ISSUER`). */
export function oidcVariableName(slug: string, suffix: OidcProviderVariable): string {
  return `OIDC_${slug.toUpperCase().replaceAll('-', '_')}_${suffix}`;
}

/**
 * Variables of one OIDC provider (SPEC §20), as `OIDC_<SLUG>_<suffix>`.
 * `issuer` must be `https://`, except `http://` when `NODE_ENV=development`
 * (checked by `loadConfig`, which knows `NODE_ENV`).
 */
export const oidcProviderEnvSchema = z.object({
  ISSUER: text().refine((value) => {
    const url = parseUrl(value, ['http:', 'https:']);
    return (
      url !== null &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  }, 'must be an http(s):// issuer URL without credentials, query or fragment'),
  CLIENT_ID: text().min(1, 'is required').max(255, 'must be at most 255 characters'),
  CLIENT_SECRET: text().min(1, 'is required').max(1024, 'must be at most 1024 characters'),
  NAME: text().max(100, 'must be at most 100 characters').optional(),
  SCOPES: text()
    .transform((value) => [...new Set(value.split(/[\s,]+/).filter((scope) => scope !== ''))])
    .refine(
      (list) => list.every((scope) => /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)),
      'must be scope names separated by spaces or commas',
    )
    .refine((list) => list.includes('openid'), 'must include openid'),
  ALLOW_SIGNUP: flag(),
  ALLOWED_DOMAINS: text()
    .transform((value) => commaList(value).map(asciiDomain))
    .refine(
      (list) => list.length > 0 && list.every((entry) => entry !== null),
      'must be a comma-separated list of domain names',
    )
    .transform((list) => [...new Set(list as string[])])
    .optional(),
  LINK_BY_EMAIL: flag(),
  AUTO_JOIN_ORG: text()
    .regex(/^[a-z0-9-]{1,100}$/, 'must be an organization slug')
    .optional(),
});

export type OidcProviderVariable = keyof typeof oidcProviderEnvSchema.shape;

/** Suffixes of the per-provider variables, in SPEC §20 order. */
export const OIDC_PROVIDER_VARIABLES = Object.keys(
  oidcProviderEnvSchema.shape,
) as readonly OidcProviderVariable[];

/** Per-provider defaults (SPEC §20 "Mặc định"). `NAME` defaults to the slug. */
export const OIDC_PROVIDER_DEFAULTS: Readonly<Partial<Record<OidcProviderVariable, string>>> = {
  SCOPES: OIDC_DEFAULT_SCOPES,
  ALLOW_SIGNUP: 'false',
  LINK_BY_EMAIL: 'false',
};

export const envSchema = z.object({
  NODE_ENV: oneOf(['production', 'development', 'test']),
  MODE: oneOf(['api', 'worker', 'all', 'migrate']),
  PORT: integer(1, 65535),
  PUBLIC_URL: urlOf(['http:', 'https:']).transform((value) => value.replace(/\/+$/, '')),
  DATABASE_URL: urlOf(['postgres:', 'postgresql:']),
  DATABASE_POOL_MAX: integer(1, 1000),
  CACHE_URL: urlOf(['redis:', 'rediss:']),
  STORAGE_DRIVER: oneOf(['local', 's3']),
  STORAGE_LOCAL_PATH: text().min(1, 'is required'),
  S3_ENDPOINT: urlOf(['http:', 'https:']).optional(),
  S3_REGION: text().optional(),
  S3_BUCKET: text()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid S3 bucket name')
    .optional(),
  S3_ACCESS_KEY_ID: text().optional(),
  S3_SECRET_ACCESS_KEY: text().optional(),
  S3_FORCE_PATH_STYLE: flag(),
  // Endpoint browsers use for presigned URLs; defaults to S3_ENDPOINT.
  S3_PUBLIC_ENDPOINT: urlOf(['http:', 'https:']).optional(),
  APP_MASTER_KEY: text()
    .refine(
      (value) => BASE64.test(value) && Buffer.from(value, 'base64').length === MASTER_KEY_BYTES,
      `must be exactly ${String(MASTER_KEY_BYTES)} bytes encoded as base64 (openssl rand -base64 32)`,
    )
    .transform((value) => Buffer.from(value, 'base64')),
  SESSION_SECRET: text().refine(
    (value) => Buffer.byteLength(value, 'utf8') >= MIN_SECRET_BYTES,
    `must be at least ${String(MIN_SECRET_BYTES)} bytes (openssl rand -base64 32)`,
  ),
  COOKIE_SECURE: oneOf(['auto', 'true', 'false']).transform((value) =>
    value === 'auto' ? ('auto' as const) : value === 'true',
  ),
  TRUSTED_PROXIES: text()
    .transform((value) => commaList(value).map(parseCidr))
    .refine(
      (list) => list.every((entry) => entry !== null),
      'must be a comma-separated list of IPv4/IPv6 addresses or CIDR ranges',
    )
    .transform((list) => list as Cidr[]),
  CORS_ORIGINS: text()
    .transform((value) => commaList(value).map(toOrigin))
    .refine(
      (list) => list.length > 0 && list.every((entry) => entry !== null),
      'must be a comma-separated list of http(s) origins without path',
    )
    .transform((list) => list as string[])
    .optional(),
  // OIDC sign-in providers (ADR-36 §3): comma-separated slugs; each slug is
  // configured by `OIDC_<SLUG>_*` (`OIDC_PROVIDER_VARIABLES`, read by
  // `loadConfig`). Unset = password sign-in only.
  OIDC_PROVIDERS: text()
    .transform(commaList)
    .refine(
      (list) => list.length > 0 && list.every((slug) => OIDC_SLUG_PATTERN.test(slug)),
      'must be a comma-separated list of slugs of 1-32 characters a-z, 0-9 and -',
    )
    .refine((list) => new Set(list).size === list.length, 'must not list the same provider twice')
    .refine(
      (list) => list.length <= OIDC_MAX_PROVIDERS,
      `must list at most ${String(OIDC_MAX_PROVIDERS)} providers`,
    )
    .optional(),
  SMTP_URL: urlOf(['smtp:', 'smtps:'])
    .refine(isPlainSmtpUrl, 'must be smtp(s)://[user:password@]host[:port] without path or query')
    .optional(),
  // `no-reply@example.com` or `Cellhive <no-reply@example.com>`.
  SMTP_FROM: text()
    .regex(
      /^(?:[^@\s<>]+@[^@\s<>]+|[^<>]*<[^@\s<>]+@[^@\s<>]+>)$/,
      'must be an email address, optionally as "Name <address>"',
    )
    .optional(),
  // Domains the instance SMTP may send `From` (sender identities `send_as`,
  // ADR-33); default: the domain of SMTP_FROM.
  SMTP_ALLOWED_FROM_DOMAINS: text()
    .transform((value) => commaList(value).map(asciiDomain))
    .refine(
      (list) => list.length > 0 && list.every((entry) => entry !== null),
      'must be a comma-separated list of domain names',
    )
    .transform((list) => [...new Set(list as string[])])
    .optional(),
  // `true` allows plain SMTP without STARTTLS (local development only).
  SMTP_ALLOW_INSECURE: flag(),
  EMAIL_MAX_PER_HOUR_PER_ORG: integer(1, 1_000_000),
  EMAIL_MAX_RECIPIENTS: integer(1, 500),
  SMTP_MAX_PER_SEC: integer(1, 1000),
  EMAIL_TEST_SEND_PER_MIN: integer(1, 1000),
  EMAIL_MAX_HTML_BYTES: integer(1024, 1_048_576),
  // `true` lets sender identities use SMTP servers on private/loopback
  // addresses (self-hosted LAN mail server); metadata addresses stay blocked.
  SMTP_ALLOW_PRIVATE_HOSTS: flag(),
  EMAIL_MAX_PER_HOUR_PER_IDENTITY: integer(1, 1_000_000),
  // Footer of automation emails (T531, ADR-33 §4): `required` forbids
  // `footer: none` everywhere; `org` leaves it to each organization.
  EMAIL_AUTOMATION_FOOTER: oneOf(['required', 'org']),
  // Caps of the attachments of one automation email (T532); organizations may
  // lower them. At most 20 files and 30 MiB of original files.
  EMAIL_MAX_ATTACHMENTS: integer(1, 20),
  EMAIL_MAX_ATTACHMENT_BYTES: integer(1_048_576, 31_457_280),
  // Inline images of one automation email (T534); their bytes count toward the
  // attachment byte limit. At most 20.
  EMAIL_MAX_INLINE_IMAGES: integer(1, 20),
  DEFAULT_LOCALE: text()
    .refine((value) => canonicalLocale(value) !== null, 'must be a BCP 47 language tag')
    .transform((value) => canonicalLocale(value) ?? value),
  DEFAULT_TIMEZONE: text().refine(isTimeZone, 'must be an IANA time zone'),
  DEFAULT_CURRENCY: text().refine(
    (value) => currencies.has(value),
    'must be an upper-case ISO 4217 currency code',
  ),
  ALLOW_ORG_CREATION: flag(),
  MAX_FIELDS_PER_TABLE: integer(1, 1000),
  // SPEC §9.5: formula and lookup fields per base (T456).
  COMPUTED_FIELDS_MAX_PER_BASE: integer(1, 10_000),
  // 0 = keep audit entries forever (ADR-23 §5).
  AUDIT_RETENTION_DAYS: integer(0, 36500),
  // ADR-29 §1: notifications older than this are deleted (T511).
  NOTIFICATION_RETENTION_DAYS: integer(1, 3650),
  EXPORT_MAX_ROWS: integer(1, 10_000_000),
  // Up to 5 GiB, the largest single S3 PUT (uploads are one presigned PUT).
  ATTACHMENT_MAX_FILE_BYTES: integer(1, 5 * 1024 * 1024 * 1024),
  AUTOMATION_MAX_RUNNING_PER_ORG: integer(1, 1000),
  AUTOMATION_MAX_RUNS_PER_BATCH: integer(1, 50_000),
  AUTOMATION_RUN_RETENTION_DAYS: integer(1, 3650),
  WORKER_CONCURRENCY: integer(1, 1000),
  // Outbound HTTP of automations (T600, ADR-35 §3, SPEC §14.3): `org` — an
  // organization's allowlist entry lets its host reach private addresses
  // (an internal n8n); `off` — entries never open private addresses, only
  // another port on a public host (instances shared by organizations that
  // do not trust each other). Cloud metadata is never reachable either way.
  HTTP_PRIVATE_ALLOWLIST: oneOf(['org', 'off']),
  // Highest `rate_limit_per_sec` a base admin may give an incoming webhook
  // (SPEC §13.2, CONTRACTS §25.1; burst 4×). The per-base cap stays 50/s.
  WEBHOOK_MAX_RATE_PER_SEC: integer(1, 1000),
  LOG_LEVEL: oneOf(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  METRICS_TOKEN: text()
    .refine(
      (value) => Buffer.byteLength(value, 'utf8') >= MIN_SECRET_BYTES,
      `must be at least ${String(MIN_SECRET_BYTES)} bytes (openssl rand -base64 32)`,
    )
    .optional(),
  METRICS_PORT: integer(1, 65535).optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: urlOf(['http:', 'https:']).optional(),
});

export type EnvKey = keyof typeof envSchema.shape;
export type ParsedEnv = z.output<typeof envSchema>;

/** Every variable name of SPEC §20, in table order. */
export const ENV_KEYS = Object.keys(envSchema.shape) as readonly EnvKey[];

export interface EnvRule {
  readonly when: (env: Readonly<Partial<Record<EnvKey, string>>>) => boolean;
  readonly requires: readonly EnvKey[];
  readonly reason: string;
}

/** Variables that become required depending on other variables. */
export const CONDITIONAL_REQUIREMENTS: readonly EnvRule[] = [
  {
    when: (env) => env.STORAGE_DRIVER === 's3',
    requires: ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
    reason: 'when STORAGE_DRIVER=s3',
  },
  {
    when: (env) => env.SMTP_URL !== undefined,
    requires: ['SMTP_FROM'],
    reason: 'when SMTP_URL is set',
  },
];
