import {
  ADMIN_DETAIL_CODES,
  CELL_VALUE_DETAIL_CODES,
  ERROR_CODES,
  ERROR_DETAIL_CODES,
  FILTER_DETAIL_CODES,
  RECORD_QUERY_DETAIL_CODES,
  RECORD_WRITE_DETAIL_CODES,
  ROLE_DETAIL_CODES,
  SCHEMA_DETAIL_CODES,
} from '@cellhive/contracts';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestI18n, localeResources } from '../../../../test/i18n';
import { ApiError, CLIENT_ERROR_CODES } from '../../api/client';
import { LANGUAGES, NAMESPACES } from '../../i18n/i18n';
import { translateDetail, translateError } from '../translate';

import type { i18n as I18n } from 'i18next';

/**
 * Detail codes (`errors[].code`) every language must translate: all lists of
 * CONTRACTS §6 (`ERROR_DETAIL_CODES`, cell, filter, schema, record, role and
 * admin sub-codes), plus the codes only the client produces.
 */
const CLIENT_DETAIL_CODES = ['PASSWORD_MISMATCH'] as const;
const DETAIL_CODES = [...ERROR_DETAIL_CODES, ...CLIENT_DETAIL_CODES];

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : flatten(value, `${prefix}${key}.`),
  );
}

/** Plural forms differ per language (`vi` has only `_other`). */
function withoutPluralSuffix(key: string): string {
  return key.replace(/_(zero|one|two|few|many|other)$/u, '');
}

const resources = localeResources();

function lookup(language: string, namespace: string, path: string): unknown {
  let node: unknown = resources[language]?.[namespace];
  for (const part of path.split('.')) {
    node = typeof node === 'object' && node !== null ? (node as Tree)[part] : undefined;
  }
  return node;
}

describe('locale files', () => {
  it('has every namespace in every language', () => {
    for (const language of LANGUAGES) {
      expect(Object.keys(resources[language] ?? {}).sort()).toEqual([...NAMESPACES].sort());
    }
  });

  it.each(NAMESPACES)('has the same keys in en and vi for "%s"', (namespace) => {
    const keysOf = (language: string) =>
      [
        ...new Set(flatten(resources[language]?.[namespace] as Tree).map(withoutPluralSuffix)),
      ].sort();
    expect(keysOf('vi')).toEqual(keysOf('en'));
  });

  it('has no empty translation', () => {
    for (const language of LANGUAGES) {
      for (const namespace of NAMESPACES) {
        const tree = resources[language]?.[namespace] as Tree;
        for (const key of flatten(tree)) {
          expect(lookup(language, namespace, key), `${language}/${namespace}:${key}`).not.toBe('');
        }
      }
    }
  });
});

describe('error translations (FRONTEND §8.1)', () => {
  it.each(LANGUAGES)('translates every CONTRACTS §6 code in %s', (language) => {
    const missing = ERROR_CODES.filter(
      (code) => typeof lookup(language, 'errors', `codes.${code}`) !== 'string',
    );
    expect(missing).toEqual([]);
  });

  it.each(LANGUAGES)('translates every client-side code in %s', (language) => {
    for (const code of CLIENT_ERROR_CODES) {
      expect(typeof lookup(language, 'errors', `client.${code}`)).toBe('string');
    }
  });

  it.each([
    ['cell', CELL_VALUE_DETAIL_CODES],
    ['filter', FILTER_DETAIL_CODES],
    ['schema', SCHEMA_DETAIL_CODES],
    ['record query', RECORD_QUERY_DETAIL_CODES],
    ['record write', RECORD_WRITE_DETAIL_CODES],
    ['role', ROLE_DETAIL_CODES],
    ['admin', ADMIN_DETAIL_CODES],
  ] as const)('translates every %s sub-code in en and vi', (_group, codes) => {
    for (const language of LANGUAGES) {
      const missing = codes.filter(
        (code) => typeof lookup(language, 'errors', `detail.${code}`) !== 'string',
      );
      expect(missing, language).toEqual([]);
    }
  });

  it.each(LANGUAGES)('translates every documented detail code in %s', (language) => {
    const missing = DETAIL_CODES.filter(
      (code) => typeof lookup(language, 'errors', `detail.${code}`) !== 'string',
    );
    expect(missing).toEqual([]);
  });

  it('has no translation for a code the contracts do not define', () => {
    const codes = lookup('en', 'errors', 'codes') as Record<string, string>;
    const extra = Object.keys(codes).filter((code) => !ERROR_CODES.includes(code as never));
    expect(extra).toEqual([]);
  });
});

describe('translateError', () => {
  let en: I18n;
  let vi: I18n;

  beforeAll(async () => {
    en = await createTestI18n('en');
    vi = await createTestI18n('vi');
  });

  it('translates by code, not by the English title', () => {
    const error = new ApiError({
      status: 404,
      code: 'NOT_FOUND',
      title: 'Not found',
      request_id: 'req_1',
    });
    expect(translateError(error, en)).toEqual({
      message: 'Not found, or you do not have access.',
      details: [],
      requestId: 'req_1',
    });
    expect(translateError(error, vi).message).toBe(
      'Không tìm thấy, hoặc bạn không có quyền truy cập.',
    );
  });

  it('translates errors[] by detail code with params and origin variant', () => {
    const error = new ApiError({
      status: 422,
      code: 'VALIDATION_FAILED',
      errors: [
        {
          path: 'password',
          code: 'TOO_SMALL',
          message: 'Too small: expected string to have >=10 characters',
          params: { minimum: 10, origin: 'string', inclusive: true },
        },
        { path: 'password', code: 'PASSWORD_TOO_COMMON', message: 'Too common' },
      ],
    });
    expect(translateError(error, en).details).toEqual([
      { path: 'password', message: 'Must be at least 10 characters.' },
      { path: 'password', message: 'This password is too common. Choose another one.' },
    ]);
    expect(translateError(error, vi).details[0]?.message).toBe('Cần ít nhất 10 ký tự.');
  });

  it('picks a variant by params.reason, one message per reason (T556)', () => {
    const reasons = ['control_char', 'angle_bracket', 'at_sign', 'url'] as const;
    for (const language of [en, vi]) {
      const messages = reasons.map((reason) =>
        translateDetail(language, { code: 'DISPLAY_NAME_NOT_ALLOWED', params: { reason } }),
      );
      expect(new Set(messages).size).toBe(reasons.length);
      const plain = translateDetail(language, { code: 'DISPLAY_NAME_NOT_ALLOWED' });
      expect(messages).not.toContain(plain);
    }
    expect(
      translateDetail(en, { code: 'DISPLAY_NAME_NOT_ALLOWED', params: { reason: 'at_sign' } }),
    ).toBe('The display name cannot contain @: recipients could take it for an email address.');
    expect(
      translateDetail(vi, { code: 'DISPLAY_NAME_NOT_ALLOWED', params: { reason: 'url' } }),
    ).toBe('Tên hiển thị không được trông giống địa chỉ web (https://…, www., example.com).');
    expect(
      translateDetail(en, {
        code: 'BUTTON_IN_USE',
        params: { reason: 'duplicate', automation_id: 'aut_1' },
      }),
    ).toMatch(/^This automation runs from a button, and a button runs only one automation/u);
    // A reason without a string of its own reads as the plain code.
    expect(translateDetail(en, { code: 'BUTTON_IN_USE', params: { reason: 'something' } })).toBe(
      'Another automation already runs from this button.',
    );
  });

  it('falls back to the server message for an unknown detail code', () => {
    expect(translateDetail(en, { code: 'SOMETHING_NEW', message: 'Something new happened' })).toBe(
      'Something new happened',
    );
  });

  it('applies screen-specific overrides', async () => {
    const withAuth = await createTestI18n('en');
    const error = new ApiError({ status: 401, code: 'UNAUTHENTICATED' });
    expect(
      translateError(error, withAuth, {
        overrides: { UNAUTHENTICATED: 'auth:login.invalidCredentials' },
      }).message,
    ).toBe('Wrong email or password.');
  });

  it('adds the Retry-After wait', () => {
    const error = new ApiError({ status: 429, code: 'RATE_LIMITED', retry_after: 30 });
    expect(translateError(error, en).message).toBe('Too many requests. Try again in 30 seconds.');
    expect(translateError(error, vi).message).toBe('Quá nhiều yêu cầu. Hãy thử lại sau 30 giây.');
  });

  it.each([
    [1, 'Try again in 1 second.', 'Hãy thử lại sau 1 giây.'],
    [59.2, 'Try again in 60 seconds.', 'Hãy thử lại sau 60 giây.'],
    [60, 'Try again in 1 minute.', 'Hãy thử lại sau 1 phút.'],
    [900, 'Try again in 15 minutes.', 'Hãy thử lại sau 15 phút.'],
    [901, 'Try again in 16 minutes.', 'Hãy thử lại sau 16 phút.'],
    [3600, 'Try again in 1 hour.', 'Hãy thử lại sau 1 giờ.'],
    [7200, 'Try again in 2 hours.', 'Hãy thử lại sau 2 giờ.'],
  ])(
    'reads a Retry-After of %s s in the largest unit (lockout: not "900 seconds")',
    (seconds, english, vietnamese) => {
      const error = new ApiError({ status: 423, code: 'ACCOUNT_LOCKED', retry_after: seconds });
      expect(translateError(error, en).message).toContain(english);
      expect(translateError(error, vi).message).toContain(vietnamese);
    },
  );

  it('translates network failures and non-API errors', () => {
    expect(translateError(new ApiError({ status: 0, code: 'NETWORK_ERROR' }), en).message).toMatch(
      /could not be reached/u,
    );
    expect(translateError(new TypeError('boom'), en).message).toBe(
      'Something went wrong. Try again.',
    );
  });
});
