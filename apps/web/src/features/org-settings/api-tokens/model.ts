import {
  API_TOKEN_MAX_LIFETIME_DAYS,
  API_TOKEN_NAME_MAX_LENGTH,
  API_TOKEN_PREFIX,
  API_TOKEN_SCOPES,
  type ApiTokenDto,
  type ApiTokenScope,
  type ApiTokenStatus,
  type CreateApiTokenRequest,
  type Id,
  type McpPolicy,
} from '@cellhive/contracts';

/**
 * The pure part of the API tokens page (BACKLOG T714, CONTRACTS §26): scope
 * presets, expiry choices under the organization's policy, what the create
 * form sends, and how a token's status reads.
 */

const DAY_MS = 86_400_000;
/**
 * A computed expiry is this much earlier than "now + N days": the server
 * checks the policy against its own clock, which may run a little behind.
 */
const CLOCK_MARGIN_MS = 60_000;
/** Tokens expiring sooner than this get a warning. */
export const EXPIRY_WARNING_DAYS = 7;

/** Scope groups of the create form, each with a read and a write scope. */
export const SCOPE_GROUPS = [
  { key: 'records', scopes: ['records:read', 'records:write'] },
  { key: 'schema', scopes: ['schema:read', 'schema:write'] },
  { key: 'automations', scopes: ['automations:read', 'automations:write'] },
] as const satisfies readonly { key: string; scopes: readonly ApiTokenScope[] }[];

export const SCOPE_PRESETS = [
  'read',
  'readWrite',
  'schema',
  'automation',
  'mcpRead',
  'mcpReadWrite',
] as const;
export type ScopePreset = (typeof SCOPE_PRESETS)[number];

const PRESET_SCOPES: Record<ScopePreset, readonly ApiTokenScope[]> = {
  read: ['records:read', 'schema:read'],
  readWrite: ['records:read', 'records:write', 'schema:read'],
  schema: ['records:read', 'schema:read', 'schema:write'],
  // Previews, test sends and run details show record values, which need
  // `records:read` (CONTRACTS §26.2).
  automation: ['records:read', 'schema:read', 'automations:read', 'automations:write'],
  // The MCP route needs `schema:read`, the read tools `records:read`, the write
  // tools `records:write` (CONTRACTS §30). Same scopes as "read"/"readWrite":
  // the MCP ones also open the "Connect via MCP" box once created.
  mcpRead: ['records:read', 'schema:read'],
  mcpReadWrite: ['records:read', 'records:write', 'schema:read'],
};

/** A preset meant for an MCP client (T924). */
export function isMcpPreset(preset: ScopePreset | 'custom'): boolean {
  return preset === 'mcpRead' || preset === 'mcpReadWrite';
}

/**
 * The presets of the create form under the organization's MCP policy
 * (CONTRACTS §30.1): the MCP ones only while MCP is on, "read & write" only
 * while MCP may write.
 */
export function presetsFor(mcp: McpPolicy): ScopePreset[] {
  return SCOPE_PRESETS.filter((preset) =>
    preset === 'mcpRead'
      ? mcp.enabled
      : preset === 'mcpReadWrite'
        ? mcp.enabled && mcp.allow_writes
        : true,
  );
}

/**
 * i18n key of a scope's name: `records:read` → `scopes.records.read` (`:` is
 * i18next's namespace separator).
 */
export function scopeKey(scope: ApiTokenScope): `scopes.${string}` {
  return `scopes.${scope.replace(':', '.')}`;
}

/** Scopes in the order of CONTRACTS §26.2 (how the server stores them). */
export function orderedScopes(scopes: Iterable<ApiTokenScope>): ApiTokenScope[] {
  const set = new Set(scopes);
  return API_TOKEN_SCOPES.filter((scope) => set.has(scope));
}

export function scopesOfPreset(preset: ScopePreset): ApiTokenScope[] {
  return orderedScopes(PRESET_SCOPES[preset]);
}

/**
 * The preset with exactly these scopes — `preferred` when it has them (an MCP
 * preset shares its scopes with a plain one) — else `custom`.
 */
export function presetOf(
  scopes: readonly ApiTokenScope[],
  preferred?: ScopePreset,
): ScopePreset | 'custom' {
  const key = orderedScopes(scopes).join(' ');
  const matches = (preset: ScopePreset) => scopesOfPreset(preset).join(' ') === key;
  if (preferred !== undefined && matches(preferred)) return preferred;
  return SCOPE_PRESETS.find(matches) ?? 'custom';
}

// --- Expiry ------------------------------------------------------------------------------

export const EXPIRY_CHOICES = ['7', '30', '90', '365', 'custom', 'none'] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];
const DEFAULT_EXPIRY_DAYS = 90;

export interface ExpiryForm {
  readonly choice: ExpiryChoice;
  /** `YYYY-MM-DD` of the date input (choice `custom`). */
  readonly customDate: string;
}

export interface ExpiryChoiceState {
  readonly disabled: boolean;
  /** `tooLong`: more days than the policy allows; `required`: the policy rules out "never". */
  readonly reason: 'tooLong' | 'required' | null;
}

function daysOf(choice: ExpiryChoice): number | null {
  return choice === 'custom' || choice === 'none' ? null : Number(choice);
}

/** Whether the policy (`max_lifetime_days`) allows a choice, and why not. */
export function expiryChoiceState(
  choice: ExpiryChoice,
  maxLifetimeDays: number | null,
): ExpiryChoiceState {
  if (maxLifetimeDays === null) return { disabled: false, reason: null };
  if (choice === 'none') return { disabled: true, reason: 'required' };
  const days = daysOf(choice);
  if (days !== null && days > maxLifetimeDays) return { disabled: true, reason: 'tooLong' };
  return { disabled: false, reason: null };
}

/** 90 days (CONTRACTS §26.4), else the longest choice the policy allows, else a custom date. */
export function defaultExpiry(maxLifetimeDays: number | null): ExpiryChoice {
  if (maxLifetimeDays === null || maxLifetimeDays >= DEFAULT_EXPIRY_DAYS) return '90';
  const allowed = EXPIRY_CHOICES.filter((choice) => {
    const days = daysOf(choice);
    return days !== null && days <= maxLifetimeDays;
  });
  return allowed.at(-1) ?? 'custom';
}

/** `YYYY-MM-DD` of a moment in local time (what a date input shows). */
export function localDate(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The range of the custom date input: tomorrow to the longest lifetime allowed. */
export function customDateRange(
  maxLifetimeDays: number | null,
  now: Date,
): { min: string; max: string } {
  const limit = maxLifetimeDays ?? API_TOKEN_MAX_LIFETIME_DAYS;
  return {
    min: localDate(new Date(now.getTime() + DAY_MS)),
    max: localDate(new Date(now.getTime() + limit * DAY_MS - CLOCK_MARGIN_MS)),
  };
}

/**
 * `expires_at` of the form: `null` = never, `undefined` = not valid yet
 * (no or out-of-range custom date). A custom date ends at 23:59 local time,
 * capped by the policy's limit.
 */
export function expiryAt(
  expiry: ExpiryForm,
  maxLifetimeDays: number | null,
  now: Date,
): string | null | undefined {
  if (expiryChoiceState(expiry.choice, maxLifetimeDays).disabled) return undefined;
  if (expiry.choice === 'none') return null;
  const limit = maxLifetimeDays ?? API_TOKEN_MAX_LIFETIME_DAYS;
  const latest = now.getTime() + limit * DAY_MS - CLOCK_MARGIN_MS;
  const days = daysOf(expiry.choice);
  if (days !== null) return new Date(now.getTime() + days * DAY_MS - CLOCK_MARGIN_MS).toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(expiry.customDate);
  if (match === null) return undefined;
  const range = customDateRange(maxLifetimeDays, now);
  if (expiry.customDate < range.min || expiry.customDate > range.max) return undefined;
  const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 0, 0);
  return new Date(Math.min(end.getTime(), latest)).toISOString();
}

// --- Create form -------------------------------------------------------------------------

export interface CreateTokenForm {
  readonly name: string;
  readonly scopes: readonly ApiTokenScope[];
  /** `true`: every base the owner can open (`base_ids: null`). */
  readonly allBases: boolean;
  readonly baseIds: readonly Id<'bse'>[];
  readonly expiry: ExpiryForm;
}

export type CreateFormField = 'name' | 'scopes' | 'bases' | 'expiry';
export type CreateFormErrors = Partial<Record<CreateFormField, 'required' | 'invalid'>>;

export function initialCreateForm(maxLifetimeDays: number | null): CreateTokenForm {
  return {
    name: '',
    scopes: scopesOfPreset('read'),
    allBases: true,
    baseIds: [],
    expiry: { choice: defaultExpiry(maxLifetimeDays), customDate: '' },
  };
}

/** What `POST …/me/api-tokens` gets, or what to fix first. */
export function createRequestOf(
  form: CreateTokenForm,
  maxLifetimeDays: number | null,
  now: Date,
):
  | { readonly ok: true; readonly request: CreateApiTokenRequest }
  | { readonly ok: false; readonly errors: CreateFormErrors } {
  const errors: CreateFormErrors = {};
  const name = form.name.trim();
  if (name === '') errors.name = 'required';
  else if (name.length > API_TOKEN_NAME_MAX_LENGTH) errors.name = 'invalid';
  if (form.scopes.length === 0) errors.scopes = 'required';
  if (!form.allBases && form.baseIds.length === 0) errors.bases = 'required';
  const expiresAt = expiryAt(form.expiry, maxLifetimeDays, now);
  if (expiresAt === undefined) {
    errors.expiry =
      form.expiry.choice === 'custom' && form.expiry.customDate === '' ? 'required' : 'invalid';
  }
  if (Object.keys(errors).length > 0 || expiresAt === undefined) return { ok: false, errors };
  return {
    ok: true,
    request: {
      name,
      scopes: orderedScopes(form.scopes),
      base_ids: form.allBases ? null : [...new Set(form.baseIds)],
      expires_at: expiresAt,
    },
  };
}

// --- Display -----------------------------------------------------------------------------

type TokenTimes = Pick<ApiTokenDto, 'expires_at' | 'revoked_at'>;

export function tokenStatus(token: TokenTimes, now: Date): ApiTokenStatus {
  if (token.revoked_at !== null) return 'revoked';
  if (token.expires_at !== null && Date.parse(token.expires_at) <= now.getTime()) return 'expired';
  return 'active';
}

/** A token that still works but expires within 7 days, or one that has expired. */
export function tokenWarning(token: TokenTimes, now: Date): 'expiresSoon' | 'expired' | null {
  const status = tokenStatus(token, now);
  if (status === 'expired') return 'expired';
  if (
    status === 'active' &&
    token.expires_at !== null &&
    Date.parse(token.expires_at) - now.getTime() < EXPIRY_WARNING_DAYS * DAY_MS
  ) {
    return 'expiresSoon';
  }
  return null;
}

/** `cht_AbCdEfGh…`: the visible part of a token (CONTRACTS §26.1). */
export function maskedToken(prefix: string): string {
  return `${API_TOKEN_PREFIX}${prefix}…`;
}

/** The example request of the "shown once" dialog. */
export function curlExample(origin: string, token: string): string {
  return `curl -H "Authorization: Bearer ${token}" ${origin}/api/v1/me`;
}

// --- MCP (T924, CONTRACTS §30) -------------------------------------------------------------

export const MCP_CLIENTS = ['claudeCode', 'cursor', 'vscode'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

/** The MCP endpoint: `${PUBLIC_URL}/api/v1/mcp` (the web app is served from `PUBLIC_URL`). */
export function mcpUrl(origin: string): string {
  return `${origin}/api/v1/mcp`;
}

/** A token that can open the MCP endpoint (its route needs `schema:read`) and still works. */
export function canUseMcp(
  token: TokenTimes & { readonly scopes: readonly ApiTokenScope[] },
  now: Date,
): boolean {
  return token.scopes.includes('schema:read') && tokenStatus(token, now) === 'active';
}

/**
 * The configuration of a client: Claude Code's `claude mcp add` command,
 * Cursor's `mcp.json`, VS Code's `.vscode/mcp.json` — the last one asks for
 * the token in VS Code (an input), so it never holds it.
 */
export function mcpSnippet(client: McpClient, url: string, token: string): string {
  const authorization = `Bearer ${token}`;
  switch (client) {
    case 'claudeCode':
      return `claude mcp add --transport http cellhive ${url} --header "Authorization: ${authorization}"`;
    case 'cursor':
      return JSON.stringify(
        { mcpServers: { cellhive: { url, headers: { Authorization: authorization } } } },
        null,
        2,
      );
    case 'vscode':
      return JSON.stringify(
        {
          inputs: [
            {
              type: 'promptString',
              id: 'cellhive-token',
              description: 'Cellhive API token',
              password: true,
            },
          ],
          servers: {
            cellhive: {
              type: 'http',
              url,
              // VS Code fills in its input: not a template literal of this code.
              headers: { Authorization: 'Bearer ${input:cellhive-token}' },
            },
          },
        },
        null,
        2,
      );
  }
}
