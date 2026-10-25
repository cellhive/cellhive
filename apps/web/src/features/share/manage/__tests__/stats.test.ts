import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';

import en from '../../../../locales/en/share.json';
import { accessSummary } from '../stats';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { share: en } },
    ns: ['share'],
    defaultNS: 'share',
  });
});

describe('accessSummary (one wording for the dialog and the lists, T320 QA)', () => {
  const when = (iso: string) => `at ${iso}`;
  it.each([
    [{ access_count: 0, last_accessed_at: null }, 'Not opened yet'],
    [{ access_count: 1, last_accessed_at: null }, 'Opened 1 time'],
    [
      { access_count: 1, last_accessed_at: '2026-09-25T10:05:00Z' },
      'Opened 1 time, last at 2026-09-25T10:05:00Z',
    ],
    [
      { access_count: 42, last_accessed_at: '2026-09-25T10:05:00Z' },
      'Opened 42 times, last at 2026-09-25T10:05:00Z',
    ],
  ])('%j', (link, text) => {
    const t = i18n.getFixedT('en', 'share');
    expect(accessSummary(t, link, when)).toBe(text);
  });
});
