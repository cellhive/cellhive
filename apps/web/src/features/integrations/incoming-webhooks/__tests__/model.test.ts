import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../../lib/api/client';
import {
  authWithout,
  draftErrors,
  formatBytes,
  hasCheck,
  parseRate,
  revealedSecrets,
  usagesOfInUseError,
  type AuthCheck,
} from '../model';

import type { IncomingWebhookAuth, IncomingWebhookWithSecretsDto } from '@cellhive/contracts';

const HOOK: IncomingWebhookWithSecretsDto = {
  id: 'hok_0000000000000001',
  base_id: 'bse_0123456789ABCDEF',
  name: 'Shop orders',
  url: 'https://cellhive.example.com/api/v1/hooks/abc',
  auth: 'both',
  enabled: true,
  rate_limit_per_sec: 5,
  signing_secret_rotating_until: null,
  listen_until: null,
  sample_captured_at: null,
  last_received_at: null,
  usages: [],
  created_by: null,
  created_at: '2026-10-18T00:00:00.000Z',
  updated_at: '2026-10-18T00:00:00.000Z',
  signing_secret: null,
  bearer_token: null,
};

describe('authWithout', () => {
  it.each<[IncomingWebhookAuth, AuthCheck, IncomingWebhookAuth]>([
    ['both', 'signature', 'bearer'],
    ['both', 'bearer', 'signature'],
    ['signature', 'signature', 'none'],
    ['bearer', 'bearer', 'none'],
    ['bearer', 'signature', 'bearer'],
    ['none', 'bearer', 'none'],
  ])('%s without %s → %s', (auth, check, expected) => {
    expect(authWithout(auth, check)).toBe(expected);
  });
});

describe('hasCheck', () => {
  it.each<[IncomingWebhookAuth, AuthCheck, boolean]>([
    ['both', 'signature', true],
    ['both', 'bearer', true],
    ['signature', 'bearer', false],
    ['bearer', 'signature', false],
    ['none', 'signature', false],
  ])('%s has %s: %s', (auth, check, expected) => {
    expect(hasCheck(auth, check)).toBe(expected);
  });
});

describe('usagesOfInUseError', () => {
  const usage = { automation_id: 'aut_0000000000000001', name: 'Create order' };
  it.each<[string, unknown, unknown]>([
    [
      'WEBHOOK_IN_USE with usages',
      new ApiError({
        status: 409,
        code: 'WEBHOOK_IN_USE',
        errors: [
          {
            path: '',
            code: 'WEBHOOK_IN_USE',
            message: 'in use',
            params: { usages: [usage, 42], total: 1 },
          },
        ],
      }),
      [usage],
    ],
    ['WEBHOOK_IN_USE without params', new ApiError({ status: 409, code: 'WEBHOOK_IN_USE' }), []],
    ['another code', new ApiError({ status: 404, code: 'NOT_FOUND' }), null],
    ['not an API error', new Error('x'), null],
  ])('%s', (_label, error, expected) => {
    expect(usagesOfInUseError(error)).toEqual(expected);
  });
});

describe('revealedSecrets', () => {
  it.each<[string, Partial<IncomingWebhookWithSecretsDto>, boolean, string[]]>([
    [
      'create, both',
      { signing_secret: 'whsec_x', bearer_token: 'tok' },
      true,
      ['url', 'signing_secret', 'bearer_token'],
    ],
    ['create, none', {}, true, ['url']],
    ['rotation', { signing_secret: 'whsec_y' }, false, ['signing_secret']],
    ['new Bearer token', { bearer_token: 'tok2' }, false, ['bearer_token']],
  ])('%s', (_label, patch, withUrl, kinds) => {
    expect(revealedSecrets({ ...HOOK, ...patch }, withUrl).map((item) => item.kind)).toEqual(kinds);
  });
});

describe('parseRate / draftErrors', () => {
  it.each<[string, number | null]>([
    ['5', 5],
    [' 1000 ', 1000],
    ['0', null],
    ['1001', null],
    ['2.5', null],
    ['', null],
    ['-1', null],
  ])('parseRate(%j) → %s', (input, expected) => {
    expect(parseRate(input)).toBe(expected);
  });

  it.each<[{ name: string; rate: string }, Record<string, string>]>([
    [{ name: 'Orders', rate: '5' }, {}],
    [{ name: '  ', rate: '5' }, { name: 'required' }],
    [{ name: 'x'.repeat(101), rate: '5' }, { name: 'tooLong' }],
    [{ name: 'Orders', rate: 'abc' }, { rate: 'rate' }],
  ])('draftErrors(%j)', (draft, expected) => {
    expect(draftErrors(draft)).toEqual(expected);
  });
});

describe('formatBytes', () => {
  it.each<[number, string, string]>([
    [0, 'en', '0 B'],
    [1023, 'en', '1,023 B'],
    [1536, 'en', '1.5 KB'],
    [1536, 'vi', '1,5 KB'],
    [1_048_576, 'en', '1 MB'],
  ])('%i bytes (%s) → %s', (bytes, locale, expected) => {
    expect(formatBytes(bytes, locale)).toBe(expected);
  });
});
