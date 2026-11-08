import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { createTestI18n } from '../../../../../test/i18n';
import { fieldsQuery } from '../../../../lib/query/queries';
import { RecordFilterEditor } from '../RecordFilterEditor';

const TABLE = 'tbl_Customers0000001';
const NOW = '2026-09-28T00:00:00.000Z';

describe('RecordFilterEditor (T421a)', () => {
  it.each([
    ['en', 'No condition yet: every record of the linked table can be picked.', undefined],
    ['vi', 'Chưa có điều kiện: chọn được mọi bản ghi của bảng liên kết.', undefined],
    // T819: a dashboard widget's saved filter is not a link field's.
    ['en', 'No condition yet: every record of the table is counted.', 'edit.panel.filterEmpty'],
    ['vi', 'Chưa có điều kiện: tính mọi record của bảng.', 'edit.panel.filterEmpty'],
  ] as const)('%s: without conditions it says “%s”', async (lang, text, key) => {
    const i18n = await createTestI18n(lang);
    const queryClient = new QueryClient();
    queryClient.setQueryData(fieldsQuery(TABLE).queryKey, {
      items: [
        {
          id: 'fld_Name000000000001',
          table_id: TABLE,
          name: 'Name',
          type: 'text',
          options: {},
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
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <RecordFilterEditor
            tableId={TABLE}
            orgId="org_Demo000000000001"
            value={null}
            onChange={vi.fn()}
            emptyText={key === undefined ? undefined : i18n.t(key, { ns: 'dashboard' })}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(text)).toBeInTheDocument();
  });
});

/**
 * T527: the compact grid (field + operator + × on one line, the value on the
 * next) is the automation builder's; view-like filters keep the wide grid.
 */
describe('RecordFilterEditor layout (T527)', () => {
  it('keeps the wide grid for view-like filters', async () => {
    const i18n = await createTestI18n('vi');
    const queryClient = new QueryClient();
    queryClient.setQueryData(fieldsQuery(TABLE).queryKey, {
      items: [
        {
          id: 'fld_Priority00000001',
          table_id: TABLE,
          name: 'Ưu tiên',
          type: 'select',
          options: {
            multiple: false,
            options: [{ id: 'opt_UrgentAAAAAAAAAA', name: 'Khẩn cấp', color: 1 }],
          },
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
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <RecordFilterEditor
            tableId={TABLE}
            orgId="org_Demo000000000001"
            value={{
              op: 'and',
              items: [
                { field: 'fld_Priority00000001', operator: 'is', value: 'opt_UrgentAAAAAAAAAA' },
              ],
            }}
            onChange={vi.fn()}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    const remove = await screen.findByRole('button', { name: /Ưu tiên/u });
    expect(remove.parentElement?.className).toContain('sm:grid-cols-[10rem_10rem');
  });
});
