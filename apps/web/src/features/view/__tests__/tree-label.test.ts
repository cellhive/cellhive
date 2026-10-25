import { beforeAll, describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import { treeButtonLabel } from '../toolbar/tree-label';

import type { i18n as I18n } from 'i18next';

let en: I18n;
let vi: I18n;

beforeAll(async () => {
  en = await createTestI18n('en');
  vi = await createTestI18n('vi');
});

describe('tree button label (T421b: says what the default opens)', () => {
  it.each([
    [false, 1, 'Tree', 'Dạng cây'],
    // One level = the roots only: every branch is closed.
    [true, 1, 'Tree: collapsed', 'Cây: thu gọn'],
    [true, 3, 'Tree: 3 levels open', 'Cây: mở 3 cấp'],
    [true, 10, 'Tree: all open', 'Cây: mở tất cả'],
  ] as const)('on=%s, %i levels', (on, levels, english, vietnamese) => {
    expect(treeButtonLabel(en.getFixedT('en', 'tree'), on, levels)).toBe(english);
    expect(treeButtonLabel(vi.getFixedT('vi', 'tree'), on, levels)).toBe(vietnamese);
  });
});
