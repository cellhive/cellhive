import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { MAX_ALLOWLIST_PATTERN_LENGTH, parseAllowlistPattern } from './http-allowlist.js';
import { idOf } from './ids.js';

/**
 * Secrets of an organization (SPEC §5.10 `meta.secrets`, CONTRACTS §24;
 * BACKLOG T516, T606): credentials automations use without anyone seeing
 * them — the token of a Telegram bot (`send_telegram`), the value of an
 * auth header and the Standard Webhooks signing secret of `http_request`
 * (ADR-35 §8). Managed by
 * organization owners/admins, with a base scope like sender identities
 * (ADR-33): `all` bases or the `selected` ones. The value is sealed with
 * AES-256-GCM (key derived from `APP_MASTER_KEY`) and **never** returned,
 * logged or audited; to change it, send a new one. One `telegram_bot` secret
 * may also be the organization's notification bot (T549, CONTRACTS §22.7).
 */

/**
 * Kinds of secret (what reads it): `telegram_bot` (`send_telegram`, the
 * notification bot), `http_header` (the value of the auth header of
 * `http_request` — the header name is in the action), `webhook_signing`
 * (`whsec_…`, signs `http_request`; replacing it keeps the previous value
 * 24 hours so receivers can switch — T606).
 */
export const SECRET_KINDS = ['telegram_bot', 'http_header', 'webhook_signing'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

/**
 * Kinds an outbound HTTP call sends (ADR-36 §4, T701): they carry the hosts
 * they may be sent to (`allowed_hosts`).
 */
export const HTTP_SECRET_KINDS = [
  'http_header',
  'webhook_signing',
] as const satisfies readonly SecretKind[];
export type HttpSecretKind = (typeof HTTP_SECRET_KINDS)[number];

export function isHttpSecretKind(kind: SecretKind): kind is HttpSecretKind {
  return (HTTP_SECRET_KINDS as readonly string[]).includes(kind);
}

/** Most entries of `allowed_hosts` (CONTRACTS §24). */
export const SECRET_MAX_ALLOWED_HOSTS = 20;
/**
 * Days an HTTP secret stored before `allowed_hosts` existed (migration 0051,
 * empty list) is still sent to any host (`legacy_hosts_until`).
 */
export const SECRET_LEGACY_HOSTS_DAYS = 30;

/** Kinds whose value the server can generate (`generate: true`). */
export const GENERATED_SECRET_KINDS = ['webhook_signing'] as const satisfies readonly SecretKind[];

/** How long the previous value of a replaced `webhook_signing` secret keeps signing. */
export const SECRET_ROTATION_OVERLAP_HOURS = 24;

export const SECRET_BASE_SCOPES = ['all', 'selected'] as const;
export type SecretBaseScope = (typeof SECRET_BASE_SCOPES)[number];

/** Most secrets per organization. */
export const SECRETS_MAX_PER_ORG = 100;
/** Most bases of a `selected` scope. */
export const SECRET_MAX_BASES = 500;
/** Longest name. */
export const MAX_SECRET_NAME_LENGTH = 100;
/** Longest value accepted (an `http_header` value; a Telegram token is about 46 characters). */
export const MAX_SECRET_VALUE_LENGTH = 4_096;

/**
 * Shape of a Telegram bot token (`<bot id>:<35 characters>`, BotFather):
 * checked when saved so a typo fails early, never echoed back.
 */
export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{1,20}:[A-Za-z0-9_-]{30,100}$/u;

/** An `http_header` value: printable ASCII (no control character, so no CR/LF), ≤ 4,096. */
export const HTTP_HEADER_SECRET_PATTERN = /^[\x20-\x7e]{1,4096}$/u;

/** Prefix and key size (bytes, base64-decoded) of a `webhook_signing` value (Standard Webhooks). */
export const WEBHOOK_SIGNING_SECRET_PREFIX = 'whsec_';
export const WEBHOOK_SIGNING_SECRET_MIN_BYTES = 24;
export const WEBHOOK_SIGNING_SECRET_MAX_BYTES = 64;

/** Whether `value` (trimmed) has the shape secrets of `kind` need — never echoed back. */
export function isValidSecretValue(kind: SecretKind, value: string): boolean {
  switch (kind) {
    case 'telegram_bot':
      return TELEGRAM_BOT_TOKEN_PATTERN.test(value);
    case 'http_header':
      return HTTP_HEADER_SECRET_PATTERN.test(value);
    case 'webhook_signing': {
      if (!value.startsWith(WEBHOOK_SIGNING_SECRET_PREFIX)) return false;
      const key = value.slice(WEBHOOK_SIGNING_SECRET_PREFIX.length);
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(key) || key.length % 4 !== 0) return false;
      const bytes = (key.length / 4) * 3 - (key.endsWith('==') ? 2 : key.endsWith('=') ? 1 : 0);
      return bytes >= WEBHOOK_SIGNING_SECRET_MIN_BYTES && bytes <= WEBHOOK_SIGNING_SECRET_MAX_BYTES;
    }
  }
}

export const secretIdSchema = idOf('sec');

const secretNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SECRET_NAME_LENGTH)
  .meta({ description: 'Shown to automation managers (unique in the organization)' });

const secretValueSchema = z
  .string()
  .min(1)
  .max(MAX_SECRET_VALUE_LENGTH)
  .meta({
    description:
      'Write-only: a bot token (`123456:ABC…`), a header value (printable ASCII) or a ' +
      '`whsec_…` signing secret (24–64 bytes). Never returned; send a new one to replace it',
    writeOnly: true,
  });

const generateSchema = z
  .literal(true)
  .optional()
  .meta({
    description:
      '`webhook_signing` only, instead of `value`: the server generates a `whsec_` secret of ' +
      '32 bytes and returns it **once** in `value` of the response',
  });

/** `value` xor `generate: true`; `generate` only for a kind the server can generate. */
function valueOrGenerate(
  body: { readonly value?: string | undefined; readonly generate?: true | undefined },
  kind: SecretKind | undefined,
  ctx: z.RefinementCtx,
  required: boolean,
): void {
  if (body.value !== undefined && body.generate === true) {
    ctx.addIssue({
      code: 'custom',
      message: 'Send value or generate, not both',
      path: ['generate'],
    });
  }
  if (required && body.value === undefined && body.generate !== true) {
    ctx.addIssue({ code: 'custom', message: 'Send value or generate: true', path: ['value'] });
  }
  if (
    body.generate === true &&
    kind !== undefined &&
    !(GENERATED_SECRET_KINDS as readonly string[]).includes(kind)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Only webhook_signing secrets can be generated',
      path: ['generate'],
    });
  }
}

const allowedHostsSchema = z
  .array(z.string().trim().min(1).max(MAX_ALLOWLIST_PATTERN_LENGTH))
  .meta({
    description:
      '`http_header` / `webhook_signing` only: hosts the secret may be sent to — exact ' +
      '(`api.crm.example`) or `*.suffix` (subdomains only, at least two labels), with an ' +
      'optional `:port` (without one: ports 80/443 over `https` only — a plain `http` URL ' +
      'needs an entry naming its port, e.g. `n8n:5678`). Like the HTTP allowlist (CONTRACTS ' +
      '§25.4) but it never opens a private address. 1–20 entries; stored lower case, ' +
      'punycode, without duplicates',
    example: ['api.crm.example', '*.hooks.example:8443'],
  });

/**
 * `allowed_hosts` as sent: 1–20 entries (`SECRET_HOSTS_REQUIRED`,
 * `TOO_MANY_ALLOWED_HOSTS`), each a host pattern (`INVALID_ALLOWLIST_PATTERN`).
 */
function checkAllowedHosts(hosts: readonly string[], ctx: z.RefinementCtx): void {
  if (hosts.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'List at least one host this secret may be sent to',
      path: ['allowed_hosts'],
      params: { code: SECRET_HOSTS_REQUIRED },
    });
    return;
  }
  if (hosts.length > SECRET_MAX_ALLOWED_HOSTS) {
    ctx.addIssue({
      code: 'custom',
      message: `At most ${String(SECRET_MAX_ALLOWED_HOSTS)} hosts`,
      path: ['allowed_hosts'],
      params: { code: TOO_MANY_ALLOWED_HOSTS, maximum: SECRET_MAX_ALLOWED_HOSTS },
    });
    return;
  }
  hosts.forEach((host, index) => {
    if (parseAllowlistPattern(host) === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Not a host pattern (exact host or *.suffix, optional :port, no IP address)',
        path: ['allowed_hosts', index],
        params: { code: 'INVALID_ALLOWLIST_PATTERN' },
      });
    }
  });
}

/**
 * Canonical `allowed_hosts` (lower case, punycode, no trailing dot), in the
 * order given, duplicates dropped; entries that are not patterns are left
 * out (the request schema refuses them first).
 */
export function canonicalAllowedHosts(hosts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const host of hosts) {
    const parsed = parseAllowlistPattern(host);
    if (parsed !== null) seen.add(parsed.pattern);
  }
  return [...seen];
}

export const createSecretRequestSchema = z
  .strictObject({
    kind: z.enum(SECRET_KINDS),
    name: secretNameSchema,
    value: secretValueSchema.optional(),
    generate: generateSchema,
    base_scope: z.enum(SECRET_BASE_SCOPES).default('all'),
    base_ids: z.array(idOf('bse')).max(SECRET_MAX_BASES).default([]).meta({
      description: 'Bases of a `selected` scope (ignored for `all`)',
    }),
    allowed_hosts: allowedHostsSchema.optional().meta({
      description:
        'Required for `http_header` / `webhook_signing` (`SECRET_HOSTS_REQUIRED`); not ' +
        'accepted for `telegram_bot`',
    }),
  })
  .superRefine((body, ctx) => {
    valueOrGenerate(body, body.kind, ctx, true);
    if (isHttpSecretKind(body.kind)) {
      checkAllowedHosts(body.allowed_hosts ?? [], ctx);
    } else if (body.allowed_hosts !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Only http_header and webhook_signing secrets have allowed hosts',
        path: ['allowed_hosts'],
        params: { code: 'UNRECOGNIZED_KEY' },
      });
    }
  })
  .meta({ id: 'CreateSecretRequest' });
export type CreateSecretRequest = z.infer<typeof createSecretRequestSchema>;
export type CreateSecretInput = z.input<typeof createSecretRequestSchema>;

export const updateSecretRequestSchema = z
  .strictObject({
    name: secretNameSchema.optional(),
    value: secretValueSchema.optional(),
    generate: generateSchema,
    base_scope: z.enum(SECRET_BASE_SCOPES).optional(),
    base_ids: z.array(idOf('bse')).max(SECRET_MAX_BASES).optional(),
    allowed_hosts: allowedHostsSchema.optional().meta({
      description:
        '`http_header` / `webhook_signing` only (another kind: `UNRECOGNIZED_KEY`): replaces ' +
        'the list and ends the transition period of a secret stored before the list existed ' +
        '(`legacy_hosts_until` becomes `null`)',
    }),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.value !== undefined ||
      body.generate !== undefined ||
      body.base_scope !== undefined ||
      body.base_ids !== undefined ||
      body.allowed_hosts !== undefined,
    { message: 'Send name, value, generate, base_scope, base_ids or allowed_hosts', path: [] },
  )
  .superRefine((body, ctx) => {
    valueOrGenerate(body, undefined, ctx, false);
    if (body.allowed_hosts !== undefined) checkAllowedHosts(body.allowed_hosts, ctx);
  })
  .meta({
    id: 'UpdateSecretRequest',
    description:
      'Changing the scope does not touch automations: a step of a base left out fails with ' +
      '`secret_unavailable` when it runs. A new value (or `generate: true`) of a ' +
      '`webhook_signing` secret keeps the previous one signing for 24 hours ' +
      '(`previous_value_expires_at`)',
  });
export type UpdateSecretRequest = z.infer<typeof updateSecretRequestSchema>;

/** A secret as owners/admins see it: never the value. */
export const secretSchema = z
  .object({
    id: secretIdSchema,
    organization_id: idOf('org'),
    kind: z.enum(SECRET_KINDS),
    name: z.string(),
    base_scope: z.enum(SECRET_BASE_SCOPES),
    base_ids: z.array(idOf('bse')),
    allowed_hosts: z.array(z.string()).meta({
      description:
        'Hosts an `http_request` / `run_n8n_workflow` step may send this secret to (canonical ' +
        'patterns); always `[]` for `telegram_bot`. Empty for an HTTP secret stored before ' +
        'the list existed: see `legacy_hosts_until`',
    }),
    legacy_hosts_until: isoDateTimeSchema.nullable().meta({
      description:
        'HTTP secret stored before `allowed_hosts` existed (empty list): sent to any host ' +
        'until then, refused afterwards (`secret_host_not_allowed`, `reason: legacy_expired`) ' +
        '— set `allowed_hosts` to keep using it. `null` once a list is set, and for ' +
        '`telegram_bot`',
    }),
    previous_value_expires_at: isoDateTimeSchema.nullable().meta({
      description:
        '`webhook_signing` being replaced: until then requests carry a signature with the ' +
        'previous value too; `null` otherwise',
    }),
    created_by: z
      .object({ id: idOf('usr'), name: z.string() })
      .nullable()
      .meta({ description: '`null` when that account is gone' }),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'Secret', description: 'Organization secret (never its value)' });
export type SecretDto = z.infer<typeof secretSchema>;

/**
 * `201`/`200` of a create or update with `generate: true`: the secret plus
 * the generated `value` — the only time it is ever returned.
 */
export const secretWithValueSchema = secretSchema
  .extend({
    value: z.string().optional().meta({
      description: 'Only when the server generated it (`generate: true`): shown once, store it',
    }),
  })
  .meta({ id: 'SecretWithValue' });
export type SecretWithValueDto = z.infer<typeof secretWithValueSchema>;

export const secretListSchema = z
  .object({ items: z.array(secretSchema) })
  .meta({ id: 'SecretList' });
export type SecretList = z.infer<typeof secretListSchema>;

/** What an automation manager of a base sees: the secrets usable there, by name only. */
export const baseSecretSchema = z
  .object({ id: secretIdSchema, kind: z.enum(SECRET_KINDS), name: z.string() })
  .meta({ id: 'BaseSecret' });
export type BaseSecretDto = z.infer<typeof baseSecretSchema>;

export const baseSecretListSchema = z
  .object({ items: z.array(baseSecretSchema) })
  .meta({ id: 'BaseSecretList' });
export type BaseSecretList = z.infer<typeof baseSecretListSchema>;

export const baseSecretListQuerySchema = z.object({
  kind: z.enum(SECRET_KINDS).optional().meta({ description: 'Only secrets of this kind' }),
});
export type BaseSecretListQuery = z.infer<typeof baseSecretListQuerySchema>;

/** An automation whose steps use the secret (`name` only when the caller sees it). */
export const secretAutomationUsageSchema = z
  .object({
    kind: z.literal('automation'),
    automation_id: idOf('aut'),
    base_id: idOf('bse'),
    /** `null` when the caller cannot see the automation. */
    name: z.string().nullable(),
  })
  .meta({ id: 'SecretAutomationUsage' });
export type SecretAutomationUsage = z.infer<typeof secretAutomationUsageSchema>;

/**
 * The secret is the organization's notification bot (CONTRACTS §22.7, T549):
 * personal Telegram channels of members are linked to it.
 */
export const secretNotificationChannelUsageSchema = z
  .object({ kind: z.literal('notification_channel') })
  .meta({ id: 'SecretNotificationChannelUsage' });
export type SecretNotificationChannelUsage = z.infer<typeof secretNotificationChannelUsageSchema>;

/** Something that uses the secret: an automation step, or the notification channel (T549). */
export const secretUsageSchema = z
  .discriminatedUnion('kind', [secretAutomationUsageSchema, secretNotificationChannelUsageSchema])
  .meta({ id: 'SecretUsage' });
export type SecretUsage = z.infer<typeof secretUsageSchema>;

export const secretUsagesSchema = z
  .object({ items: z.array(secretUsageSchema), total: z.int().min(0) })
  .meta({ id: 'SecretUsages' });
export type SecretUsages = z.infer<typeof secretUsagesSchema>;

// --- Errors ------------------------------------------------------------------------------

/** `VALIDATION_FAILED` detail codes of the secret API (CONTRACTS §6, §24). */
export const SECRET_NAME_TAKEN = 'SECRET_NAME_TAKEN';
export const INVALID_BOT_TOKEN = 'INVALID_BOT_TOKEN';
/** A value that does not fit its kind (`http_header`, `webhook_signing` — T606); never echoed. */
export const INVALID_SECRET_VALUE = 'INVALID_SECRET_VALUE';
export const SECRET_LIMIT_REACHED = 'SECRET_LIMIT_REACHED';
/**
 * `409 SECRET_IN_USE` (delete): `errors[0].code = SECRET_IN_USE`,
 * `params = { usages: SecretUsage[], total }` — automations using it and,
 * first, `{ kind: "notification_channel" }` when it is the organization's
 * notification bot (T549).
 */
export const SECRET_IN_USE = 'SECRET_IN_USE';
/** `VALIDATION_FAILED` detail (path `allowed_hosts`): an HTTP secret needs ≥ 1 host. */
export const SECRET_HOSTS_REQUIRED = 'SECRET_HOSTS_REQUIRED';
/** `VALIDATION_FAILED` detail (path `allowed_hosts`): more than 20 hosts. */
export const TOO_MANY_ALLOWED_HOSTS = 'TOO_MANY_ALLOWED_HOSTS';
/**
 * `422 AUTOMATION_INVALID` detail (path `…auth.secret_id` or
 * `…signing_secret_id`): the literal URL of the step names a host the secret
 * may not be sent to — `params = { kind, reason: not_listed | legacy_expired }`.
 * At run time the same check fails the step with `secret_host_not_allowed`.
 */
export const SECRET_HOST_NOT_ALLOWED = 'SECRET_HOST_NOT_ALLOWED';
/**
 * `422 AUTOMATION_INVALID` detail: the secret of a step does not exist, is
 * of another organization or kind, or does not include the base — one code
 * (no existence leak). `send_telegram` (`telegram_bot`), `http_request`
 * (`http_header` auth, `webhook_signing`).
 */
export const SECRET_NOT_USABLE = 'SECRET_NOT_USABLE';
