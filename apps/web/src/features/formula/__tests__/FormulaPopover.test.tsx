import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import { createQueryClient } from '../../../lib/query/client';
import { keys } from '../../../lib/query/keys';
import { FormulaPopoverEditor } from '../components/FormulaPopover';

import { CUSTOMERS, id, SCHEMA } from './fixture';

import type { FormulaSaveOutcome } from '../../../lib/schema/formula-tools';
import type { FieldDto } from '@cellhive/contracts';

/** T468: the formula popover of the column header (S4b decision #12). */

const NOW = '2026-09-28T00:00:00.000Z';
const FIELD: FieldDto = {
  id: id('fld', 'Commission') as FieldDto['id'],
  table_id: CUSTOMERS as FieldDto['table_id'],
  name: 'Commission',
  type: 'formula',
  options: { expression: '[Doanh thu] * 0.1', style: null },
  is_primary: false,
  required: false,
  unique_values: false,
  description: null,
  position: 3,
  created_at: NOW,
  updated_at: NOW,
  result_type: { kind: 'number', list: false },
  compute_state: 'ready',
  compute_error: null,
};

const record = (key: string, name: string, revenue: number) => ({
  id: id('rec', key),
  version: 1,
  created_at: NOW,
  updated_at: NOW,
  fields: { [id('fld', 'CustName')]: name, [id('fld', 'CustRevenue')]: revenue },
});

async function renderPopover(onSave: () => Promise<FormulaSaveOutcome>, onClose = vi.fn()) {
  const i18n = await createTestI18n('en');
  const client = createQueryClient();
  client.setQueryData(keys.formulaPreviewRows(CUSTOMERS), {
    records: [record('a', 'An', 1_500_000)],
    total: null,
  });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <FormulaPopoverEditor
          tableId={CUSTOMERS}
          field={FIELD}
          anchor={{ x: 300, y: 100, width: 180, height: 36 }}
          onSave={onSave}
          onClose={onClose}
          schema={SCHEMA}
          tableName="Khách hàng"
          timeZone="Asia/Ho_Chi_Minh"
          currency="VND"
        />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { onClose, popover: await screen.findByTestId('formula-popover') };
}

describe('FormulaPopover', () => {
  it('previews the saved formula on the loaded rows and saves it', async () => {
    const onSave = vi.fn(() => Promise.resolve<FormulaSaveOutcome>({ ok: true }));
    const { popover } = await renderPopover(onSave);
    const view = within(popover);
    expect(view.getByRole('heading', { level: 2 })).toHaveTextContent('Edit formula · Commission');
    expect(await view.findByTestId('formula-preview-row')).toHaveTextContent('Record 1 / 1 · An');
    expect(view.getByTestId('formula-preview-value')).toHaveTextContent('150,000');
    await userEvent.click(view.getByTestId('formula-confirm'));
    expect(onSave).toHaveBeenCalledWith({
      expression: '[Doanh thu] * 0.1',
      style: null,
      styleTouched: false,
    });
  });

  it('"Expand" opens the full editor with the formula', async () => {
    const { popover, onClose } = await renderPopover(() => Promise.resolve({ ok: true }));
    await userEvent.click(within(popover).getByTestId('formula-popover-expand'));
    expect(await screen.findByTestId('formula-editor')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
