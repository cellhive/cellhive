import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../test/i18n';
import { CellValue } from '../display/CellValue';
import { toGridField } from '../types';

import type { i18n as I18n } from 'i18next';

const NOW = '2026-09-28T00:00:00.000Z';
const LINK = toGridField({
  id: 'fld_Order00000000001',
  table_id: 'tbl_Details000000001',
  name: 'Order',
  type: 'link',
  options: { link_table: 'tbl_Orders0000000001', allow_multiple: true },
  is_primary: false,
  required: false,
  unique_values: false,
  description: null,
  position: 0,
  created_at: NOW,
  updated_at: NOW,
});
const CTX = { locale: 'vi', timeZone: 'UTC' };

let i18n: I18n;
beforeAll(async () => {
  i18n = await createTestI18n('en');
});

function show(value: unknown, compact: boolean) {
  return render(
    <I18nextProvider i18n={i18n}>
      <div data-testid="cell">
        <CellValue field={LINK} value={value} locale={CTX} compact={compact} />
      </div>
    </I18nextProvider>,
  );
}

const refs = [
  { id: 'rec_0000000000000001', title: 'ĐH-00001 Cty TNHH Dương' },
  { id: 'rec_0000000000000002', title: 'ĐH-00002 Công ty Đặng' },
  { id: 'rec_0000000000000003', title: 'ĐH-00003 Chi nhánh Dương' },
];

describe('CellValue of link cells (T421a)', () => {
  it('compact (sub-table, cards): one chip on one line, then "+N"', () => {
    show(refs, true);
    const chip = screen.getByText('ĐH-00001 Cty TNHH Dương');
    expect(chip).toHaveClass('truncate');
    expect(chip).toHaveClass('whitespace-nowrap');
    expect(screen.queryByText('ĐH-00002 Công ty Đặng')).toBeNull();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('and 2 more')).toHaveClass('sr-only');
  });

  it('not compact (record panel): every chip', () => {
    show(refs, false);
    for (const ref of refs) expect(screen.getByText(ref.title)).toBeInTheDocument();
    expect(screen.queryByText('+2')).toBeNull();
  });
});
