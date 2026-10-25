import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { ResultStep } from '../components/ResultStep';

import type { JobDto } from '@cellhive/contracts';

const JOB = 'job_Import0000000001';
const NOW = '2026-09-28T00:00:00.000Z';

function job(errors: readonly Record<string, unknown>[], failed: number): JobDto {
  return {
    id: JOB,
    type: 'table.import',
    status: 'succeeded',
    progress: 1,
    result: {
      mode: 'append',
      table_id: 'tbl_Orders0000000001',
      rows: 3,
      imported: 3 - failed,
      failed,
      errors,
      errors_truncated: false,
      download_url: `/api/v1/files/exports/${JOB}`,
      expires_at: '2999-01-01T00:00:00.000Z',
    },
    error: null,
    created_at: NOW,
    started_at: NOW,
    finished_at: NOW,
  };
}

const error = (row: number, column: number, name: string, code: string) => ({
  row: row + 1,
  data_row: row,
  column,
  column_name: name,
  field_id: null,
  code,
});

async function renderResult(value: JobDto, language: 'en' | 'vi' = 'en') {
  const i18n = await createTestI18n(language);
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <ResultStep
          target={{ mode: 'append', tableId: 'tbl_1', tableName: 'Orders' }}
          job={value}
        />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe('import result (T421b)', () => {
  it('says only the counts that are not zero', async () => {
    await renderResult(job([error(1, 2, 'Khách hàng', 'LINK_TARGET_NOT_FOUND')], 1));
    expect(screen.getByTestId('import-link-summary')).toHaveTextContent(
      '1 linked record not found.',
    );
    expect(screen.getByTestId('import-link-summary')).not.toHaveTextContent('0');
  });

  it('says only the counts that are not zero (vi, ambiguous only)', async () => {
    await renderResult(job([error(1, 2, 'Khách hàng', 'LINK_TARGET_AMBIGUOUS')], 1), 'vi');
    expect(screen.getByTestId('import-link-summary')).toHaveTextContent(
      '1 liên kết trùng tiêu đề với nhiều bản ghi.',
    );
  });

  it('lists every error of a row: the first, then the others folded', async () => {
    const user = userEvent.setup();
    const { container } = await renderResult(
      job(
        [
          error(1, 1, 'Số tiền', 'EXPECTED_NUMBER'),
          error(1, 2, 'Khách hàng', 'LINK_TARGET_NOT_FOUND'),
          error(2, 1, 'Số tiền', 'EXPECTED_NUMBER'),
        ],
        2,
      ),
    );
    const rows = screen.getAllByTestId('import-error-row');
    expect(rows).toHaveLength(2);
    const [first] = rows;
    if (first === undefined) throw new Error('no row');
    expect(within(first).getAllByRole('cell')[1]).toHaveTextContent('Số tiền');
    const more = within(first).getByTestId('import-error-more');
    expect(more).not.toHaveAttribute('open');
    await user.click(within(more).getByText('1 more problem in this row'));
    expect(more).toHaveAttribute('open');
    expect(more).toHaveTextContent('Khách hàng');
    expect(more).toHaveTextContent('No record with this title');
    expect(within(rows[1] as HTMLElement).queryByTestId('import-error-more')).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });
});
