import { DEFAULT_SHARE_LINK_SETTINGS, type ShareLinkDto } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  createBody,
  embedBlockedBy,
  flagPatch,
  initialDraft,
  mergeSettings,
  settingKeys,
  linkFileFields,
  updateBody,
  validateDraft,
  widensAudience,
  type ShareDraft,
} from '../draft';
import {
  blockedLinkFilters,
  fromLocalInput,
  maskedUrl,
  publicBlockedBy,
  targetTypeOf,
  toLocalInput,
} from '../policy';

const LINK: ShareLinkDto = {
  id: 'shl_Link000000000001',
  base_id: 'bse_Base000000000001',
  table_id: 'tbl_Table00000000001',
  target_type: 'view',
  target_id: 'viw_View000000000001',
  target_name: 'Open orders',
  audience: 'org',
  status: 'active',
  token_prefix: 'Ab3xY_',
  has_password: false,
  expires_at: null,
  enabled: true,
  settings: DEFAULT_SHARE_LINK_SETTINGS,
  created_by: { id: 'usr_User000000000001', name: 'An' },
  last_accessed_at: null,
  access_count: 0,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
};

const NOW = new Date('2026-09-24T10:00:00.000Z');
const future = toLocalInput('2026-10-01T10:00:00.000Z');

describe('share policy helpers', () => {
  it.each([
    ['grid', 'view'],
    ['kanban', 'view'],
    ['form', 'form'],
  ] as const)('a %s view makes a %s link', (viewType, target) => {
    expect(targetTypeOf(viewType)).toBe(target);
  });

  it.each([
    [undefined, 'view', null],
    ['allowed', 'view', null],
    ['allowed', 'form', null],
    ['forms_only', 'form', null],
    ['forms_only', 'view', 'forms_only'],
    ['disabled', 'form', 'disabled'],
    ['disabled', 'view', 'disabled'],
  ] as const)('policy %s, %s link: public blocked by %s', (policy, target, expected) => {
    expect(publicBlockedBy(policy, target)).toBe(expected);
  });

  it.each([
    ['allowed', null],
    [
      'forms_only',
      {
        count: { audience: 'public', enabled: true },
        minus: { audience: 'public', enabled: true, target_type: 'form' },
      },
    ],
    ['disabled', { count: { audience: 'public', enabled: true } }],
  ] as const)('links blocked by %s', (policy, filters) => {
    expect(blockedLinkFilters(policy)).toEqual(filters);
  });

  it('round-trips datetime-local values at minute precision', () => {
    expect(toLocalInput(null)).toBe('');
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('not a date')).toBeNull();
    const iso = '2026-10-01T10:30:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
  });

  it('masks a link whose token is gone', () => {
    expect(maskedUrl('https://ob.example', 'Ab3xY_')).toBe('https://ob.example/s/Ab3xY_…');
  });
});

describe('share dialog draft', () => {
  const draft = (patch: Partial<ShareDraft> = {}): ShareDraft => ({ ...initialDraft(), ...patch });

  it('starts a new link for the organization with the contract defaults', () => {
    expect(initialDraft()).toEqual({
      audience: 'org',
      requirePassword: false,
      password: '',
      expires: false,
      expiresAt: '',
      settings: {
        allow_copy: false,
        allow_download: false,
        allow_export: false,
        allow_search: true,
        allow_viewer_filter_sort: true,
        show_record_detail: true,
        allow_filter_controls: true,
        tv_mode: false,
      },
      refreshSeconds: 60,
    });
  });

  it.each([
    ['no password, no expiry', {}, false, {}],
    [
      'password too short',
      { requirePassword: true, password: '12345' },
      false,
      { password: 'tooShort' },
    ],
    ['new link needs a password', { requirePassword: true }, false, { password: 'tooShort' }],
    ['existing password kept', { requirePassword: true }, true, {}],
    [
      'changed password too short',
      { requirePassword: true, password: 'abc' },
      true,
      { password: 'tooShort' },
    ],
    ['password ok', { requirePassword: true, password: '123456' }, false, {}],
    ['expiry missing', { expires: true, expiresAt: '' }, false, { expiresAt: 'past' }],
    [
      'expiry in the past',
      { expires: true, expiresAt: toLocalInput('2026-09-01T00:00:00.000Z') },
      false,
      { expiresAt: 'past' },
    ],
    ['expiry in the future', { expires: true, expiresAt: future }, false, {}],
  ] as const)('validates: %s', (_name, patch, hasPassword, errors) => {
    expect(validateDraft(draft(patch), hasPassword, NOW)).toEqual(errors);
  });

  it('create body: audience, password, expiry; settings only for views', () => {
    const value = draft({
      audience: 'public',
      requirePassword: true,
      password: 'secret-1',
      expires: true,
      expiresAt: future,
    });
    expect(createBody(value, 'view')).toEqual({
      audience: 'public',
      password: 'secret-1',
      expires_at: '2026-10-01T10:00:00.000Z',
      settings: {
        allow_copy: false,
        allow_download: false,
        allow_export: false,
        allow_search: true,
        allow_viewer_filter_sort: true,
        show_record_detail: true,
      },
    });
    expect(createBody(draft(), 'form')).toEqual({ audience: 'org' });
    expect(
      createBody(
        draft({ settings: { ...initialDraft().settings, tv_mode: true }, refreshSeconds: 300 }),
        'dashboard',
      ),
    ).toEqual({
      audience: 'org',
      settings: {
        allow_export: false,
        dashboard: { allow_filter_controls: true, tv_mode: true, refresh_seconds: 300 },
      },
    });
  });

  it.each([
    ['nothing changed', {}, LINK, null],
    ['audience', { audience: 'public' }, LINK, { audience: 'public' }],
    [
      'remove password',
      { requirePassword: false },
      { ...LINK, has_password: true },
      { password: null },
    ],
    [
      'keep password',
      { requirePassword: true, password: '' },
      { ...LINK, has_password: true },
      null,
    ],
    [
      'new password',
      { requirePassword: true, password: 'secret-2' },
      { ...LINK, has_password: true },
      { password: 'secret-2' },
    ],
    [
      'set expiry',
      { expires: true, expiresAt: future },
      LINK,
      { expires_at: '2026-10-01T10:00:00.000Z' },
    ],
    [
      'remove expiry',
      { expires: false },
      { ...LINK, expires_at: '2026-10-01T10:00:00.000Z' },
      { expires_at: null },
    ],
    [
      'one setting',
      { settings: { ...initialDraft().settings, allow_copy: true } },
      LINK,
      { settings: { allow_copy: true } },
    ],
  ] as const)('update body: %s', (_name, patch, link, body) => {
    const base = initialDraft(link);
    expect(updateBody({ ...base, ...patch }, link, 'view')).toEqual(body);
  });

  it('never sends settings for a form link', () => {
    const value = {
      ...initialDraft(LINK),
      settings: { ...initialDraft().settings, allow_copy: true },
    };
    expect(updateBody(value, { ...LINK, target_type: 'form' }, 'form')).toBeNull();
  });

  it.each([
    [
      'filters off',
      { allow_filter_controls: false },
      60,
      { dashboard: { allow_filter_controls: false } },
    ],
    ['refresh', {}, 900, { dashboard: { refresh_seconds: 900 } }],
    [
      'tv and refresh',
      { tv_mode: true },
      30,
      { dashboard: { tv_mode: true, refresh_seconds: 30 } },
    ],
    ['widget csv', { allow_export: true }, 60, { allow_export: true }],
  ] as const)('dashboard update body: %s', (_name, flags, refreshSeconds, settings) => {
    const link = { ...LINK, target_type: 'dashboard' as const };
    const base = initialDraft(link);
    expect(
      updateBody(
        { ...base, settings: { ...base.settings, ...flags }, refreshSeconds },
        link,
        'dashboard',
      ),
    ).toEqual({ settings });
  });

  it.each([
    ['public, no password', { audience: 'public', has_password: false }, null],
    ['organization', { audience: 'org', has_password: false }, 'audience'],
    ['password', { audience: 'public', has_password: true }, 'password'],
  ] as const)('embedding a link: %s', (_name, link, blocked) => {
    expect(embedBlockedBy(link)).toBe(blocked);
  });

  it.each([
    ['back to the organization', { audience: 'org' }, { audience: 'org' }],
    ['a password', { requirePassword: true, password: 'secret-9' }, { password: 'secret-9' }],
  ] as const)('a change ending embedding turns it off: %s', (_name, patch, body) => {
    const link: ShareLinkDto = {
      ...LINK,
      audience: 'public',
      settings: {
        ...DEFAULT_SHARE_LINK_SETTINGS,
        embed: { enabled: true, allowed_origins: ['https://intranet.example.com'] },
      },
    };
    expect(updateBody({ ...initialDraft(link), ...patch }, link, 'view')).toEqual({
      ...body,
      settings: { embed: { enabled: false } },
    });
    expect(
      updateBody({ ...initialDraft(link), expires: true, expiresAt: future }, link, 'view'),
    ).toEqual({ expires_at: '2026-10-01T10:00:00.000Z' });
  });

  it('merges dashboard and embed settings one level deeper', () => {
    expect(
      mergeSettings(
        { dashboard: { tv_mode: true }, embed: { enabled: true } },
        { dashboard: { refresh_seconds: 30 }, embed: { allowed_origins: [] }, allow_export: true },
      ),
    ).toEqual({
      dashboard: { tv_mode: true, refresh_seconds: 30 },
      embed: { enabled: true, allowed_origins: [] },
      allow_export: true,
    });
    expect(flagPatch('tv_mode', true)).toEqual({ dashboard: { tv_mode: true } });
    expect(flagPatch('allow_copy', false)).toEqual({ allow_copy: false });
    expect(settingKeys('form')).toEqual([]);
  });

  it.each([
    [null, false],
    [{ audience: 'org' }, false],
    [{ audience: 'public' }, true],
    [{ password: null }, true],
    [{ password: 'secret-3' }, false],
  ] as const)('widening %j needs the warning acknowledged: %s', (body, widens) => {
    expect(widensAudience(body)).toBe(widens);
  });
});

describe('file fields of a link (T419)', () => {
  it('splits the attachment fields by the creator’s right to download', () => {
    const fields = [
      { id: 'fld_a', name: 'Title', type: 'text' },
      { id: 'fld_b', name: 'Photos', type: 'attachment' },
      { id: 'fld_c', name: 'Contracts', type: 'attachment' },
    ];
    expect(linkFileFields(fields, (id) => id === 'fld_b')).toEqual({
      downloadable: ['Photos'],
      viewOnly: ['Contracts'],
    });
    expect(linkFileFields(fields.slice(0, 1), () => true)).toEqual({
      downloadable: [],
      viewOnly: [],
    });
  });
});
