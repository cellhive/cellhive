import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { ConfigError, ENV_KEYS, loadConfig, type Env } from '../../src/config/index.js';

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

/** Smallest environment that satisfies every unconditional requirement. */
const BASE: Env = {
  PUBLIC_URL: 'https://cellhive.example.com/',
  DATABASE_URL: 'postgres://cellhive:db-password-123@db:5432/cellhive',
  CACHE_URL: 'redis://valkey:6379',
  APP_MASTER_KEY: MASTER_KEY,
  SESSION_SECRET,
};

const S3: Env = {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'http://garage:3900',
  S3_REGION: 'garage',
  S3_BUCKET: 'cellhive',
  S3_ACCESS_KEY_ID: 'GK0123456789abcdef01234567',
  S3_SECRET_ACCESS_KEY: 's3-secret-value-that-must-not-leak',
};

function errorOf(env: Env): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig: rejects invalid environments and names the variables', () => {
  const cases: { name: string; env: Env; variables: string[] }[] = [
    {
      name: 'empty environment',
      env: {},
      variables: ['PUBLIC_URL', 'DATABASE_URL', 'CACHE_URL', 'APP_MASTER_KEY', 'SESSION_SECRET'],
    },
    {
      name: 'unknown EMAIL_AUTOMATION_FOOTER',
      env: { ...BASE, EMAIL_AUTOMATION_FOOTER: 'none' },
      variables: ['EMAIL_AUTOMATION_FOOTER'],
    },
    {
      name: 'unknown HTTP_PRIVATE_ALLOWLIST',
      env: { ...BASE, HTTP_PRIVATE_ALLOWLIST: 'on' },
      variables: ['HTTP_PRIVATE_ALLOWLIST'],
    },
    {
      name: 'WEBHOOK_MAX_RATE_PER_SEC of zero',
      env: { ...BASE, WEBHOOK_MAX_RATE_PER_SEC: '0' },
      variables: ['WEBHOOK_MAX_RATE_PER_SEC'],
    },
    {
      name: 'missing APP_MASTER_KEY',
      env: { ...BASE, APP_MASTER_KEY: undefined },
      variables: ['APP_MASTER_KEY'],
    },
    {
      name: 'empty APP_MASTER_KEY',
      env: { ...BASE, APP_MASTER_KEY: '' },
      variables: ['APP_MASTER_KEY'],
    },
    {
      name: 'APP_MASTER_KEY of 31 bytes',
      env: { ...BASE, APP_MASTER_KEY: Buffer.alloc(31, 1).toString('base64') },
      variables: ['APP_MASTER_KEY'],
    },
    {
      name: 'APP_MASTER_KEY of 33 bytes',
      env: { ...BASE, APP_MASTER_KEY: Buffer.alloc(33, 1).toString('base64') },
      variables: ['APP_MASTER_KEY'],
    },
    {
      name: 'APP_MASTER_KEY not base64',
      env: { ...BASE, APP_MASTER_KEY: `${'!'.repeat(43)}=` },
      variables: ['APP_MASTER_KEY'],
    },
    {
      name: 'SESSION_SECRET of 31 bytes',
      env: { ...BASE, SESSION_SECRET: 'x'.repeat(31) },
      variables: ['SESSION_SECRET'],
    },
    {
      name: 'STORAGE_DRIVER=s3 without S3_BUCKET',
      env: { ...BASE, ...S3, S3_BUCKET: undefined },
      variables: ['S3_BUCKET'],
    },
    {
      name: 'STORAGE_DRIVER=s3 without credentials',
      env: { ...BASE, ...S3, S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: undefined },
      variables: ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
    },
    {
      name: 'STORAGE_DRIVER=s3 without S3_REGION',
      env: { ...BASE, ...S3, S3_REGION: undefined },
      variables: ['S3_REGION'],
    },
    {
      name: 'unknown STORAGE_DRIVER',
      env: { ...BASE, STORAGE_DRIVER: 'minio' },
      variables: ['STORAGE_DRIVER'],
    },
    { name: 'unknown MODE', env: { ...BASE, MODE: 'web' }, variables: ['MODE'] },
    {
      name: 'unknown COOKIE_SECURE',
      env: { ...BASE, COOKIE_SECURE: 'yes' },
      variables: ['COOKIE_SECURE'],
    },
    {
      name: 'invalid CIDR in TRUSTED_PROXIES',
      env: { ...BASE, TRUSTED_PROXIES: '10.0.0.0/8, 10.0.0.0/33' },
      variables: ['TRUSTED_PROXIES'],
    },
    {
      name: 'hostname in TRUSTED_PROXIES',
      env: { ...BASE, TRUSTED_PROXIES: 'proxy.local' },
      variables: ['TRUSTED_PROXIES'],
    },
    {
      name: 'CORS origin with path',
      env: { ...BASE, CORS_ORIGINS: 'https://a.example.com,https://b.example.com/app' },
      variables: ['CORS_ORIGINS'],
    },
    {
      name: 'wrong DATABASE_URL scheme',
      env: { ...BASE, DATABASE_URL: 'mysql://db/cellhive' },
      variables: ['DATABASE_URL'],
    },
    {
      name: 'wrong CACHE_URL scheme',
      env: { ...BASE, CACHE_URL: 'http://valkey:6379' },
      variables: ['CACHE_URL'],
    },
    { name: 'PORT out of range', env: { ...BASE, PORT: '70000' }, variables: ['PORT'] },
    {
      name: 'non-integer DATABASE_POOL_MAX',
      env: { ...BASE, DATABASE_POOL_MAX: '2.5' },
      variables: ['DATABASE_POOL_MAX'],
    },
    {
      name: 'ALLOW_ORG_CREATION not a boolean',
      env: { ...BASE, ALLOW_ORG_CREATION: '1' },
      variables: ['ALLOW_ORG_CREATION'],
    },
    {
      name: 'SMTP_URL without SMTP_FROM',
      env: { ...BASE, SMTP_URL: 'smtp://mail:25' },
      variables: ['SMTP_FROM'],
    },
    {
      name: 'unknown time zone',
      env: { ...BASE, DEFAULT_TIMEZONE: 'Mars/Olympus' },
      variables: ['DEFAULT_TIMEZONE'],
    },
    {
      name: 'lower-case currency',
      env: { ...BASE, DEFAULT_CURRENCY: 'vnd' },
      variables: ['DEFAULT_CURRENCY'],
    },
    {
      name: 'MAX_FIELDS_PER_TABLE above the hard cap of 1000 (SPEC §5.4)',
      env: { ...BASE, MAX_FIELDS_PER_TABLE: '1001' },
      variables: ['MAX_FIELDS_PER_TABLE'],
    },
    {
      name: 'short METRICS_TOKEN',
      env: { ...BASE, METRICS_TOKEN: 'short' },
      variables: ['METRICS_TOKEN'],
    },
  ];

  it.each(cases)('$name', ({ env, variables }) => {
    const error = errorOf(env);
    expect(error.issues.map((issue) => issue.variable)).toEqual(variables);
    for (const variable of variables) {
      expect(error.message).toContain(`${variable}:`);
    }
  });

  it('reports every problem at once, in SPEC §20 order', () => {
    const error = errorOf({ ...S3, S3_BUCKET: undefined, MODE: 'web', PORT: 'x' });
    expect(error.issues.map((issue) => issue.variable)).toEqual([
      'MODE',
      'PORT',
      'PUBLIC_URL',
      'DATABASE_URL',
      'CACHE_URL',
      'S3_BUCKET',
      'APP_MASTER_KEY',
      'SESSION_SECRET',
    ]);
  });
});

describe('loadConfig: never prints secret values', () => {
  const secrets: { name: string; env: Env; secret: string }[] = [
    {
      name: 'short APP_MASTER_KEY',
      env: { ...BASE, APP_MASTER_KEY: 'c2hvcnQtbWFzdGVyLWtleQ==' },
      secret: 'c2hvcnQtbWFzdGVyLWtleQ==',
    },
    {
      name: 'short SESSION_SECRET',
      env: { ...BASE, SESSION_SECRET: 'tiny-session-secret' },
      secret: 'tiny-session-secret',
    },
    {
      name: 'short METRICS_TOKEN',
      env: { ...BASE, METRICS_TOKEN: 'tiny-metrics-token' },
      secret: 'tiny-metrics-token',
    },
    {
      name: 'password in bad DATABASE_URL',
      env: { ...BASE, DATABASE_URL: 'mysql://u:hunter2-db-pass@db/x' },
      secret: 'hunter2-db-pass',
    },
    {
      name: 'password in bad CACHE_URL',
      env: { ...BASE, CACHE_URL: 'http://:hunter2-cache-pass@valkey' },
      secret: 'hunter2-cache-pass',
    },
    {
      name: 'password in bad SMTP_URL',
      env: { ...BASE, SMTP_URL: 'http://u:hunter2-smtp-pass@mail' },
      secret: 'hunter2-smtp-pass',
    },
    {
      name: 'S3 secret with missing bucket',
      env: { ...BASE, ...S3, S3_BUCKET: undefined },
      secret: 's3-secret-value-that-must-not-leak',
    },
    {
      name: 'valid secrets next to an invalid variable',
      env: { ...BASE, PORT: 'nope' },
      secret: SESSION_SECRET,
    },
  ];

  it.each(secrets)('$name', ({ env, secret }) => {
    const error = errorOf(env);
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.issues)).not.toContain(secret);
  });
});

describe('loadConfig: defaults and parsing', () => {
  it('applies SPEC §20 defaults', () => {
    const config = loadConfig(BASE);
    expect(config).toMatchObject({
      nodeEnv: 'production',
      mode: 'api',
      port: 3000,
      publicUrl: 'https://cellhive.example.com',
      database: { poolMax: 10 },
      storage: { driver: 'local', path: '/data/files' },
      security: {
        cookieSecure: 'auto',
        corsOrigins: ['https://cellhive.example.com'],
      },
      mail: null,
      defaults: { locale: 'en', timezone: 'UTC', currency: 'USD' },
      allowOrgCreation: false,
      limits: {
        maxFieldsPerTable: 500,
        auditRetentionDays: 365,
        notificationRetentionDays: 90,
        exportMaxRows: 1_000_000,
        attachmentMaxFileBytes: 104_857_600,
        automationMaxRunningPerOrg: 5,
        workerConcurrency: 5,
        aiConcurrency: 2,
      },
      logLevel: 'info',
      metrics: { token: null, port: null },
      otlpEndpoint: null,
      // T600: organization allowlists may open private addresses unless set to `off`.
      outboundHttp: { privateAllowlist: 'org' },
      // T602: highest `rate_limit_per_sec` of an incoming webhook.
      incomingWebhooks: { maxRatePerSec: 50 },
    });
    expect(
      loadConfig({ ...BASE, WEBHOOK_MAX_RATE_PER_SEC: '8' }).incomingWebhooks.maxRatePerSec,
    ).toBe(8);
    expect(loadConfig({ ...BASE, HTTP_PRIVATE_ALLOWLIST: 'off' }).outboundHttp).toEqual({
      privateAllowlist: 'off',
    });
    expect(config.security.trustedProxies).toEqual([
      { address: '127.0.0.0', prefix: 8, family: 4 },
      { address: '::1', prefix: 128, family: 6 },
      { address: '172.16.0.0', prefix: 12, family: 4 },
    ]);
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig({
      ...BASE,
      PORT: '',
      CORS_ORIGINS: '',
      SMTP_URL: '',
      LOG_LEVEL: ' ',
    });
    expect(config.port).toBe(3000);
    expect(config.security.corsOrigins).toEqual(['https://cellhive.example.com']);
    expect(config.mail).toBeNull();
    expect(config.logLevel).toBe('info');
  });

  it('decodes APP_MASTER_KEY to 32 bytes', () => {
    const config = loadConfig(BASE);
    expect(config.security.appMasterKey).toHaveLength(32);
    expect(config.security.appMasterKey.equals(Buffer.alloc(32, 7))).toBe(true);
  });

  it('builds the S3 storage config with path style by default', () => {
    const config = loadConfig({ ...BASE, ...S3 });
    expect(config.storage).toEqual({
      driver: 's3',
      endpoint: 'http://garage:3900',
      publicEndpoint: 'http://garage:3900',
      region: 'garage',
      bucket: 'cellhive',
      accessKeyId: 'GK0123456789abcdef01234567',
      secretAccessKey: 's3-secret-value-that-must-not-leak',
      forcePathStyle: true,
    });
  });

  it('uses S3_PUBLIC_ENDPOINT for presigned URLs when set', () => {
    const config = loadConfig({ ...BASE, ...S3, S3_PUBLIC_ENDPOINT: 'https://files.example.com' });
    expect(config.storage).toMatchObject({
      endpoint: 'http://garage:3900',
      publicEndpoint: 'https://files.example.com',
    });
  });

  it('rejects an S3_PUBLIC_ENDPOINT that is not an http(s) URL', () => {
    expect(errorOf({ ...BASE, ...S3, S3_PUBLIC_ENDPOINT: 'files.example.com' }).issues).toEqual([
      { variable: 'S3_PUBLIC_ENDPOINT', message: 'must be a valid http:// or https:// URL' },
    ]);
  });

  const lists: { name: string; env: Env; expected: Partial<Record<string, unknown>> }[] = [
    {
      name: 'CORS_ORIGINS comma list, trimmed and normalised to origins',
      env: { CORS_ORIGINS: ' https://a.example.com , http://localhost:5173/ ,' },
      expected: { corsOrigins: ['https://a.example.com', 'http://localhost:5173'] },
    },
    {
      name: 'TRUSTED_PROXIES with bare addresses and IPv6',
      env: { TRUSTED_PROXIES: '10.0.0.1, fd00::/8 ,2001:DB8::1' },
      expected: {
        trustedProxies: [
          { address: '10.0.0.1', prefix: 32, family: 4 },
          { address: 'fd00::', prefix: 8, family: 6 },
          { address: '2001:db8::1', prefix: 128, family: 6 },
        ],
      },
    },
    {
      name: 'COOKIE_SECURE=true',
      env: { COOKIE_SECURE: 'true' },
      expected: { cookieSecure: true },
    },
    {
      name: 'COOKIE_SECURE=false',
      env: { COOKIE_SECURE: 'false' },
      expected: { cookieSecure: false },
    },
  ];

  it.each(lists)('$name', ({ env, expected }) => {
    expect(loadConfig({ ...BASE, ...env }).security).toMatchObject(expected);
  });

  it('accepts every MODE value', () => {
    for (const mode of ['api', 'worker', 'all', 'migrate'] as const) {
      expect(loadConfig({ ...BASE, MODE: mode }).mode).toBe(mode);
    }
  });

  it('enables mail when SMTP_URL and SMTP_FROM are set', () => {
    const config = loadConfig({
      ...BASE,
      SMTP_URL: 'smtps://user:pass@mail.example.com:465',
      SMTP_FROM: 'Cellhive <no-reply@example.com>',
    });
    expect(config.mail).toEqual({
      url: 'smtps://user:pass@mail.example.com:465',
      from: 'Cellhive <no-reply@example.com>',
      fromAddress: 'no-reply@example.com',
      fromName: 'Cellhive',
      allowedFromDomains: ['example.com'],
      allowInsecure: false,
    });
  });

  it('reads the email settings of T513', () => {
    const config = loadConfig({
      ...BASE,
      SMTP_URL: 'smtp://mail.example.com:587',
      SMTP_FROM: '"Acme Mail" <No-Reply@Example.COM>',
      SMTP_ALLOWED_FROM_DOMAINS: 'corp.example, Bücher.example ,corp.example',
      SMTP_ALLOW_INSECURE: 'true',
      EMAIL_MAX_PER_HOUR_PER_ORG: '20',
      EMAIL_MAX_RECIPIENTS: '500',
      SMTP_MAX_PER_SEC: '2',
      EMAIL_TEST_SEND_PER_MIN: '1',
      EMAIL_MAX_HTML_BYTES: '1024',
      SMTP_ALLOW_PRIVATE_HOSTS: 'true',
      EMAIL_MAX_PER_HOUR_PER_IDENTITY: '30',
      EMAIL_AUTOMATION_FOOTER: 'org',
      EMAIL_MAX_ATTACHMENTS: '20',
      EMAIL_MAX_ATTACHMENT_BYTES: '31457280',
      EMAIL_MAX_INLINE_IMAGES: '8',
    });
    expect(config.mail).toMatchObject({
      fromAddress: 'No-Reply@Example.COM',
      fromName: 'Acme Mail',
      allowedFromDomains: ['corp.example', 'xn--bcher-kva.example'],
      allowInsecure: true,
    });
    expect(config.email).toEqual({
      maxPerHourPerOrg: 20,
      maxRecipients: 500,
      maxPerSecond: 2,
      testSendsPerMinute: 1,
      maxHtmlBytes: 1024,
      allowPrivateSmtpHosts: true,
      maxPerHourPerIdentity: 30,
      automationFooter: 'org',
      maxAttachments: 20,
      maxAttachmentBytes: 31_457_280,
      maxInlineImages: 8,
    });
  });

  it('defaults the email limits (BACKLOG Quyết định S5 #8)', () => {
    expect(loadConfig(BASE).email).toEqual({
      maxPerHourPerOrg: 500,
      maxRecipients: 50,
      maxPerSecond: 5,
      testSendsPerMinute: 5,
      maxHtmlBytes: 102_400,
      allowPrivateSmtpHosts: false,
      maxPerHourPerIdentity: 100,
      automationFooter: 'required',
      maxAttachments: 10,
      maxAttachmentBytes: 15 * 1024 * 1024,
      maxInlineImages: 5,
    });
  });

  it.each([
    ['SMTP_URL', 'smtp://mail.example.com/?ignoreTLS=true'],
    ['SMTP_URL', 'smtp://mail.example.com/path'],
    ['SMTP_ALLOWED_FROM_DOMAINS', 'example.com,not a domain'],
    ['SMTP_ALLOWED_FROM_DOMAINS', 'localhost'],
    ['SMTP_ALLOW_INSECURE', 'yes'],
    ['EMAIL_MAX_RECIPIENTS', '501'],
    ['EMAIL_MAX_PER_HOUR_PER_ORG', '0'],
    ['EMAIL_MAX_HTML_BYTES', '100'],
    ['EMAIL_MAX_ATTACHMENTS', '21'],
    ['EMAIL_MAX_ATTACHMENTS', '0'],
    ['EMAIL_MAX_ATTACHMENT_BYTES', '31457281'],
    ['EMAIL_MAX_ATTACHMENT_BYTES', '1000'],
  ])('rejects %s=%s', (variable, value) => {
    const error = errorOf({
      ...BASE,
      SMTP_FROM: 'a@example.com',
      [variable]: value,
    });
    expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
  });

  it('returns a deeply frozen object', () => {
    const config = loadConfig(BASE);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.security)).toBe(true);
    expect(Object.isFrozen(config.security.trustedProxies)).toBe(true);
    expect(Object.isFrozen(config.security.trustedProxies[0])).toBe(true);
  });

  it('ignores variables outside SPEC §20', () => {
    expect(() => loadConfig({ ...BASE, PATH: '/usr/bin', HOME: '/root' })).not.toThrow();
    expect(ENV_KEYS).not.toContain('PATH');
  });
});

describe('loadConfig: OIDC providers (ADR-36 §3, SPEC §20)', () => {
  const CLIENT_SECRET = 'oidc-client-secret-that-must-not-leak';
  const KEYCLOAK: Env = {
    OIDC_PROVIDERS: 'keycloak',
    OIDC_KEYCLOAK_ISSUER: 'https://sso.example.com/realms/acme',
    OIDC_KEYCLOAK_CLIENT_ID: 'cellhive',
    OIDC_KEYCLOAK_CLIENT_SECRET: CLIENT_SECRET,
  };
  const elevenSlugs = Array.from({ length: 11 }, (_, i) => `p${String(i)}`).join(',');

  it('has no provider by default', () => {
    expect(loadConfig(BASE).oidc).toEqual({ providers: [] });
  });

  it('reads a provider with the per-provider defaults', () => {
    expect(loadConfig({ ...BASE, ...KEYCLOAK }).oidc.providers).toEqual([
      {
        slug: 'keycloak',
        name: 'keycloak',
        issuer: 'https://sso.example.com/realms/acme',
        clientId: 'cellhive',
        clientSecret: CLIENT_SECRET,
        scopes: ['openid', 'email', 'profile'],
        allowSignup: false,
        allowedDomains: null,
        linkByEmail: false,
        autoJoinOrg: null,
      },
    ]);
  });

  it('reads every variable; "-" in a slug maps to "_"', () => {
    const config = loadConfig({
      ...BASE,
      ...KEYCLOAK,
      OIDC_PROVIDERS: 'keycloak, my-entra',
      OIDC_MY_ENTRA_ISSUER: 'https://login.example.net/tenant/v2.0',
      OIDC_MY_ENTRA_CLIENT_ID: 'cid',
      OIDC_MY_ENTRA_CLIENT_SECRET: 'csecret',
      OIDC_MY_ENTRA_NAME: 'Microsoft',
      OIDC_MY_ENTRA_SCOPES: 'openid email,offline_access email',
      OIDC_MY_ENTRA_ALLOW_SIGNUP: 'true',
      OIDC_MY_ENTRA_ALLOWED_DOMAINS: 'Example.COM, bücher.example',
      OIDC_MY_ENTRA_LINK_BY_EMAIL: 'true',
      OIDC_MY_ENTRA_AUTO_JOIN_ORG: 'acme',
    });
    expect(config.oidc.providers.map((provider) => provider.slug)).toEqual([
      'keycloak',
      'my-entra',
    ]);
    expect(config.oidc.providers[1]).toEqual({
      slug: 'my-entra',
      name: 'Microsoft',
      issuer: 'https://login.example.net/tenant/v2.0',
      clientId: 'cid',
      clientSecret: 'csecret',
      scopes: ['openid', 'email', 'offline_access'],
      allowSignup: true,
      allowedDomains: ['example.com', 'xn--bcher-kva.example'],
      linkByEmail: true,
      autoJoinOrg: 'acme',
    });
  });

  it.each([
    ['OIDC_PROVIDERS', { OIDC_PROVIDERS: 'Key_Cloak' }],
    ['OIDC_PROVIDERS', { OIDC_PROVIDERS: 'a,a' }],
    ['OIDC_PROVIDERS', { OIDC_PROVIDERS: elevenSlugs }],
    ['OIDC_KEYCLOAK_ISSUER', { ...KEYCLOAK, OIDC_KEYCLOAK_ISSUER: undefined }],
    ['OIDC_KEYCLOAK_ISSUER', { ...KEYCLOAK, OIDC_KEYCLOAK_ISSUER: 'not a url' }],
    ['OIDC_KEYCLOAK_ISSUER', { ...KEYCLOAK, OIDC_KEYCLOAK_ISSUER: 'http://sso.example.com' }],
    ['OIDC_KEYCLOAK_ISSUER', { ...KEYCLOAK, OIDC_KEYCLOAK_ISSUER: 'https://sso.example.com/?x=1' }],
    ['OIDC_KEYCLOAK_ISSUER', { ...KEYCLOAK, OIDC_KEYCLOAK_ISSUER: 'https://u:p@sso.example.com' }],
    ['OIDC_KEYCLOAK_CLIENT_ID', { ...KEYCLOAK, OIDC_KEYCLOAK_CLIENT_ID: '' }],
    ['OIDC_KEYCLOAK_CLIENT_SECRET', { ...KEYCLOAK, OIDC_KEYCLOAK_CLIENT_SECRET: undefined }],
    ['OIDC_KEYCLOAK_SCOPES', { ...KEYCLOAK, OIDC_KEYCLOAK_SCOPES: 'email profile' }],
    ['OIDC_KEYCLOAK_ALLOW_SIGNUP', { ...KEYCLOAK, OIDC_KEYCLOAK_ALLOW_SIGNUP: 'yes' }],
    ['OIDC_KEYCLOAK_ALLOWED_DOMAINS', { ...KEYCLOAK, OIDC_KEYCLOAK_ALLOWED_DOMAINS: 'localhost' }],
    ['OIDC_KEYCLOAK_LINK_BY_EMAIL', { ...KEYCLOAK, OIDC_KEYCLOAK_LINK_BY_EMAIL: '1' }],
    ['OIDC_KEYCLOAK_AUTO_JOIN_ORG', { ...KEYCLOAK, OIDC_KEYCLOAK_AUTO_JOIN_ORG: 'Acme Inc' }],
  ] as const)('rejects an invalid %s', (variable, env) => {
    const error = errorOf({ ...BASE, ...env });
    expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
    expect(error.message).not.toContain(CLIENT_SECRET);
  });

  it('accepts an http:// issuer only when NODE_ENV=development', () => {
    const env = { ...BASE, ...KEYCLOAK, OIDC_KEYCLOAK_ISSUER: 'http://127.0.0.1:8080/realm' };
    expect(errorOf({ ...env, NODE_ENV: 'test' }).issues[0]?.message).toMatch(/https/);
    expect(loadConfig({ ...env, NODE_ENV: 'development' }).oidc.providers[0]?.issuer).toBe(
      'http://127.0.0.1:8080/realm',
    );
  });

  it('lists provider problems right after OIDC_PROVIDERS, without values', () => {
    const error = errorOf({
      ...BASE,
      PORT: '0',
      OIDC_PROVIDERS: 'keycloak',
      OIDC_KEYCLOAK_CLIENT_SECRET: CLIENT_SECRET,
      LOG_LEVEL: 'loud',
    });
    expect(error.issues.map((issue) => issue.variable)).toEqual([
      'PORT',
      'OIDC_KEYCLOAK_ISSUER',
      'OIDC_KEYCLOAK_CLIENT_ID',
      'LOG_LEVEL',
    ]);
    expect(error.message).not.toContain(CLIENT_SECRET);
  });

  it('ignores OIDC_<SLUG>_* of slugs that are not listed', () => {
    expect(loadConfig({ ...BASE, OIDC_OTHER_ISSUER: 'nope' }).oidc.providers).toEqual([]);
  });
});
