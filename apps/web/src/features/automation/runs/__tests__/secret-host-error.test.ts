import { describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../../test/i18n';
import { createFormatters } from '../../../../lib/i18n/format';
import { runErrorText } from '../components/RunBits';

/** T701: `secret_host_not_allowed` reads as a sentence in both languages, never the raw code. */
describe('runErrorText: secret_host_not_allowed (T701)', () => {
  it.each(['en', 'vi'] as const)('%s', async (language) => {
    const i18n = await createTestI18n(language);
    const ctx = {
      t: i18n.t,
      format: createFormatters(language, 'UTC'),
      userName: () => null,
    };
    const listed = runErrorText(
      {
        code: 'secret_host_not_allowed',
        params: { purpose: 'auth', secret_id: 'sec_0000000000000001', reason: 'not_listed' },
      },
      ctx,
    );
    const expired = runErrorText(
      {
        code: 'secret_host_not_allowed',
        params: { purpose: 'signing', secret_id: 'sec_0000000000000001', reason: 'legacy_expired' },
      },
      ctx,
    );
    for (const text of [listed, expired]) {
      expect(text).not.toContain('secret_host_not_allowed');
      expect(text).not.toBe(i18n.t('automationRuns:error.unknown'));
    }
    expect(listed).not.toBe(expired);
  });
});
