import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, problem, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { createTestI18n } from '../../../../../test/i18n';
import { createQueryClient } from '../../../../lib/query/client';
import { keys } from '../../../../lib/query/keys';
import { clearToasts } from '../../../../lib/toast/toast';
import { FieldTools } from '../../components/FieldTools';

import type { FieldToolRequest } from '../../../../lib/schema/field-tools';
import type { ConvertFieldPreview, FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-26T00:00:00.000Z';
const BASE = 'bse_Sales00000000001';
const ORG = 'org_Demo000000000001';
const ORDERS = 'tbl_Orders0000000001';
const CUSTOMERS = 'tbl_Customers0000001';
const CODE = 'fld_Code000000000001';
const LINK = 'fld_Customer00000001';
const REVERSE = 'fld_Orders0000000001';
const REC1 = 'rec_0000000000000001';
const REC2 = 'rec_0000000000000002';

function field(id: string, overrides: Partial<FieldDto> = {}): FieldDto {
  return {
    id,
    table_id: ORDERS,
    name: id,
    type: 'text',
    options: {},
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as FieldDto;
}

const TITLE = field('fld_Title00000000001', { name: 'Title', is_primary: true, position: 0 });
const CODE_FIELD = field(CODE, { name: 'Code', options: { style: { type: 'plain' } } });
const linkField = (extra: Record<string, unknown> = {}) =>
  field(LINK, {
    name: 'Customer',
    type: 'link',
    position: 2,
    options: {
      link_table: CUSTOMERS,
      bidirectional: false,
      allow_multiple: true,
      record_filter: null,
      symmetric_field_id: null,
      ...extra,
    },
  });
const TWO_WAY = linkField({
  bidirectional: true,
  bidirectional_link_field_name: 'Orders',
  symmetric_field_id: REVERSE,
});
const REVERSE_FIELD = field(REVERSE, {
  name: 'Orders',
  type: 'link',
  table_id: CUSTOMERS,
  options: {
    link_table: ORDERS,
    bidirectional: true,
    allow_multiple: true,
    record_filter: null,
    symmetric_field_id: LINK,
  },
});

function preview(overrides: Partial<ConvertFieldPreview> = {}): ConvertFieldPreview {
  return {
    allowed: true,
    reason: null,
    kind: 'keep',
    requires_confirm: false,
    requires_accept_data_loss: false,
    unique_values_reset: false,
    affected: 5000,
    lost: 0,
    truncated: 0,
    new_options: [],
    samples: [],
    dependents: [],
    ...overrides,
  };
}

const list = (items: readonly unknown[]) =>
  json({ items, total: items.length, offset: 0, limit: 1000 });
const table = (id: string, name: string, primary: string) => ({
  id,
  base_id: BASE,
  name,
  description: null,
  primary_field_id: primary,
  position: 0,
  schema_state: 'ready',
  created_at: NOW,
  updated_at: NOW,
});

type Route = (init: RequestInit | undefined) => Response;

async function renderTools(
  request: FieldToolRequest,
  fields: FieldDto[],
  routes: Record<string, Route> = {},
  access: Record<string, unknown> = { is_admin: true, tables: {} },
) {
  const tables = [
    table(ORDERS, 'Orders', TITLE.id),
    table(CUSTOMERS, 'Customers', 'fld_Name000000000001'),
  ];
  const base = {
    id: BASE,
    workspace_id: 'wsp_Main000000000001',
    organization_id: ORG,
    name: 'Sales',
    permission_version: 1,
    access,
  };
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      [`GET /tables/${ORDERS}`]: () => json(tables[0]),
      [`GET /tables/${CUSTOMERS}`]: () => json(tables[1]),
      [`GET /bases/${BASE}`]: () => json(base),
      [`GET /bases/${BASE}/tables`]: () => list(tables),
      [`GET /tables/${CUSTOMERS}/fields`]: () => list([REVERSE_FIELD]),
      [`POST /tables/${ORDERS}/records/query`]: () =>
        json({
          records: [
            {
              id: REC1,
              fields: { [TITLE.id]: 'Order 1' },
              version: 1,
              created_at: NOW,
              updated_at: NOW,
            },
            {
              id: REC2,
              fields: { [TITLE.id]: 'Order 2' },
              version: 1,
              created_at: NOW,
              updated_at: NOW,
            },
          ],
          offset: 0,
          limit: 2,
        }),
      ...routes,
    },
  });
  const queryClient = createQueryClient();
  queryClient.setQueryData(keys.tableMeta(ORDERS), tables[0]);
  queryClient.setQueryData(keys.base(BASE), base);
  queryClient.setQueryData(keys.tables(BASE), { items: tables, total: 2, offset: 0, limit: 1000 });
  const onClose = vi.fn();
  const i18n = await createTestI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <FieldTools tableId={ORDERS} fields={fields} request={request} onClose={onClose} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  const dialog = await screen.findByRole('dialog');
  return { fetchMock, onClose, dialog };
}

function bodiesOf(fetchMock: ReturnType<typeof stubApi>, method: string, path: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => (init?.method ?? 'GET') === method && url.startsWith(`/api/v1${path}`))
    .map(([, init]) => JSON.parse(init?.body as string) as unknown);
}

afterEach(() => {
  clearToasts();
});

describe('type change dialog (T414)', () => {
  it('previews text → number: counts, samples, a box to tick, then PUT with confirm', async () => {
    const { fetchMock, onClose, dialog } = await renderTools(
      { kind: 'edit', fieldId: CODE },
      [TITLE, CODE_FIELD],
      {
        [`POST /fields/${CODE}/convert-preview`]: () =>
          json(
            preview({
              lost: 12,
              requires_confirm: true,
              samples: [
                { record_id: REC1, from: 'abc', to: null, outcome: 'lost' },
                { record_id: REC2, from: '42', to: 42, outcome: 'kept' },
              ],
            }),
          ),
        [`PUT /fields/${CODE}`]: () =>
          json({ job_id: 'job_0000000000000001', field: { ...CODE_FIELD, conversion: null } }, 202),
      },
    );
    await userEvent.selectOptions(within(dialog).getByLabelText('Field type'), 'number');
    const pane = await within(dialog).findByTestId('conversion-pane');
    await within(pane).findByTestId('stat-lost');
    expect(within(pane).getByTestId('stat-lost')).toHaveTextContent('12values will be lost');
    expect(within(pane).getByTestId('stat-affected')).toHaveTextContent('5,000');
    const samples = within(pane).getByTestId('conversion-samples');
    expect(await within(samples).findByText('Order 1')).toBeInTheDocument();
    expect(within(samples).getByText('Empty')).toBeInTheDocument();
    expect(bodiesOf(fetchMock, 'POST', `/fields/${CODE}/convert-preview`).at(-1)).toMatchObject({
      type: 'number',
    });

    const submit = within(dialog).getByRole('button', { name: 'Change type' });
    expect(submit).toBeDisabled();
    await userEvent.click(within(pane).getByLabelText('I understand 12 values will be removed'));
    expect(submit).toBeEnabled();
    expect(await axeViolations(dialog)).toEqual([]);
    await userEvent.click(submit);
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodiesOf(fetchMock, 'PUT', `/fields/${CODE}`)).toEqual([
      expect.objectContaining({ type: 'number', confirm: true }),
    ]);
  });

  it('lists the types a field can never become, disabled with the reason', async () => {
    const { dialog } = await renderTools({ kind: 'edit', fieldId: CODE }, [TITLE, CODE_FIELD]);
    const select = within(dialog).getByLabelText('Field type');
    const created = within(select).getByRole('option', {
      name: 'Created time — filled in automatically',
    });
    expect(created).toBeDisabled();
    expect(
      within(select).getByRole('option', {
        name: 'Link to another table — create a new field instead',
      }),
    ).toBeDisabled();
    expect(within(select).getByRole('option', { name: 'Number' })).toBeEnabled();
    expect(within(dialog).getByTestId('type-current')).toHaveTextContent('Text');
  });

  it('a type that cannot hold the values asks to accept losing all of them', async () => {
    const { fetchMock, dialog } = await renderTools(
      { kind: 'edit', fieldId: CODE },
      [TITLE, CODE_FIELD],
      {
        [`POST /fields/${CODE}/convert-preview`]: () =>
          json(preview({ kind: 'blacklist', affected: 30, requires_accept_data_loss: true })),
        [`PUT /fields/${CODE}`]: () => json({ job_id: null, field: CODE_FIELD }, 202),
      },
    );
    await userEvent.selectOptions(within(dialog).getByLabelText('Field type'), 'user');
    const notice = await within(dialog).findByTestId('conversion-data-loss');
    expect(notice).toHaveTextContent('All 30 values of the column will be removed.');
    await userEvent.click(within(notice).getByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change type' }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'PUT', `/fields/${CODE}`)).toEqual([
        expect.objectContaining({ type: 'user', accept_data_loss: true }),
      ]);
    });
  });

  it('refused conversions cannot be sent', async () => {
    const { dialog } = await renderTools({ kind: 'edit', fieldId: CODE }, [TITLE, CODE_FIELD], {
      [`POST /fields/${CODE}/convert-preview`]: () =>
        json(preview({ allowed: false, reason: 'TOO_MANY_OPTIONS' })),
    });
    await userEvent.selectOptions(within(dialog).getByLabelText('Field type'), 'select');
    expect(await within(dialog).findByTestId('conversion-refused')).toHaveTextContent(
      'It would need more than 1,000 options.',
    );
    expect(within(dialog).getByRole('button', { name: 'Change type' })).toBeDisabled();
  });

  it('select several → one previews the cut values', async () => {
    const tags = field('fld_Tags000000000001', {
      name: 'Tags',
      type: 'select',
      options: { multiple: true, options: [{ id: 'opt_A000000000000001', name: 'A', color: 1 }] },
    });
    const { dialog } = await renderTools({ kind: 'edit', fieldId: tags.id }, [TITLE, tags], {
      [`POST /fields/${tags.id}/convert-preview`]: () =>
        json(
          preview({
            kind: 'truncate',
            truncated: 4,
            requires_confirm: true,
            samples: [{ record_id: REC1, from: ['A', 'B'], to: 'A', outcome: 'truncated' }],
          }),
        ),
    });
    await userEvent.click(within(dialog).getByLabelText('Allow several options per record'));
    const confirm = await within(dialog).findByTestId('conversion-confirm');
    expect(confirm).toHaveTextContent('4 cells will be cut');
    expect(within(dialog).getByTestId('conversion-samples')).toHaveTextContent('A, B');
  });

  it('email style: counts the cells in the wrong format, saves with PATCH', async () => {
    const { fetchMock, onClose, dialog } = await renderTools(
      { kind: 'edit', fieldId: CODE },
      [TITLE, CODE_FIELD],
      {
        [`POST /fields/${CODE}/convert-preview`]: () =>
          json(
            preview({
              kind: 'none',
              affected: 40,
              invalid: 23,
              samples: [
                { record_id: REC1, from: 'an.phat@gmail', to: 'an.phat@gmail', outcome: 'invalid' },
              ],
            }),
          ),
        [`PATCH /fields/${CODE}`]: () => json({ ...CODE_FIELD, job_id: null }),
      },
    );
    await userEvent.selectOptions(within(dialog).getByLabelText('Style'), 'email');
    const stat = await within(dialog).findByTestId('stat-invalid');
    expect(stat).toHaveTextContent('23cells are not valid emails');
    expect(within(dialog).getByText('No value is removed.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodiesOf(fetchMock, 'PATCH', `/fields/${CODE}`)).toEqual([
      { options: { style: { type: 'email' }, default_value: null } },
    ]);
    expect(bodiesOf(fetchMock, 'PUT', `/fields/${CODE}`)).toEqual([]);
  });

  it('a field being converted cannot be changed meanwhile', async () => {
    const converting = {
      ...CODE_FIELD,
      conversion: {
        job_id: 'job_0000000000000001' as const,
        status: 'running' as const,
        from_type: 'text' as const,
        to_type: 'number' as const,
        revertible_until: '2026-10-03T00:00:00.000Z',
      },
    };
    const { dialog } = await renderTools({ kind: 'edit', fieldId: CODE }, [TITLE, converting]);
    expect(within(dialog).getByTestId('field-converting')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('link conversions (T415)', () => {
  it('turns on two-way with the reverse name, previews the over-limit records', async () => {
    const { fetchMock, dialog } = await renderTools(
      { kind: 'edit', fieldId: LINK },
      [TITLE, linkField()],
      {
        [`POST /fields/${LINK}/convert-preview`]: () =>
          json(
            preview({
              affected: 4812,
              over_limit: 3,
              over_limit_samples: [{ record_id: 'rec_0000000000000009', links: 512 }],
              link_change: {
                change: 'to_two_way',
                partner_table_id: CUSTOMERS,
                partner_field_id: null,
              },
            }),
          ),
        [`PUT /fields/${LINK}`]: () =>
          json({ job_id: 'job_0000000000000002', field: linkField() }, 202),
      },
    );
    expect(within(dialog).getByTestId('type-locked')).toHaveTextContent('Link to another table');
    await userEvent.click(within(dialog).getByRole('switch', { name: 'Two-way link' }));
    const name = within(dialog).getByLabelText('Field name in Customers');
    expect(name).toHaveValue('Orders');
    await userEvent.clear(name);
    await userEvent.type(name, 'Đơn hàng');
    expect(await within(dialog).findByTestId('over-limit-notice')).toHaveTextContent(
      '3 records of Customers have more than 500 links.',
    );
    expect(within(dialog).getByText('Changed')).toBeInTheDocument();
    expect(await axeViolations(dialog)).toEqual([]);
    const submit = within(dialog).getByRole('button', { name: 'Turn on two-way' });
    await waitFor(() => {
      expect(submit).toBeEnabled();
    });
    await userEvent.click(submit);
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'PUT', `/fields/${LINK}`)).toEqual([
        {
          type: 'link',
          options: { bidirectional: true, bidirectional_link_field_name: 'Đơn hàng' },
        },
      ]);
    });
  });

  it('two-way is locked without schema rights on the linked table', async () => {
    const { dialog } = await renderTools(
      { kind: 'edit', fieldId: LINK },
      [TITLE, linkField()],
      {},
      {
        is_admin: false,
        tables: {
          [ORDERS]: { perm: 'manage', operations: [], fields: {} },
          [CUSTOMERS]: { perm: 'read', operations: [], fields: {} },
        },
      },
    );
    const toggle = within(dialog).getByRole('switch', { name: 'Two-way link' });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription(
      'Needs the right to change the structure of Customers too; ask a base admin.',
    );
  });

  it('several → one record previews the links that go', async () => {
    const { fetchMock, dialog } = await renderTools(
      { kind: 'edit', fieldId: LINK },
      [TITLE, linkField()],
      {
        [`POST /fields/${LINK}/convert-preview`]: () =>
          json(
            preview({
              kind: 'truncate',
              affected: 20,
              truncated: 7,
              requires_confirm: true,
              samples: [
                {
                  record_id: REC1,
                  from: [
                    { id: 'rec_0000000000000011', title: 'An Phát' },
                    { id: 'rec_0000000000000012', title: 'Bình Minh' },
                  ],
                  to: { id: 'rec_0000000000000011', title: 'An Phát' },
                  outcome: 'truncated',
                },
              ],
              link_change: {
                change: 'to_single',
                partner_table_id: CUSTOMERS,
                partner_field_id: null,
              },
            }),
          ),
        [`PUT /fields/${LINK}`]: () =>
          json({ job_id: 'job_0000000000000003', field: linkField() }, 202),
      },
    );
    await userEvent.click(within(dialog).getByRole('switch', { name: 'Allow several records' }));
    const confirm = await within(dialog).findByTestId('conversion-confirm');
    expect(confirm).toHaveTextContent('7 cells will keep only their first link.');
    expect(within(dialog).getByTestId('stat-truncated')).toHaveTextContent('7');
    expect(within(dialog).getByTestId('conversion-samples')).toHaveTextContent(
      'An Phát, Bình Minh',
    );
    await userEvent.click(within(confirm).getByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep one record' }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'PUT', `/fields/${LINK}`)).toEqual([
        { type: 'link', options: { allow_multiple: false }, confirm: true },
      ]);
    });
  });

  it('turning off two-way asks which side stays, lists dependents, red confirm', async () => {
    const { fetchMock, onClose, dialog } = await renderTools(
      { kind: 'edit', fieldId: LINK },
      [TITLE, TWO_WAY],
      {
        [`POST /fields/${LINK}/convert-preview`]: () =>
          json(
            preview({
              requires_confirm: true,
              affected: 200,
              dependents: [{ type: 'view', id: 'viw_Vip0000000000001' }],
              link_change: {
                change: 'to_one_way',
                partner_table_id: CUSTOMERS,
                partner_field_id: REVERSE,
              },
            }),
          ),
        [`POST /fields/${REVERSE}/convert-preview`]: () =>
          json(
            preview({
              affected: 200,
              link_change: {
                change: 'to_one_way',
                partner_table_id: ORDERS,
                partner_field_id: LINK,
              },
            }),
          ),
        [`GET /tables/${CUSTOMERS}/views`]: () =>
          list([{ id: 'viw_Vip0000000000001', name: 'VIP this month', table_id: CUSTOMERS }]),
        [`PUT /fields/${REVERSE}`]: () =>
          json({ job_id: 'job_0000000000000004', field: REVERSE_FIELD }, 202),
      },
    );
    await userEvent.click(within(dialog).getByRole('switch', { name: 'Two-way link' }));
    const oneWay = await screen.findByRole('dialog', { name: /Turn off two-way link/u });
    const dependents = await within(oneWay).findByTestId('conversion-dependents');
    expect(dependents).toHaveTextContent('View filter, sort, group or form');
    const submit = within(oneWay).getByTestId('disable-two-way');
    expect(submit).toBeDisabled();
    await userEvent.click(within(oneWay).getByLabelText('I understand the item above will break'));
    expect(submit).toBeEnabled();
    expect(await axeViolations(oneWay)).toEqual([]);
    // Keeping the other side: its own preview, no dependents, PUT on that field.
    await userEvent.click(within(oneWay).getByLabelText('Keep “Orders” in Customers'));
    await waitFor(() => {
      expect(within(oneWay).queryByTestId('conversion-dependents')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(submit).toBeEnabled();
    });
    await userEvent.click(submit);
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodiesOf(fetchMock, 'PUT', `/fields/${REVERSE}`)).toEqual([
      { type: 'link', options: { bidirectional: false } },
    ]);
  });

  it('cancel keeps two-way on and goes back to the field dialog', async () => {
    const { dialog } = await renderTools({ kind: 'edit', fieldId: LINK }, [TITLE, TWO_WAY], {
      [`POST /fields/${LINK}/convert-preview`]: () => json(preview()),
    });
    await userEvent.click(within(dialog).getByRole('switch', { name: 'Two-way link' }));
    const oneWay = await screen.findByRole('dialog', { name: /Turn off two-way link/u });
    await userEvent.click(within(oneWay).getByRole('button', { name: 'Cancel' }));
    const back = await screen.findByRole('dialog', { name: 'Edit field' });
    expect(within(back).getByRole('switch', { name: 'Two-way link' })).toBeChecked();
    expect(within(back).getByText('Reverse field: “Orders” in Customers.')).toBeInTheDocument();
  });
});

describe('undo a type change (T414, decision #7)', () => {
  const CONVERTED = {
    ...CODE_FIELD,
    type: 'number' as const,
    options: {},
    conversion: {
      job_id: 'job_0000000000000001' as const,
      status: 'succeeded' as const,
      from_type: 'text' as const,
      to_type: 'number' as const,
      revertible_until: '2099-10-03T14:05:00.000Z',
    },
  };
  const revertPreview = {
    job_id: 'job_0000000000000001',
    from_type: 'text',
    revertible_until: '2099-10-03T14:05:00.000Z',
    unchanged: 4990,
    edited: 10,
    edited_unconvertible: 0,
    new_field_available: true,
    samples: [],
  };

  it('keeps later edits by default, overwrites only when chosen with the count', async () => {
    const { fetchMock, onClose, dialog } = await renderTools(
      { kind: 'revert', fieldId: CODE },
      [TITLE, CONVERTED],
      {
        [`POST /fields/${CODE}/revert-conversion/preview`]: () => json(revertPreview),
        [`POST /fields/${CODE}/revert-conversion`]: () => json(CODE_FIELD),
      },
    );
    expect(await within(dialog).findByTestId('revert-unchanged')).toHaveTextContent('4,990');
    expect(within(dialog).getByTestId('revert-edited')).toHaveTextContent('10');
    expect(within(dialog).getByLabelText('Keep the later edits (recommended)')).toBeChecked();
    expect(await axeViolations(dialog)).toEqual([]);
    await userEvent.click(within(dialog).getByLabelText('Overwrite the later edits'));
    const submit = within(dialog).getByTestId('revert-submit');
    expect(submit).toBeDisabled();
    await userEvent.click(
      within(dialog).getByLabelText('I understand 10 new values will be overwritten'),
    );
    await userEvent.click(submit);
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodiesOf(fetchMock, 'POST', `/fields/${CODE}/revert-conversion`).at(-1)).toEqual({
      mode: 'overwrite_later_edits',
      confirm: true,
    });
  });

  it('restores as a new field under a chosen name', async () => {
    const { fetchMock, dialog } = await renderTools(
      { kind: 'revert', fieldId: CODE },
      [TITLE, CONVERTED],
      {
        [`POST /fields/${CODE}/revert-conversion/preview`]: () => json(revertPreview),
        [`POST /fields/${CODE}/revert-conversion`]: () =>
          json(field('fld_Old0000000000001', { name: 'Code (old version)' })),
      },
    );
    await userEvent.click(
      await within(dialog).findByLabelText('Restore as a new field (old version)'),
    );
    expect(within(dialog).getByLabelText('Name of the new field')).toHaveValue(
      'Code (old version)',
    );
    await userEvent.click(within(dialog).getByTestId('revert-submit'));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'POST', `/fields/${CODE}/revert-conversion`).at(-1)).toEqual({
        mode: 'new_field',
        name: 'Code (old version)',
      });
    });
  });

  it('says when the 7 days are over', async () => {
    const { dialog } = await renderTools({ kind: 'revert', fieldId: CODE }, [TITLE, CONVERTED], {
      [`POST /fields/${CODE}/revert-conversion/preview`]: () => problem('NOT_FOUND', 404),
    });
    expect(await within(dialog).findByTestId('revert-expired')).toBeInTheDocument();
    expect(within(dialog).queryByTestId('revert-submit')).not.toBeInTheDocument();
  });
});
