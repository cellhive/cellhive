import {
  asciiDomain,
  CONDITIONAL_REQUIREMENTS,
  ENV_DEFAULTS,
  ENV_KEYS,
  envSchema,
  OIDC_PROVIDER_DEFAULTS,
  OIDC_PROVIDER_VARIABLES,
  oidcProviderEnvSchema,
  oidcVariableName,
  type EnvKey,
  type OidcProviderVariable,
  type ParsedEnv,
} from './env-schema.js';

import type { Cidr } from './cidr.js';

export type Mode = ParsedEnv['MODE'];
export type LogLevel = ParsedEnv['LOG_LEVEL'];

export interface S3StorageConfig {
  readonly driver: 's3';
  /** `null` = the provider's default endpoint (AWS S3). */
  readonly endpoint: string | null;
  /**
   * Endpoint that presigned URLs are signed for (reachable by browsers).
   * Defaults to `endpoint`; `null` = the provider's default endpoint.
   */
  readonly publicEndpoint: string | null;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

export interface LocalStorageConfig {
  readonly driver: 'local';
  readonly path: string;
}

/** Instance SMTP (SPEC §20, BACKLOG "Quyết định S5" #1). */
export interface MailConfig {
  /** `SMTP_URL`; carries credentials: never log or return it. */
  readonly url: string;
  /** `SMTP_FROM` as configured (`Name <address>` or `address`). */
  readonly from: string;
  /** Address part of `SMTP_FROM`. */
  readonly fromAddress: string;
  /** Display name part of `SMTP_FROM`; `null` when it has none. */
  readonly fromName: string | null;
  /**
   * `SMTP_ALLOWED_FROM_DOMAINS` (ASCII, lower case): domains a `From` other
   * than `SMTP_FROM` may use (ADR-33 `send_as`). Default: the domain of `SMTP_FROM`.
   */
  readonly allowedFromDomains: readonly string[];
  /** `SMTP_ALLOW_INSECURE`: plain SMTP without STARTTLS is accepted (development). */
  readonly allowInsecure: boolean;
}

/** Email limits (BACKLOG "Quyết định S5" #8); apply whether or not SMTP is configured. */
export interface EmailLimits {
  /** `EMAIL_MAX_PER_HOUR_PER_ORG`: messages per organization per clock hour. */
  readonly maxPerHourPerOrg: number;
  /** `EMAIL_MAX_RECIPIENTS`: to + cc + bcc of one message. */
  readonly maxRecipients: number;
  /** `SMTP_MAX_PER_SEC`: messages per second of one process (api or worker). */
  readonly maxPerSecond: number;
  /** `EMAIL_TEST_SEND_PER_MIN`: test emails per user per minute. */
  readonly testSendsPerMinute: number;
  /** `EMAIL_MAX_HTML_BYTES`: largest HTML part (UTF-8 bytes). */
  readonly maxHtmlBytes: number;
  /**
   * `SMTP_ALLOW_PRIVATE_HOSTS`: sender identity SMTP hosts may resolve to
   * private, loopback or link-local addresses (T530); cloud metadata
   * addresses stay blocked.
   */
  readonly allowPrivateSmtpHosts: boolean;
  /** `EMAIL_MAX_PER_HOUR_PER_IDENTITY`: messages per sender identity SMTP per clock hour. */
  readonly maxPerHourPerIdentity: number;
  /**
   * `EMAIL_AUTOMATION_FOOTER` (T531, ADR-33 §4): `required` forbids
   * `footer: none` in every organization; `org` leaves it to the
   * organization's `footer_policy`.
   */
  readonly automationFooter: 'required' | 'org';
  /** `EMAIL_MAX_ATTACHMENTS` (T532): files of one automation email, cap of the organization value. */
  readonly maxAttachments: number;
  /** `EMAIL_MAX_ATTACHMENT_BYTES` (T532): original bytes of those files in all, cap likewise. */
  readonly maxAttachmentBytes: number;
  /** `EMAIL_MAX_INLINE_IMAGES` (T534): inline images of one automation email, signature included. */
  readonly maxInlineImages: number;
}

/**
 * One OIDC sign-in provider (`OIDC_<SLUG>_*`, ADR-36 §3). `clientSecret`
 * is a secret: never log or return it.
 */
export interface OidcProviderConfig {
  readonly slug: string;
  /** Button label; defaults to the slug. */
  readonly name: string;
  /** Issuer identifier (discovery at `<issuer>/.well-known/openid-configuration`). */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Always contains `openid`. */
  readonly scopes: readonly string[];
  /** JIT: create an account for an unknown verified email. */
  readonly allowSignup: boolean;
  /** Domains JIT accounts may have (ASCII, lower case); `null` = any. */
  readonly allowedDomains: readonly string[] | null;
  /** Link to an existing user with the same verified email (T708). */
  readonly linkByEmail: boolean;
  /** Slug of the organization JIT accounts join as `member`; `null` = none. */
  readonly autoJoinOrg: string | null;
}

export interface AppConfig {
  readonly nodeEnv: ParsedEnv['NODE_ENV'];
  readonly mode: Mode;
  readonly port: number;
  /** Without trailing slash. */
  readonly publicUrl: string;
  readonly database: { readonly url: string; readonly poolMax: number };
  readonly cache: { readonly url: string };
  readonly storage: LocalStorageConfig | S3StorageConfig;
  readonly security: {
    /** 32 raw bytes (AES-256-GCM key for `meta.secrets`). */
    readonly appMasterKey: Buffer;
    readonly sessionSecret: string;
    readonly cookieSecure: 'auto' | boolean;
    readonly trustedProxies: readonly Cidr[];
    /** Defaults to the origin of PUBLIC_URL. */
    readonly corsOrigins: readonly string[];
  };
  /** OIDC sign-in (ADR-36 §3); no provider = password sign-in only. */
  readonly oidc: { readonly providers: readonly OidcProviderConfig[] };
  /** `null` = email disabled. */
  readonly mail: MailConfig | null;
  readonly email: EmailLimits;
  /** Outbound HTTP of automations (T600, ADR-35 §3). */
  readonly outboundHttp: {
    /**
     * `HTTP_PRIVATE_ALLOWLIST`: `org` — allowlist entries open private
     * addresses for their host; `off` — they only open another port on a
     * public host.
     */
    readonly privateAllowlist: 'org' | 'off';
  };
  /** Incoming webhooks (T602, SPEC §13.2). */
  readonly incomingWebhooks: {
    /** `WEBHOOK_MAX_RATE_PER_SEC`: highest `rate_limit_per_sec` of a hook. */
    readonly maxRatePerSec: number;
  };
  readonly defaults: {
    readonly locale: string;
    readonly timezone: string;
    readonly currency: string;
  };
  readonly allowOrgCreation: boolean;
  readonly limits: {
    readonly maxFieldsPerTable: number;
    /** `COMPUTED_FIELDS_MAX_PER_BASE`: formula and lookup fields per base (SPEC §9.5, T456). */
    readonly computedFieldsMaxPerBase: number;
    readonly auditRetentionDays: number;
    /** `NOTIFICATION_RETENTION_DAYS`: age at which notifications are deleted (ADR-29 §1, T511). */
    readonly notificationRetentionDays: number;
    /** `EXPORT_MAX_ROWS`: most rows of one table export (BACKLOG S3 decision 2). */
    readonly exportMaxRows: number;
    /** `ATTACHMENT_MAX_FILE_BYTES`: largest attachment upload (SPEC §14.2, T406). */
    readonly attachmentMaxFileBytes: number;
    readonly automationMaxRunningPerOrg: number;
    /** `AUTOMATION_MAX_RUNS_PER_BATCH`: runs per automation per `batch.id` (ADR-26 §4). */
    readonly automationMaxRunsPerBatch: number;
    /** `AUTOMATION_RUN_RETENTION_DAYS`: age at which automation runs are deleted (T518). */
    readonly automationRunRetentionDays: number;
    readonly workerConcurrency: number;
  };
  readonly logLevel: LogLevel;
  readonly metrics: { readonly token: string | null; readonly port: number | null };
  /** `null` = OpenTelemetry export disabled (no telemetry by default). */
  readonly otlpEndpoint: string | null;
}

/** A per-provider variable `OIDC_<SLUG>_<suffix>` (SPEC §20). */
export type OidcEnvVariable = `OIDC_${string}`;

export interface ConfigIssue {
  readonly variable: EnvKey | OidcEnvVariable;
  readonly message: string;
}

/** Thrown by `loadConfig`; the message names every invalid variable, never its value. */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`);
    super(
      `Invalid environment configuration (${String(issues.length)} problem${issues.length === 1 ? '' : 's'}):\n${lines.join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

/** Known variables only; empty strings count as unset (common in `.env` files). */
function normalize(env: Env): Partial<Record<EnvKey, string>> {
  const result: Partial<Record<EnvKey, string>> = {};
  for (const key of ENV_KEYS) {
    const value = env[key]?.trim();
    if (value !== undefined && value !== '') {
      result[key] = value;
    }
  }
  return result;
}

function issueRank(variable: ConfigIssue['variable']): number {
  const index = ENV_KEYS.indexOf(variable as EnvKey);
  return index === -1 ? ENV_KEYS.indexOf('OIDC_PROVIDERS') + 0.5 : index;
}

function isEnvKey(value: unknown): value is EnvKey {
  return typeof value === 'string' && (ENV_KEYS as readonly string[]).includes(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

/** `Cellhive <no-reply@example.com>` → name + address (the format SMTP_FROM is validated for). */
function parseFrom(from: string): { name: string | null; address: string } {
  const match = /^(.*)<([^<>]+)>$/.exec(from);
  if (match === null) return { name: null, address: from.trim() };
  const name = (match[1] ?? '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
  return { name: name === '' ? null : name, address: (match[2] ?? '').trim() };
}

function mailConfigOf(env: ParsedEnv): MailConfig | null {
  if (env.SMTP_URL === undefined) return null;
  // Presence is guaranteed by CONDITIONAL_REQUIREMENTS.
  const from = env.SMTP_FROM ?? '';
  const { name, address } = parseFrom(from);
  const rawDomain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  return {
    url: env.SMTP_URL,
    from,
    fromAddress: address,
    fromName: name,
    allowedFromDomains: env.SMTP_ALLOWED_FROM_DOMAINS ?? [asciiDomain(rawDomain) ?? rawDomain],
    allowInsecure: env.SMTP_ALLOW_INSECURE,
  };
}

/**
 * Validates `OIDC_<SLUG>_*` of every slug of `OIDC_PROVIDERS`. Issues name
 * the variable, never its value (client secrets).
 */
function oidcProvidersOf(
  env: Env,
  slugs: readonly string[],
  nodeEnv: ParsedEnv['NODE_ENV'] | undefined,
  report: (variable: OidcEnvVariable, message: string) => void,
): OidcProviderConfig[] {
  const providers: OidcProviderConfig[] = [];
  for (const slug of slugs) {
    const raw: Partial<Record<OidcProviderVariable, string>> = { ...OIDC_PROVIDER_DEFAULTS };
    for (const suffix of OIDC_PROVIDER_VARIABLES) {
      const value = env[oidcVariableName(slug, suffix)]?.trim();
      if (value !== undefined && value !== '') raw[suffix] = value;
    }
    const result = oidcProviderEnvSchema.safeParse(raw);
    let valid = result.success;
    if (!result.success) {
      for (const issue of result.error.issues) {
        const suffix = issue.path[0];
        if (typeof suffix === 'string') {
          report(
            oidcVariableName(slug, suffix as OidcProviderVariable) as OidcEnvVariable,
            issue.message,
          );
        }
      }
    } else if (new URL(result.data.ISSUER).protocol === 'http:' && nodeEnv !== 'development') {
      report(
        oidcVariableName(slug, 'ISSUER') as OidcEnvVariable,
        'must be an https:// URL (http:// only when NODE_ENV=development)',
      );
      valid = false;
    }
    if (!valid || !result.success) continue;
    const data = result.data;
    providers.push({
      slug,
      name: data.NAME ?? slug,
      issuer: data.ISSUER,
      clientId: data.CLIENT_ID,
      clientSecret: data.CLIENT_SECRET,
      scopes: data.SCOPES,
      allowSignup: data.ALLOW_SIGNUP,
      allowedDomains: data.ALLOWED_DOMAINS ?? null,
      linkByEmail: data.LINK_BY_EMAIL,
      autoJoinOrg: data.AUTO_JOIN_ORG ?? null,
    });
  }
  return providers;
}

function toConfig(env: ParsedEnv, oidcProviders: readonly OidcProviderConfig[]): AppConfig {
  const storage: AppConfig['storage'] =
    env.STORAGE_DRIVER === 's3'
      ? {
          driver: 's3',
          endpoint: env.S3_ENDPOINT ?? null,
          publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT ?? null,
          // Presence is guaranteed by CONDITIONAL_REQUIREMENTS.
          region: env.S3_REGION ?? '',
          bucket: env.S3_BUCKET ?? '',
          accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
          secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
        }
      : { driver: 'local', path: env.STORAGE_LOCAL_PATH };

  return {
    nodeEnv: env.NODE_ENV,
    mode: env.MODE,
    port: env.PORT,
    publicUrl: env.PUBLIC_URL,
    database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX },
    cache: { url: env.CACHE_URL },
    storage,
    security: {
      appMasterKey: env.APP_MASTER_KEY,
      sessionSecret: env.SESSION_SECRET,
      cookieSecure: env.COOKIE_SECURE,
      trustedProxies: env.TRUSTED_PROXIES,
      corsOrigins: env.CORS_ORIGINS ?? [new URL(env.PUBLIC_URL).origin],
    },
    oidc: { providers: oidcProviders },
    mail: mailConfigOf(env),
    email: {
      maxPerHourPerOrg: env.EMAIL_MAX_PER_HOUR_PER_ORG,
      maxRecipients: env.EMAIL_MAX_RECIPIENTS,
      maxPerSecond: env.SMTP_MAX_PER_SEC,
      testSendsPerMinute: env.EMAIL_TEST_SEND_PER_MIN,
      maxHtmlBytes: env.EMAIL_MAX_HTML_BYTES,
      allowPrivateSmtpHosts: env.SMTP_ALLOW_PRIVATE_HOSTS,
      maxPerHourPerIdentity: env.EMAIL_MAX_PER_HOUR_PER_IDENTITY,
      automationFooter: env.EMAIL_AUTOMATION_FOOTER,
      maxAttachments: env.EMAIL_MAX_ATTACHMENTS,
      maxAttachmentBytes: env.EMAIL_MAX_ATTACHMENT_BYTES,
      maxInlineImages: env.EMAIL_MAX_INLINE_IMAGES,
    },
    outboundHttp: { privateAllowlist: env.HTTP_PRIVATE_ALLOWLIST },
    incomingWebhooks: { maxRatePerSec: env.WEBHOOK_MAX_RATE_PER_SEC },
    defaults: {
      locale: env.DEFAULT_LOCALE,
      timezone: env.DEFAULT_TIMEZONE,
      currency: env.DEFAULT_CURRENCY,
    },
    allowOrgCreation: env.ALLOW_ORG_CREATION,
    limits: {
      maxFieldsPerTable: env.MAX_FIELDS_PER_TABLE,
      computedFieldsMaxPerBase: env.COMPUTED_FIELDS_MAX_PER_BASE,
      auditRetentionDays: env.AUDIT_RETENTION_DAYS,
      notificationRetentionDays: env.NOTIFICATION_RETENTION_DAYS,
      exportMaxRows: env.EXPORT_MAX_ROWS,
      attachmentMaxFileBytes: env.ATTACHMENT_MAX_FILE_BYTES,
      automationMaxRunningPerOrg: env.AUTOMATION_MAX_RUNNING_PER_ORG,
      automationMaxRunsPerBatch: env.AUTOMATION_MAX_RUNS_PER_BATCH,
      automationRunRetentionDays: env.AUTOMATION_RUN_RETENTION_DAYS,
      workerConcurrency: env.WORKER_CONCURRENCY,
    },
    logLevel: env.LOG_LEVEL,
    metrics: { token: env.METRICS_TOKEN ?? null, port: env.METRICS_PORT ?? null },
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
  };
}

/**
 * Validates the environment (SPEC §20) and returns a frozen, typed config.
 * Pure: reads only its argument. Throws `ConfigError` listing every missing or
 * invalid variable by name.
 */
export function loadConfig(env: Env): AppConfig {
  const raw = normalize(env);
  const withDefaults: Partial<Record<EnvKey, string>> = { ...ENV_DEFAULTS, ...raw };

  const issues: ConfigIssue[] = [];
  const seen = new Set<ConfigIssue['variable']>();
  const report = (variable: ConfigIssue['variable'], message: string): void => {
    if (!seen.has(variable)) {
      seen.add(variable);
      issues.push({ variable, message });
    }
  };

  const result = envSchema.safeParse(withDefaults);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const variable = issue.path[0];
      if (isEnvKey(variable)) {
        report(variable, issue.message);
      }
    }
  }

  for (const rule of CONDITIONAL_REQUIREMENTS) {
    if (rule.when(withDefaults)) {
      for (const variable of rule.requires) {
        if (withDefaults[variable] === undefined) {
          report(variable, `is required ${rule.reason}`);
        }
      }
    }
  }

  // Per-provider variables are read for the slugs of a valid OIDC_PROVIDERS,
  // even when other variables are invalid (every problem is reported at once).
  const slugs = envSchema.shape.OIDC_PROVIDERS.safeParse(withDefaults.OIDC_PROVIDERS).data ?? [];
  const nodeEnv = envSchema.shape.NODE_ENV.safeParse(withDefaults.NODE_ENV).data;
  const oidcProviders = oidcProvidersOf(env, slugs, nodeEnv, report);

  if (issues.length > 0 || !result.success) {
    // Stable sort: SPEC §20 order; per-provider variables right after OIDC_PROVIDERS.
    issues.sort((a, b) => issueRank(a.variable) - issueRank(b.variable));
    throw new ConfigError(issues);
  }

  return deepFreeze(toConfig(result.data, oidcProviders));
}
