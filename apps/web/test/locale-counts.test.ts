import { describe, expect, it } from 'vitest';

import { createTestI18n, localeResources } from './i18n';

/** Every string of a locale tree with its dotted key. */
function strings(tree: unknown, prefix = ''): [string, string][] {
  if (typeof tree === 'string') return [[prefix, tree]];
  if (tree === null || typeof tree !== 'object') return [];
  return Object.entries(tree).flatMap(([key, value]) =>
    strings(value, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('counts in UI strings (FRONTEND §9.1, T322b)', () => {
  it('never interpolate a bare {{count}}: numbers are formatted for the language', () => {
    const bare = Object.entries(localeResources()).flatMap(([language, namespaces]) =>
      strings(namespaces)
        .filter(([, text]) => text.includes('{{count}}'))
        .map(([key]) => `${language}:${key}`),
    );
    expect(bare).toEqual([]);
  });

  it.each([
    ['en', '2,000 records moved to the trash.'],
    ['vi', 'Đã chuyển 2.000 bản ghi vào thùng rác.'],
  ] as const)('groups thousands in %s', async (language, expected) => {
    const i18n = await createTestI18n(language);
    expect(i18n.t('grid:edit.deleted', { count: 2000 })).toBe(expected);
  });
});
