import {
  AI_MAX_MODEL_LENGTH,
  createHttpAllowlistEntryRequestSchema,
  isValidSecretValue,
  updateAiSettingsRequestSchema,
  type Id,
} from '@cellhive/contracts';
import {
  classifyAddress,
  DEFAULT_OUTBOUND_PORTS,
  parseOutboundUrl,
  systemHostLookup,
  type Env,
  type HostLookup,
  type OutboundUrl,
} from '@cellhive/server-core';

import { AiSettingsService } from '../modules/ai/ai-settings.service.js';
import { HttpAllowlistService } from '../modules/http-allowlist/http-allowlist.service.js';

import { SeedError } from './seed-error.js';

import type { Principal } from '../common/auth/principal.js';
import type { RequestMeta } from '../common/auth/request-meta.js';
import type { INestApplicationContext } from '@nestjs/common';

/**
 * Development-only environment of `pnpm seed:demo` (BACKLOG T917, CONTRACTS
 * §9): an OpenAI-compatible provider for the demo organization. Unset, the
 * seed configures no AI and resolves nothing.
 */
export const DEMO_AI_ENV = {
  baseUrl: 'DEMO_AI_BASE_URL',
  model: 'DEMO_AI_MODEL',
  apiKey: 'DEMO_AI_API_KEY',
} as const;

/** The provider given by `DEMO_AI_*`, checked before anything is created. */
export interface DemoAiProvider {
  readonly baseUrl: string;
  readonly model: string;
  /** Stored as the `ai_api_key` secret only: never printed, logged or audited. */
  readonly apiKey: string | null;
  readonly url: OutboundUrl;
}

/** What the AI step did, for the summary (never the key, never the full URL). */
export interface DemoAiResult {
  readonly host: string;
  readonly model: string;
  readonly keyStored: boolean;
  /** The allowlist entry added for the provider, `null` when it needs none. */
  readonly allowlist: string | null;
  readonly warnings: readonly string[];
}

export interface DemoAiInput {
  readonly organizationId: Id<'org'>;
  /** `u_admin`: organization owner. */
  readonly admin: Principal;
  readonly provider: DemoAiProvider;
  /** `HTTP_PRIVATE_ALLOWLIST`: with `off`, no entry opens a private address. */
  readonly privateAllowlist: 'org' | 'off';
  /** DNS of the provider host (default: the system resolver). Tests inject one. */
  readonly lookup?: HostLookup;
  readonly meta: () => RequestMeta;
}

const LOOKUP_TIMEOUT_MS = 5_000;

const USAGE_HINT =
  `${DEMO_AI_ENV.baseUrl} and ${DEMO_AI_ENV.model} go together; ${DEMO_AI_ENV.apiKey} is ` +
  'optional (a local provider needs none). Example: ' +
  `${DEMO_AI_ENV.baseUrl}=http://localhost:11434/v1 ${DEMO_AI_ENV.model}=qwen2.5:7b-instruct`;

const valueOf = (env: Env, key: string): string | null => {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? null : value;
};

/**
 * Names that only resolve on a private network: `localhost`, a single label
 * (`ollama`, a Compose service) and the special-use suffixes. Used only when
 * the host does not resolve from where the seed runs.
 */
export function looksInternal(host: string): boolean {
  return (
    host === 'localhost' ||
    !host.includes('.') ||
    /\.(?:localhost|local|internal|lan|home\.arpa)$/u.test(host)
  );
}

/**
 * The provider of `DEMO_AI_*`, or `null` when none is set; a `SeedError`
 * (before the seed creates anything) when the values cannot work. The URL and
 * the key are never echoed.
 */
export function demoAiProviderOf(env: Env): DemoAiProvider | null {
  const baseUrl = valueOf(env, DEMO_AI_ENV.baseUrl);
  const model = valueOf(env, DEMO_AI_ENV.model);
  const apiKey = valueOf(env, DEMO_AI_ENV.apiKey);
  if (baseUrl === null && model === null && apiKey === null) return null;
  if (baseUrl === null || model === null) throw new SeedError(USAGE_HINT);
  let url: OutboundUrl;
  try {
    // A query or fragment would end up before `/chat/completions` (CONTRACTS §29.1).
    if (/[?#]/u.test(baseUrl)) throw new Error('query or fragment');
    url = parseOutboundUrl(baseUrl);
  } catch {
    throw new SeedError(
      `${DEMO_AI_ENV.baseUrl} must be the http(s) base URL of an OpenAI-compatible API, ` +
        `without user info, query or fragment.\n${USAGE_HINT}`,
    );
  }
  if (model.length > AI_MAX_MODEL_LENGTH) {
    throw new SeedError(
      `${DEMO_AI_ENV.model} has at most ${String(AI_MAX_MODEL_LENGTH)} characters.`,
    );
  }
  if (apiKey !== null && !isValidSecretValue('ai_api_key', apiKey)) {
    throw new SeedError(
      `${DEMO_AI_ENV.apiKey} must be printable ASCII without line breaks (at most 4,096 characters).`,
    );
  }
  if (
    url.ipFamily !== 0 &&
    (apiKey !== null ||
      classifyAddress(url.host) !== 'public' ||
      !DEFAULT_OUTBOUND_PORTS.has(url.port))
  ) {
    // Allowlist entries name hosts, and a key is only ever sent to a host name (CONTRACTS §24).
    throw new SeedError(
      `${DEMO_AI_ENV.baseUrl}: use a host name (for example localhost), not an IP address — ` +
        'an HTTP allowlist entry names a host, and an API key is only sent to a host name.',
    );
  }
  return { baseUrl, model, apiKey, url };
}

/** The addresses of `host`, or `null` when it does not resolve in time. */
async function addressesOf(host: string, lookup: HostLookup): Promise<readonly string[] | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('timeout'));
        }, LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The allowlist entry the provider needs (CONTRACTS §25.4): one naming the
 * host **and** its port when the host is internal — it resolves to a
 * loopback or private address (or, when it does not resolve here, its name
 * looks internal) — or when the port is not 80/443. A public host on
 * 80/443 needs none.
 */
export async function demoAiAllowlistFor(
  provider: DemoAiProvider,
  input: Pick<DemoAiInput, 'lookup' | 'privateAllowlist'>,
): Promise<{ pattern: string | null; warnings: string[] }> {
  const { url } = provider;
  const pattern = `${url.host}:${String(url.port)}`;
  const warnings: string[] = [];
  // An IP literal was refused above unless it is public on 80/443.
  if (url.ipFamily !== 0) return { pattern: null, warnings };
  const addresses = await addressesOf(url.host, input.lookup ?? systemHostLookup);
  const classes = addresses?.map((address) => classifyAddress(address)) ?? [];
  if (classes.includes('blocked')) {
    warnings.push(
      `The AI provider host ${url.host} resolves to an address that is never reachable ` +
        '(metadata, multicast or reserved): AI calls will be blocked.',
    );
  }
  const internal =
    addresses === null ? looksInternal(url.host) : classes.some((kind) => kind === 'private');
  if (addresses === null && !internal) {
    warnings.push(
      `The AI provider host ${url.host} did not resolve: no HTTP allowlist entry added. ` +
        `If it is on your network, add ${pattern} to the HTTP allowlist of the organization.`,
    );
  }
  if (internal && input.privateAllowlist === 'off') {
    warnings.push(
      `HTTP_PRIVATE_ALLOWLIST=off: the allowlist entry ${pattern} does not open private ` +
        'addresses, so AI calls to this provider will be blocked.',
    );
  }
  return {
    pattern: internal || !DEFAULT_OUTBOUND_PORTS.has(url.port) ? pattern : null,
    warnings,
  };
}

/**
 * The AI part of `pnpm seed:demo` (BACKLOG T917, CONTRACTS §9), only when
 * `DEMO_AI_*` is set: as `u_admin` through the services behind the API —
 * same validation, events and audit as the web UI —
 *
 * - the allowlist entry `host:port` of the provider when it is internal or
 *   on another port (`HttpAllowlistService.create`, like
 *   `POST /orgs/:id/http-allowlist`);
 * - the AI settings (`AiSettingsService.update`, like
 *   `PUT /orgs/:id/ai-settings`): on, the URL and model, the key (an
 *   `ai_api_key` secret bound to the host, or none), `allow_record_data =
 *   false` — record values never leave the server until an admin turns it on.
 *
 * Only the host is resolved (DNS); the provider is never called: no
 * "Test connection" (an admin runs it in Settings › AI).
 */
export async function seedDemoAi(
  app: INestApplicationContext,
  input: DemoAiInput,
): Promise<DemoAiResult> {
  const { provider } = input;
  const { pattern, warnings } = await demoAiAllowlistFor(provider, input);
  if (pattern !== null) {
    await app
      .get(HttpAllowlistService)
      .create(
        input.admin,
        input.organizationId,
        createHttpAllowlistEntryRequestSchema.parse({ pattern }),
        input.meta(),
      );
  }
  await app.get(AiSettingsService).update(
    input.admin,
    input.organizationId,
    updateAiSettingsRequestSchema.parse({
      enabled: true,
      provider_base_url: provider.baseUrl,
      model: provider.model,
      api_key: provider.apiKey === null ? null : { value: provider.apiKey },
      allow_record_data: false,
    }),
    input.meta(),
  );
  return {
    host: provider.url.host,
    model: provider.model,
    keyStored: provider.apiKey !== null,
    allowlist: pattern,
    warnings,
  };
}
