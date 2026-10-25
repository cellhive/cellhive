import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../test/i18n';
import { CellValue } from '../display/CellValue';
import { toGridField } from '../types';

import type { FieldDto } from '@cellhive/contracts';
import type { i18n as I18n } from 'i18next';

const NOW = '2026-09-28T00:00:00.000Z';

function field(extra: Partial<FieldDto>, options: Record<string, unknown> = {}) {
  return toGridField({
    id: 'fld_Total00000000001',
    table_id: 'tbl_Customers0000001',
    name: 'Total',
    type: 'lookup',
    options: { style: null, ...options },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
    result_type: { kind: 'number', list: false },
    compute_state: 'ready',
    compute_error: null,
    ...extra,
  });
}

const CTX = { locale: 'vi', timeZone: 'UTC' };
let i18n: I18n;
beforeAll(async () => {
  i18n = await createTestI18n('en');
});

function show(gridField: ReturnType<typeof field>, value: unknown) {
  return render(
    <I18nextProvider i18n={i18n}>
      <div data-testid="cell">
        <CellValue field={gridField} value={value} locale={CTX} empty="—" />
      </div>
    </I18nextProvider>,
  );
}

describe('computed values in the DOM (T468)', () => {
  it('a lookup sum in VND reads 1.500.000 ₫', () => {
    show(field({}, { style: { type: 'currency', currency_code: 'VND' } }), 1500000);
    expect(screen.getByTestId('cell')).toHaveTextContent('1.500.000 ₫');
  });

  it('a locked value shows a lock and nothing of the value', () => {
    show(field({ locked: true }), null);
    expect(screen.getByTestId('computed-locked')).toHaveTextContent('No access');
  });

  it('a field-level error shows its token', () => {
    show(
      field({ compute_error: { code: 'INVALID_CONFIG', refs: [] }, compute_state: 'error' }),
      null,
    );
    expect(screen.getByTestId('computed-error')).toHaveTextContent('#VALUE!');
  });

  it('HYPERLINK: only safe schemes become links', () => {
    const text = field({ result_type: { kind: 'text', list: false } });
    const { unmount } = show(text, '[Site](https://cellhive.io)');
    expect(screen.getByRole('link', { name: 'Site' })).toHaveAttribute(
      'href',
      'https://cellhive.io/',
    );
    unmount();
    show(text, '[Evil](javascript:alert(1))');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByTestId('cell')).toHaveTextContent('Evil');
  });

  it('a list of dates is chips in the result format', () => {
    show(
      field({ result_type: { kind: 'date', list: true } }, { style: { format: 'dd/MM/yyyy' } }),
      ['2026-09-01', '2026-09-02'],
    );
    expect(screen.getByTestId('cell')).toHaveTextContent('01/09/202602/09/2026');
  });

  it('an empty value shows the empty text', () => {
    show(field({}), null);
    expect(screen.getByTestId('cell')).toHaveTextContent('—');
  });
});
