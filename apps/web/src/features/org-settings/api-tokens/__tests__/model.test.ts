import { describe, expect, it } from 'vitest';

import {
  canUseMcp,
  createRequestOf,
  curlExample,
  defaultExpiry,
  expiryAt,
  expiryChoiceState,
  isMcpPreset,
  maskedToken,
  mcpSnippet,
  mcpUrl,
  presetOf,
  presetsFor,
  scopesOfPreset,
  tokenStatus,
  tokenWarning,
  type CreateTokenForm,
} from '../model';

import type { ApiTokenDto } from '@cellhive/contracts';

/** T714: the pure part of the API tokens page. */

const NOW = new Date('2026-10-24T10:00:00.000Z');
const DAY = 86_400_000;

const token: ApiTokenDto = {
  id: 'tok_0000000000000001',
  name: 'CI',
  token_prefix: 'AbCdEfGh',
  scopes: ['records:read', 'schema:read'],
  base_ids: null,
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
};

const inDays = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

describe('presets', () => {
  it.each([
    ['read', ['records:read', 'schema:read']],
    ['readWrite', ['records:read', 'records:write', 'schema:read']],
    ['schema', ['records:read', 'schema:read', 'schema:write']],
    ['automation', ['records:read', 'schema:read', 'automations:read', 'automations:write']],
  ] as const)('%s → %j', (preset, scopes) => {
    expect(scopesOfPreset(preset)).toEqual(scopes);
    expect(presetOf(scopes)).toBe(preset);
  });

  it.each([
    [['records:read'], 'custom'],
    [['schema:read', 'records:read'], 'read'],
    [[], 'custom'],
  ] as const)('presetOf(%j) = %s', (scopes, preset) => {
    expect(presetOf(scopes)).toBe(preset);
  });

  // T924: the MCP presets need what the tools need (C§30): the route
  // `schema:read`, the read tools `records:read`, the write tools `records:write`.
  it.each([
    ['mcpRead', ['records:read', 'schema:read']],
    ['mcpReadWrite', ['records:read', 'records:write', 'schema:read']],
  ] as const)('%s → %j, kept when picked', (preset, scopes) => {
    expect(scopesOfPreset(preset)).toEqual(scopes);
    expect(isMcpPreset(preset)).toBe(true);
    expect(presetOf(scopes, preset)).toBe(preset);
    // Not picked: the plain preset with the same scopes.
    expect(presetOf(scopes)).toBe(preset === 'mcpRead' ? 'read' : 'readWrite');
  });

  it.each([
    [['records:read'], 'mcpRead', 'custom'],
    [['records:read', 'schema:read', 'schema:write'], 'mcpRead', 'schema'],
  ] as const)(
    'presetOf(%j, %s) = %s: a picked preset that no longer matches',
    (scopes, picked, preset) => {
      expect(presetOf(scopes, picked)).toBe(preset);
    },
  );

  it.each([
    [{ enabled: false, allow_writes: false }, []],
    [{ enabled: false, allow_writes: true }, []],
    [{ enabled: true, allow_writes: false }, ['mcpRead']],
    [{ enabled: true, allow_writes: true }, ['mcpRead', 'mcpReadWrite']],
  ] as const)('MCP policy %j offers the MCP presets %j', (mcp, offered) => {
    expect(presetsFor(mcp)).toEqual(['read', 'readWrite', 'schema', 'automation', ...offered]);
  });

  it('only the MCP presets are MCP ones', () => {
    for (const preset of ['read', 'readWrite', 'schema', 'automation', 'custom'] as const) {
      expect(isMcpPreset(preset)).toBe(false);
    }
  });
});

describe('expiryChoiceState', () => {
  it.each([
    // [choice, max_lifetime_days, disabled reason]
    ['7', null, null],
    ['365', null, null],
    ['none', null, null],
    ['custom', null, null],
    ['7', 30, null],
    ['30', 30, null],
    ['90', 30, 'tooLong'],
    ['365', 30, 'tooLong'],
    ['none', 30, 'required'],
    ['custom', 30, null],
  ] as const)('%s with a %s-day policy → %s', (choice, max, reason) => {
    expect(expiryChoiceState(choice, max)).toEqual({ disabled: reason !== null, reason });
  });
});

describe('defaultExpiry', () => {
  it.each([
    [null, '90'],
    [365, '90'],
    [90, '90'],
    [60, '30'],
    [30, '30'],
    [10, '7'],
    [3, 'custom'],
  ] as const)('max %s → %s', (max, choice) => {
    expect(defaultExpiry(max)).toBe(choice);
  });
});

describe('expiryAt', () => {
  it('counts days from now, a minute early so the server limit holds', () => {
    expect(expiryAt({ choice: '30', customDate: '' }, null, NOW)).toBe(
      new Date(NOW.getTime() + 30 * DAY - 60_000).toISOString(),
    );
  });

  it('never expires', () => {
    expect(expiryAt({ choice: 'none', customDate: '' }, null, NOW)).toBeNull();
  });

  it('a custom date ends that day, local time, within the policy', () => {
    const at = expiryAt({ choice: 'custom', customDate: '2026-11-01' }, null, NOW);
    expect(at).toBe(new Date(2026, 10, 1, 23, 59, 0, 0).toISOString());
  });

  it('a custom date is capped by the policy', () => {
    const at = expiryAt({ choice: 'custom', customDate: '2026-11-23' }, 30, NOW);
    expect(at).toBe(new Date(NOW.getTime() + 30 * DAY - 60_000).toISOString());
  });

  it.each(['', '2026-10-23', 'nope'])('an invalid custom date %j → undefined', (date) => {
    expect(expiryAt({ choice: 'custom', customDate: date }, null, NOW)).toBeUndefined();
  });

  it('a custom date past the policy is refused', () => {
    expect(expiryAt({ choice: 'custom', customDate: '2026-12-30' }, 30, NOW)).toBeUndefined();
  });
});

describe('createRequestOf', () => {
  const form: CreateTokenForm = {
    name: '  CI  ',
    scopes: ['schema:read', 'records:read'],
    allBases: true,
    baseIds: [],
    expiry: { choice: '90', customDate: '' },
  };

  it('sends trimmed name, ordered scopes, null bases', () => {
    expect(createRequestOf(form, null, NOW)).toEqual({
      ok: true,
      request: {
        name: 'CI',
        scopes: ['records:read', 'schema:read'],
        base_ids: null,
        expires_at: new Date(NOW.getTime() + 90 * DAY - 60_000).toISOString(),
      },
    });
  });

  it.each([
    [{ name: ' ' }, 'name'],
    [{ scopes: [] }, 'scopes'],
    [{ allBases: false, baseIds: [] }, 'bases'],
    [{ expiry: { choice: 'custom', customDate: '' } }, 'expiry'],
  ] as const)('%j → error on %s', (patch, field) => {
    const result = createRequestOf({ ...form, ...patch }, null, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toContain(field);
  });

  it('refuses a disabled expiry choice', () => {
    const result = createRequestOf(
      { ...form, expiry: { choice: 'none', customDate: '' } },
      30,
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it('sends the chosen bases', () => {
    const result = createRequestOf(
      { ...form, allBases: false, baseIds: ['bse_0000000000000001'] },
      null,
      NOW,
    );
    expect(result.ok && result.request.base_ids).toEqual(['bse_0000000000000001']);
  });
});

describe('tokenStatus / tokenWarning', () => {
  it.each([
    [{}, 'active', null],
    [{ expires_at: inDays(30) }, 'active', null],
    [{ expires_at: inDays(6) }, 'active', 'expiresSoon'],
    [{ expires_at: inDays(-1) }, 'expired', 'expired'],
    [{ revoked_at: inDays(-1), expires_at: inDays(-2) }, 'revoked', null],
  ] as const)('%j → %s / %s', (patch, status, warning) => {
    const value = { ...token, ...patch };
    expect(tokenStatus(value, NOW)).toBe(status);
    expect(tokenWarning(value, NOW)).toBe(warning);
  });
});

describe('display', () => {
  it('masks the token', () => {
    expect(maskedToken('AbCdEfGh')).toBe('cht_AbCdEfGh…');
  });

  it('shows a curl example with the token', () => {
    expect(curlExample('https://ob.example', 'cht_x')).toBe(
      'curl -H "Authorization: Bearer cht_x" https://ob.example/api/v1/me',
    );
  });
});

describe('MCP (T924)', () => {
  const url = mcpUrl('https://ch.example');
  const fake = 'cht_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';

  it('the endpoint is PUBLIC_URL + /api/v1/mcp', () => {
    expect(url).toBe('https://ch.example/api/v1/mcp');
  });

  it('Claude Code: one `claude mcp add` command with the header', () => {
    expect(mcpSnippet('claudeCode', url, fake)).toBe(
      `claude mcp add --transport http cellhive https://ch.example/api/v1/mcp --header "Authorization: Bearer ${fake}"`,
    );
  });

  it('Cursor: `mcp.json` with url and headers', () => {
    expect(JSON.parse(mcpSnippet('cursor', url, fake))).toEqual({
      mcpServers: {
        cellhive: { url, headers: { Authorization: `Bearer ${fake}` } },
      },
    });
  });

  it('VS Code: an http server whose token comes from an input, never the value', () => {
    const snippet = mcpSnippet('vscode', url, fake);
    expect(snippet).not.toContain(fake);
    expect(JSON.parse(snippet)).toEqual({
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
          headers: { Authorization: 'Bearer $' + '{input:cellhive-token}' },
        },
      },
    });
  });

  it.each([
    [{}, true],
    [{ scopes: ['records:read'] }, false],
    [{ scopes: ['schema:read'] }, true],
    [{ expires_at: inDays(-1) }, false],
    [{ revoked_at: inDays(-1) }, false],
  ] as const)('canUseMcp(%j) = %s', (patch, can) => {
    expect(canUseMcp({ ...token, ...patch }, NOW)).toBe(can);
  });
});
