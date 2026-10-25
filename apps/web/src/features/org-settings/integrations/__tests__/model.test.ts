import { describe, expect, it } from 'vitest';

import {
  addHostChips,
  allowlistPreview,
  initialSecretForm,
  isHttpSecret,
  legacyHostsState,
  legacySummary,
  rotatingUntil,
  splitHostInput,
  secretRequestOf,
  type SecretFormState,
} from '../model';

import type { SecretDto } from '@cellhive/contracts';

/** T613: the pure part of the organization's integrations page. */

const WHSEC = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;

const saved: SecretDto = {
  id: 'sec_Sign000000000001',
  organization_id: 'org_0123456789ABCDEF',
  kind: 'webhook_signing',
  name: 'Ký n8n',
  base_scope: 'selected',
  base_ids: ['bse_A000000000000001'],
  allowed_hosts: ['n8n.example.com'],
  legacy_hosts_until: null,
  previous_value_expires_at: null,
  created_by: null,
  created_at: '2026-10-18T00:00:00.000Z',
  updated_at: '2026-10-18T00:00:00.000Z',
};

function form(patch: Partial<SecretFormState>): SecretFormState {
  return { ...initialSecretForm(null), ...patch };
}

describe('isHttpSecret', () => {
  it.each([
    ['http_header', true],
    ['webhook_signing', true],
    ['telegram_bot', false],
  ] as const)('%s → %s', (kind, expected) => {
    expect(isHttpSecret({ kind })).toBe(expected);
  });
});

describe('secretRequestOf (create)', () => {
  it.each([
    [
      'a header value',
      form({ name: ' CRM ', value: 'Bearer abc', hostDraft: ' api.crm.test \n\n' }),
      {
        kind: 'http_header',
        name: 'CRM',
        base_scope: 'all',
        base_ids: [],
        allowed_hosts: ['api.crm.test'],
        value: 'Bearer abc',
      },
    ],
    [
      'a generated signing secret',
      form({
        kind: 'webhook_signing',
        name: 'n8n',
        valueMode: 'generate',
        allowedHosts: ['n8n.example.com'],
        hostDraft: '*.hooks.example:8443',
      }),
      {
        kind: 'webhook_signing',
        name: 'n8n',
        base_scope: 'all',
        base_ids: [],
        allowed_hosts: ['n8n.example.com', '*.hooks.example:8443'],
        generate: true,
      },
    ],
    [
      'a pasted signing secret for chosen bases',
      form({
        kind: 'webhook_signing',
        name: 'n8n',
        value: WHSEC,
        baseScope: 'selected',
        baseIds: ['bse_A000000000000001'],
        allowedHosts: ['n8n.example.com'],
      }),
      {
        kind: 'webhook_signing',
        name: 'n8n',
        base_scope: 'selected',
        base_ids: ['bse_A000000000000001'],
        allowed_hosts: ['n8n.example.com'],
        value: WHSEC,
      },
    ],
  ] as const)('%s', (_label, state, expected) => {
    expect(secretRequestOf(state, null)).toEqual({ ok: true, create: expected });
  });

  const hosts = { allowedHosts: ['a.test'] };
  it.each([
    ['no name', form({ value: 'x', ...hosts }), { name: 'required' }],
    ['no value', form({ name: 'x', ...hosts }), { value: 'required' }],
    [
      'a line break in a header value',
      form({ name: 'x', value: 'a\u0007b', ...hosts }),
      { value: 'format_http_header' },
    ],
    [
      'a signing secret without its prefix',
      form({ kind: 'webhook_signing', name: 'x', value: 'abc', ...hosts }),
      { value: 'format_webhook_signing' },
    ],
    [
      'chosen bases left empty',
      form({ name: 'x', value: 'v', baseScope: 'selected', ...hosts }),
      { base_ids: 'bases' },
    ],
    ['no allowed host', form({ name: 'x', value: 'v' }), { allowed_hosts: 'hosts_required' }],
    [
      'an IP address as a host',
      form({ name: 'x', value: 'v', allowedHosts: ['a.test'], hostDraft: '10.0.0.1' }),
      { allowed_hosts: 'hosts_invalid' },
    ],
    [
      'a URL instead of a host',
      form({ name: 'x', value: 'v', hostDraft: 'https://a.test/x' }),
      { allowed_hosts: 'hosts_invalid' },
    ],
    [
      'more than 20 hosts',
      form({
        name: 'x',
        value: 'v',
        allowedHosts: Array.from({ length: 20 }, (_, i) => `h${String(i)}.test`),
        hostDraft: 'h20.test',
      }),
      { allowed_hosts: 'hosts_too_many' },
    ],
  ] as const)('refuses %s', (_label, state, errors) => {
    expect(secretRequestOf(state, null)).toEqual({ ok: false, errors });
  });
});

describe('secretRequestOf (change)', () => {
  it('sends nothing when nothing changed', () => {
    expect(secretRequestOf(initialSecretForm(saved), saved)).toEqual({ ok: true, update: null });
  });

  it.each([
    ['a new name', { name: 'Ký n8n 2' }, { name: 'Ký n8n 2' }],
    ['a generated value', { valueMode: 'generate' }, { generate: true }],
    ['every base', { baseScope: 'all' }, { base_scope: 'all', base_ids: [] }],
    [
      'other allowed hosts',
      { allowedHosts: ['n8n.example.com', 'n8n2.example.com'] },
      { allowed_hosts: ['n8n.example.com', 'n8n2.example.com'] },
    ],
  ] as const)('sends only %s', (_label, patch, update) => {
    expect(secretRequestOf({ ...initialSecretForm(saved), ...patch }, saved)).toEqual({
      ok: true,
      update,
    });
  });

  it('shows the stored hosts as chips; the same hosts in another case are no change', () => {
    expect(initialSecretForm(saved).allowedHosts).toEqual(['n8n.example.com']);
    expect(
      secretRequestOf(
        { ...initialSecretForm(saved), allowedHosts: [], hostDraft: 'N8N.example.com.' },
        saved,
      ),
    ).toEqual({ ok: true, update: null });
  });

  it('cannot empty the list, but a legacy secret (no list yet) may stay without one', () => {
    expect(
      secretRequestOf({ ...initialSecretForm(saved), allowedHosts: [], hostDraft: ' ' }, saved),
    ).toEqual({
      ok: false,
      errors: { allowed_hosts: 'hosts_required' },
    });
    const legacy: SecretDto = {
      ...saved,
      allowed_hosts: [],
      legacy_hosts_until: '2026-11-18T00:00:00.000Z',
    };
    expect(secretRequestOf(initialSecretForm(legacy), legacy)).toEqual({ ok: true, update: null });
    expect(
      secretRequestOf({ ...initialSecretForm(legacy), allowedHosts: ['n8n.example.com'] }, legacy),
    ).toEqual({ ok: true, update: { allowed_hosts: ['n8n.example.com'] } });
  });
});

describe('allowlistPreview', () => {
  it.each([
    ['n8n.internal:5678', 'n8n.internal:5678'],
    ['  N8N.Internal ', 'n8n.internal'],
    ['*.Bücher.example:8443', '*.xn--bcher-kva.example:8443'],
    ['10.0.0.1', null],
    ['10.0.0.0/8', null],
    ['*.com', null],
    ['https://n8n.internal', null],
    ['', null],
  ] as const)('%j → %j', (input, pattern) => {
    expect(allowlistPreview(input)?.pattern ?? null).toBe(pattern);
  });
});

describe('rotatingUntil', () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  it.each([
    [null, null],
    ['2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z'],
    ['2026-10-18T00:00:00.000Z', null],
  ] as const)('%j → %j', (until, expected) => {
    expect(rotatingUntil({ previous_value_expires_at: until }, now)).toBe(expected);
  });
});

describe('splitHostInput (T717)', () => {
  it.each([
    ['', []],
    ['  ', []],
    ['api.crm.test', ['api.crm.test']],
    ['a.test\nb.test', ['a.test', 'b.test']],
    ['a.test, b.test;c.test  d.test', ['a.test', 'b.test', 'c.test', 'd.test']],
    ['\r\n*.hooks.example:8443\r\n', ['*.hooks.example:8443']],
  ] as const)('%j → %j', (text, parts) => {
    expect(splitHostInput(text)).toEqual(parts);
  });
});

describe('addHostChips (T717)', () => {
  const full = Array.from({ length: 20 }, (_, i) => `h${String(i)}.test`);
  it.each([
    [
      'adds the canonical form',
      [],
      ' *.CRM.test ',
      { hosts: ['*.crm.test'], added: ['*.crm.test'], duplicates: [], invalid: [], overflow: [] },
    ],
    [
      'IDN to punycode, trailing dot dropped',
      ['a.test'],
      'Bücher.example.',
      {
        hosts: ['a.test', 'xn--bcher-kva.example'],
        added: ['xn--bcher-kva.example'],
        duplicates: [],
        invalid: [],
        overflow: [],
      },
    ],
    [
      'a paste of several, with a duplicate and an IP',
      ['a.test'],
      'A.test\nb.test:8443, 10.0.0.1',
      {
        hosts: ['a.test', 'b.test:8443'],
        added: ['b.test:8443'],
        duplicates: ['a.test'],
        invalid: ['10.0.0.1'],
        overflow: [],
      },
    ],
    [
      'a URL, *.com and a CIDR',
      [],
      'https://a.test/x *.com 10.0.0.0/8',
      {
        hosts: [],
        added: [],
        duplicates: [],
        invalid: ['https://a.test/x', '*.com', '10.0.0.0/8'],
        overflow: [],
      },
    ],
    [
      'nothing past 20',
      full,
      'h20.test',
      { hosts: full, added: [], duplicates: [], invalid: [], overflow: ['h20.test'] },
    ],
  ] as const)('%s', (_label, hosts, text, expected) => {
    expect(addHostChips(hosts, text)).toEqual(expected);
  });
});

describe('legacyHostsState / legacySummary (T717)', () => {
  const now = new Date('2026-10-24T00:00:00.000Z');
  const legacy = (until: string | null) => ({
    kind: 'http_header' as const,
    allowed_hosts: [] as string[],
    legacy_hosts_until: until,
  });
  it.each([
    ['a secret with hosts', { ...legacy(null), allowed_hosts: ['a.test'] }, null],
    ['a Telegram bot', { ...legacy(null), kind: 'telegram_bot' as const }, null],
    [
      'before the deadline',
      legacy('2026-11-01T00:00:00.000Z'),
      { state: 'pending', until: '2026-11-01T00:00:00.000Z' },
    ],
    [
      'after the deadline',
      legacy('2026-10-01T00:00:00.000Z'),
      { state: 'stopped', until: '2026-10-01T00:00:00.000Z' },
    ],
    ['an empty list without a deadline', legacy(null), { state: 'stopped', until: null }],
  ] as const)('%s', (_label, secret, expected) => {
    expect(legacyHostsState(secret, now)).toEqual(expected);
  });

  it('counts pending and stopped secrets and finds the first deadline', () => {
    expect(
      legacySummary(
        [
          legacy('2026-11-20T00:00:00.000Z'),
          legacy('2026-11-02T00:00:00.000Z'),
          legacy('2026-10-02T00:00:00.000Z'),
          { ...legacy(null), allowed_hosts: ['a.test'] },
        ],
        now,
      ),
    ).toEqual({ pending: 2, stopped: 1, firstUntil: '2026-11-02T00:00:00.000Z' });
    expect(legacySummary([], now)).toEqual({ pending: 0, stopped: 0, firstUntil: null });
  });
});
