import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import { createQueryClient } from '../../../lib/query/client';
import { keys } from '../../../lib/query/keys';
import { FormulaEditorDialog } from '../components/FormulaEditorDialog';

import { CUSTOMERS, id, SCHEMA } from './fixture';

import type { FormulaDraft, FormulaSaveOutcome } from '../../../lib/schema/formula-tools';

/** T466: the formula editor dialog, same-row preview and positioned errors (no server). */

const record = (key: string, name: string, status: string, revenue: number) => ({
  id: id('rec', key),
  version: 1,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  fields: {
    [id('fld', 'CustName')]: name,
    [id('fld', 'CustStatus')]: status,
    [id('fld', 'CustRevenue')]: revenue,
  },
});

async function renderEditor(
  expression: string,
  onConfirm: (value: FormulaDraft) => Promise<FormulaSaveOutcome> = () =>
    Promise.resolve({ ok: true }),
) {
  const i18n = await createTestI18n('en');
  const client = createQueryClient();
  client.setQueryData(keys.formulaPreviewRows(CUSTOMERS), {
    records: [record('a', 'An', 'Xong', 1_500_000), record('b', 'Bình', 'Mở', 10)],
    total: null,
  });
  const onCancel = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <FormulaEditorDialog
          tableId={CUSTOMERS}
          fieldId={undefined}
          fieldName="Commission"
          tableName="Khách hàng"
          schema={SCHEMA}
          timeZone="Asia/Ho_Chi_Minh"
          currency="VND"
          initial={{ expression, style: null, styleTouched: false }}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { onCancel, editor: await screen.findByTestId('formula-editor') };
}

describe('FormulaEditorDialog', () => {
  it('computes a same-row formula on the loaded rows and saves it', async () => {
    const onConfirm = vi.fn(() => Promise.resolve<FormulaSaveOutcome>({ ok: true }));
    const { editor } = await renderEditor(
      'IF([Trạng thái] = "Xong", [Doanh thu] * 0.1, 0)',
      onConfirm,
    );
    const view = within(editor);
    expect(view.getByTestId('formula-result-type')).toHaveTextContent('Number');
    expect(view.getByTestId('formula-compute-mode')).toHaveTextContent('Stored');
    expect(await view.findByTestId('formula-preview-row')).toHaveTextContent('Record 1 / 2 · An');
    expect(view.getByTestId('formula-preview-value')).toHaveTextContent('150,000');
    await userEvent.click(view.getByRole('button', { name: 'Next record' }));
    expect(view.getByTestId('formula-preview-row')).toHaveTextContent('Record 2 / 2 · Bình');
    expect(view.getByTestId('formula-preview-value')).toHaveTextContent('0');
    // The chips show names; the style follows the carried currency.
    expect(editor.querySelector('[data-chip="field"]')).toHaveTextContent('Trạng thái');
    expect(view.getByRole('button', { name: 'Currency', pressed: true })).toBeInTheDocument();
    await userEvent.click(view.getByTestId('formula-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({
      expression: 'IF([Trạng thái] = "Xong", [Doanh thu] * 0.1, 0)',
      style: null,
      styleTouched: false,
    });
  });

  it('lists errors with their position and blocks Confirm', async () => {
    const onConfirm = vi.fn(() => Promise.resolve<FormulaSaveOutcome>({ ok: true }));
    const { editor } = await renderEditor('SUM(', onConfirm);
    const view = within(editor);
    const errors = await view.findByTestId('formula-errors');
    expect(errors).toHaveTextContent('Missing ) to close SUM(.');
    expect(errors).toHaveTextContent('1:5');
    const input = view.getByRole('textbox', { name: 'Formula' });
    expect(input).toHaveAttribute('aria-describedby', errors.id);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const confirm = view.getByTestId('formula-confirm');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(view.getByText('Fix 1 error to confirm')).toBeInTheDocument();
  });

  it('shows the formula error the server answered on save at its place', async () => {
    const { ApiError } = await import('../../../lib/api/client');
    const failure = new ApiError({
      status: 422,
      code: 'FORMULA_CYCLE',
      detail: 'cycle',
      errors: [
        {
          path: 'options',
          code: 'CIRCULAR_REFERENCE',
          message: 'cycle',
          params: { position: { start: 0, length: 9 }, cycle: [] },
        },
      ],
      request_id: 'req_1',
    });
    const { editor } = await renderEditor('[Số đơn] + 1', () =>
      Promise.resolve({ ok: false, formError: false, error: failure }),
    );
    const view = within(editor);
    await userEvent.click(view.getByTestId('formula-confirm'));
    expect(await view.findByTestId('formula-errors')).toHaveTextContent(
      'The formula refers to itself through other fields.',
    );
  });
});
