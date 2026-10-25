import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import { DeleteBranchDialog } from '../tree/DeleteBranchDialog';

import type { i18n as I18n } from 'i18next';

let en: I18n;
let vi: I18n;

beforeAll(async () => {
  en = await createTestI18n('en');
  vi = await createTestI18n('vi');
});

function legendOf(i18n: I18n, ids: readonly string[], children: number): string {
  render(
    <I18nextProvider i18n={i18n}>
      <DeleteBranchDialog
        request={{ ids, children }}
        tableName="Công việc"
        onResolve={() => undefined}
      />
    </I18nextProvider>,
  );
  const legend = screen.getByTestId('tree-delete-choice').querySelector('legend');
  return legend?.textContent ?? '';
}

describe('delete branch dialog legend (T421b: one record or several, plural)', () => {
  it.each([
    [['rec_1'], 1, 'This record has 1 sub-record', 'Bản ghi này có 1 sub-record'],
    [['rec_1'], 3, 'This record has 3 sub-records', 'Bản ghi này có 3 sub-record'],
    [['rec_1', 'rec_2'], 1, 'These records have 1 sub-record', 'Các bản ghi này có 1 sub-record'],
    [['rec_1', 'rec_2'], 4, 'These records have 4 sub-records', 'Các bản ghi này có 4 sub-record'],
  ] as const)('%j with %i sub-records', (ids, children, english, vietnamese) => {
    expect(legendOf(en, ids, children)).toBe(english);
    document.body.innerHTML = '';
    expect(legendOf(vi, ids, children)).toBe(vietnamese);
  });
});
