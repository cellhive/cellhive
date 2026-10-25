import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { createTestI18n } from '../../../../../test/i18n';
import { fieldsQuery } from '../../../../lib/query/queries';
import { AutomationConditionEditor } from '../AutomationConditionEditor';
import { RecordFilterEditor } from '../RecordFilterEditor';

const TABLE = 'tbl_Tickets000000001';
const NOW = '2026-10-17T00:00:00.000Z';
const PRIORITY = 'fld_Priority00000001';
const URGENT = 'opt_UrgentAAAAAAAAAA';

function client(): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(fieldsQuery(TABLE).queryKey, {
    items: [
      {
        id: PRIORITY,
        table_id: TABLE,
        name: 'Ưu tiên',
        type: 'select',
        options: { multiple: false, options: [{ id: URGENT, name: 'Khẩn cấp', color: 1 }] },
        is_primary: true,
        required: false,
        unique_values: false,
        description: null,
        position: 0,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    total: 1,
    offset: 0,
    limit: 1000,
  });
  return queryClient;
}

const FILTER = {
  op: 'and',
  items: [{ field: PRIORITY, operator: 'is', value: URGENT }],
} as const;

/**
 * T527: in the 440 px panel of the builder the wide filter grid (field,
 * operator, value, ×: ~560 px, chosen by the *screen* width) overflowed and
 * cut off the value and the × button. Automation conditions use the compact
 * grid: field + operator + × on the first line, the value on the second.
 */
describe('AutomationConditionEditor layout (T527)', () => {
  it('keeps every control of a condition inside a narrow panel', async () => {
    const i18n = await createTestI18n('vi');
    render(
      <QueryClientProvider client={client()}>
        <I18nextProvider i18n={i18n}>
          <AutomationConditionEditor
            tableId={TABLE}
            orgId="org_Demo000000000001"
            value={FILTER}
            onChange={vi.fn()}
            label="Chạy khi bản ghi bắt đầu khớp"
            emptyText="Không có điều kiện"
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    const remove = await screen.findByRole('button', { name: /Ưu tiên/u });
    const row = remove.parentElement;
    expect(row?.className).toContain('grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem]');
    expect(row?.className).not.toContain('sm:grid-cols');
    expect(remove.className).toContain('col-start-3');
  });

  it('keeps the wide grid for view-like filters', async () => {
    const i18n = await createTestI18n('vi');
    render(
      <QueryClientProvider client={client()}>
        <I18nextProvider i18n={i18n}>
          <RecordFilterEditor
            tableId={TABLE}
            orgId="org_Demo000000000001"
            value={FILTER}
            onChange={vi.fn()}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    const remove = await screen.findByRole('button', { name: /Ưu tiên/u });
    expect(remove.parentElement?.className).toContain('sm:grid-cols-[10rem_10rem');
  });
});
