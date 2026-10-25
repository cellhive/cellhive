import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, stubApi } from '../../../test/app-harness';
import { axeViolations } from '../../../test/axe';
import { createTestI18n } from '../../../test/i18n';
import { FieldTools } from '../../features/field/components/FieldTools';
import { LookupFieldEditor } from '../../features/lookup/components/LookupFieldEditor';
import { LookupConditionEditor } from '../../features/view/toolbar/LookupConditionEditor';
import { createQueryClient } from '../../lib/query/client';
import { keys } from '../../lib/query/keys';
import { clearToasts } from '../../lib/toast/toast';

import type { FieldToolRequest } from '../../lib/schema/field-tools';
import type { LookupFieldEditorProps } from '../../lib/schema/lookup-tools';
import type { FieldDto } from '@cellhive/contracts';

/*
 * The lookup dialog (T467) as the route wires it: the field tools of
 * `features/field`, the lookup configuration of `features/lookup` and the
 * condition editor of `features/view/toolbar`. Customers looks up the
 * orders linking to each customer (Orders.customer is a one-way link to
 * Customers, as in the demo seed).
 */

const NOW = '2026-09-28T00:00:00.000Z';
const BASE = 'bse_Sales00000000001';
const ORG = 'org_Demo000000000001';
const CUSTOMERS = 'tbl_Customers0000001';
const ORDERS = 'tbl_Orders0000000001';
const DONE = 'opt_Done000000000001';
const OPEN = 'opt_Open000000000001';
const REC1 = 'rec_0000000000000001';
const REC2 = 'rec_0000000000000002';

function field(id: string, tableId: string, overrides: Partial<FieldDto> = {}): FieldDto {
  return {
    id,
    table_id: tableId,
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

const NAME = field('fld_Name000000000001', CUSTOMERS, {
  name: 'Customer name',
  is_primary: true,
  position: 0,
});
const TITLE = field('fld_Title00000000001', ORDERS, {
  name: 'Order',
  is_primary: true,
  position: 0,
});
const AMOUNT = field('fld_Amount0000000001', ORDERS, {
  name: 'Amount',
  type: 'number',
  options: { style: { type: 'currency', currency_code: 'VND' } },
});
const STATUS = field('fld_Status0000000001', ORDERS, {
  name: 'Status',
  type: 'select',
  options: {
    multiple: false,
    options: [
      { id: OPEN, name: 'Open', color: 0 },
      { id: DONE, name: 'Done', color: 1 },
    ],
  },
});
const CUSTOMER = field('fld_Customer00000001', ORDERS, {
  name: 'Customer',
  type: 'link',
  options: {
    link_table: CUSTOMERS,
    bidirectional: false,
    allow_multiple: false,
    record_filter: null,
    symmetric_field_id: null,
  },
});
const ORDER_FIELDS = [TITLE, AMOUNT, STATUS, CUSTOMER];
const LOOKUP_ID = 'fld_Total00000000001';

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
const TABLES = [table(CUSTOMERS, 'Customers', NAME.id), table(ORDERS, 'Orders', TITLE.id)];

const PREVIEW = {
  result_type: { kind: 'number', list: false },
  compute_mode: 'stored',
  style: { type: 'currency', currency_code: 'VND' },
  perf_warning: null,
  records: [
    { id: REC1, value: 1_500_000 },
    { id: REC2, value: null },
  ],
};

const MILESTONE_OPTIONS = {
  from: ORDERS,
  select: AMOUNT.id,
  where: {
    op: 'and',
    items: [
      { field: CUSTOMER.id, operator: 'has_any_of', value: { field_ref: '__id' } },
      { field: STATUS.id, operator: 'is', value: DONE },
    ],
  },
  aggregate: 'sum',
  style: { type: 'currency', currency_code: 'VND' },
};

type Route = (init: RequestInit | undefined) => Response;

function LookupEditor(props: LookupFieldEditorProps) {
  return <LookupFieldEditor {...props} WhereEditor={LookupConditionEditor} />;
}

async function renderTools(
  request: FieldToolRequest,
  own: FieldDto[],
  routes: Record<string, Route> = {},
) {
  const base = {
    id: BASE,
    workspace_id: 'wsp_Main000000000001',
    organization_id: ORG,
    name: 'Sales',
    permission_version: 1,
    access: { is_admin: true, tables: {} },
  };
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      [`GET /tables/${CUSTOMERS}`]: () => json(TABLES[0]),
      [`GET /tables/${ORDERS}`]: () => json(TABLES[1]),
      [`GET /bases/${BASE}`]: () => json(base),
      [`GET /bases/${BASE}/tables`]: () => list(TABLES),
      [`GET /tables/${CUSTOMERS}/fields`]: () => list(own),
      [`GET /tables/${ORDERS}/fields`]: () => list(ORDER_FIELDS),
      [`GET /orgs/${ORG}`]: () =>
        json({
          id: ORG,
          name: 'Demo',
          slug: 'demo',
          settings: { locale: 'en', timezone: 'UTC', currency: 'USD', public_sharing: 'allowed' },
          role: 'owner',
          created_at: NOW,
        }),
      [`POST /tables/${CUSTOMERS}/records/query`]: () =>
        json({
          records: [
            {
              id: REC1,
              fields: { [NAME.id]: 'An Phát' },
              version: 1,
              created_at: NOW,
              updated_at: NOW,
            },
            {
              id: REC2,
              fields: { [NAME.id]: 'Hoà Bình' },
              version: 1,
              created_at: NOW,
              updated_at: NOW,
            },
          ],
          total: 2,
          offset: 0,
          limit: 2,
        }),
      [`POST /tables/${CUSTOMERS}/computed-preview`]: () => json(PREVIEW),
      ...routes,
    },
  });
  const queryClient = createQueryClient();
  queryClient.setQueryData(keys.tableMeta(CUSTOMERS), TABLES[0]);
  const onClose = vi.fn();
  const i18n = await createTestI18n('en');
  const view = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <FieldTools
          tableId={CUSTOMERS}
          fields={own}
          request={request}
          onClose={onClose}
          LookupEditor={LookupEditor}
        />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  const dialog = await screen.findByRole('dialog');
  return { fetchMock, onClose, dialog, view };
}

function bodiesOf(fetchMock: ReturnType<typeof stubApi>, method: string, path: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => (init?.method ?? 'GET') === method && url.startsWith(`/api/v1${path}`))
    .map(([, init]) => JSON.parse(init?.body as string) as unknown);
}

afterEach(() => {
  clearToasts();
});

describe('lookup dialog (T467)', () => {
  it('creates the milestone lookup through a link field, with a live preview', async () => {
    const user = userEvent.setup();
    const { fetchMock, onClose, dialog } = await renderTools({ kind: 'create' }, [NAME], {
      [`POST /tables/${CUSTOMERS}/fields`]: () =>
        json(field(LOOKUP_ID, CUSTOMERS, { type: 'lookup', options: MILESTONE_OPTIONS }), 201),
    });
    await user.type(within(dialog).getByLabelText('Name'), 'Total of done orders');
    await user.selectOptions(within(dialog).getByLabelText('Field type'), 'lookup');

    const editor = await screen.findByTestId('lookup-editor');
    // The preview waits for a complete definition.
    expect(within(editor).getByText(/Choose the source table, the field to get/)).toBeTruthy();

    // Shortcut: the one-way link Orders.customer points at Customers.
    const shortcut = await within(editor).findByLabelText('Shortcut: through a link field');
    await user.selectOptions(shortcut, `in:${CUSTOMER.id}`);
    expect(within(editor).getByTestId('lookup-shortcut').textContent).toContain('Customer');
    expect(within(editor).getByLabelText('Source table')).toHaveProperty('value', ORDERS);
    const [first] = within(editor).getAllByTestId('lookup-condition');
    if (first === undefined) throw new Error('no condition');
    // Labelled with the filter wording, never "intersects".
    expect(within(first).getByLabelText('Operator for Customer')).toHaveProperty(
      'value',
      'has_any_of',
    );
    expect(within(first).getByRole('option', { name: 'has any of' })).toBeTruthy();
    expect(within(first).getByTestId('lookup-condition-value')).toHaveProperty('value', '__id');
    expect(within(first).getByText('auto')).toBeTruthy();

    await user.selectOptions(await within(editor).findByLabelText('Field to get'), AMOUNT.id);
    const aggregate = within(editor).getByLabelText('Show as');
    // Only the aggregations valid for a number.
    expect(
      within(aggregate)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Values',
      'Unique values',
      'Sum',
      'Average',
      'Largest',
      'Smallest',
      'Count',
      'Count unique',
    ]);
    await user.selectOptions(aggregate, 'sum');
    expect(
      within(editor).getByLabelText('Format').querySelector('option:checked')?.textContent,
    ).toBe('Currency VND (as the source)');

    // Second condition: Status is Done.
    await user.click(within(editor).getByRole('button', { name: 'Add condition' }));
    const rows = within(editor).getAllByTestId('lookup-condition');
    const second = rows[1];
    if (second === undefined) throw new Error('no second condition');
    await user.selectOptions(within(second).getByLabelText('Field of condition 2'), STATUS.id);
    await user.selectOptions(within(second).getByLabelText('Value for Status'), DONE);
    expect(within(editor).getByText('2 / 5')).toBeTruthy();

    // The server preview (debounced) of the complete definition.
    await waitFor(
      () => {
        expect(within(editor).getAllByTestId('lookup-preview-value')[0]?.textContent).toContain(
          '1,500,000',
        );
      },
      { timeout: 3000 },
    );
    expect(await within(editor).findByText('An Phát')).toBeTruthy();
    expect(within(editor).getByTestId('lookup-compute-mode').textContent).toMatch(/stored/);
    const previews = bodiesOf(fetchMock, 'POST', `/tables/${CUSTOMERS}/computed-preview`);
    expect(previews.at(-1)).toEqual({ type: 'lookup', options: MILESTONE_OPTIONS });

    expect(await axeViolations(document.body)).toEqual([]);

    await user.click(within(editor).getByTestId('lookup-save'));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodiesOf(fetchMock, 'POST', `/tables/${CUSTOMERS}/fields`)).toEqual([
      { name: 'Total of done orders', type: 'lookup', options: MILESTONE_OPTIONS },
    ]);
  });

  it('asks for the missing parts instead of saving', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await renderTools({ kind: 'create' }, [NAME]);
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Field type'), 'lookup');
    const editor = await screen.findByTestId('lookup-editor');
    await user.click(within(editor).getByTestId('lookup-save'));
    expect(within(editor).getAllByText('Required.').length).toBeGreaterThanOrEqual(2);
    await user.selectOptions(within(editor).getByLabelText('Source table'), ORDERS);
    await user.click(within(editor).getByTestId('lookup-save'));
    expect(within(editor).getByText(/Add at least one condition/)).toBeTruthy();
    expect(bodiesOf(fetchMock, 'POST', `/tables/${CUSTOMERS}/fields`)).toEqual([]);
  });

  it('edits a saved lookup: stored intersects reads as "has any of", PATCH sends what changed', async () => {
    const user = userEvent.setup();
    const saved = field(LOOKUP_ID, CUSTOMERS, {
      name: 'Total',
      type: 'lookup',
      options: {
        ...MILESTONE_OPTIONS,
        where: {
          op: 'and',
          items: [{ field: CUSTOMER.id, operator: 'intersects', value: { field_ref: '__id' } }],
        },
      },
      result_type: { kind: 'number', list: false },
      compute_mode: 'stored',
      compute_state: 'ready',
      compute_error: null,
    });
    const { fetchMock, onClose } = await renderTools(
      { kind: 'edit', fieldId: LOOKUP_ID },
      [NAME, saved],
      {
        [`PATCH /fields/${LOOKUP_ID}`]: () => json({ ...saved, job_id: null }),
      },
    );
    const editor = await screen.findByTestId('lookup-editor');
    const [row] = await within(editor).findAllByTestId('lookup-condition');
    if (row === undefined) throw new Error('no condition');
    await waitFor(() => {
      expect(within(row).getByLabelText('Operator for Customer')).toHaveProperty(
        'value',
        'has_any_of',
      );
    });
    // T469: a saved lookup can change type ("convert to static values").
    expect(within(editor).getByTestId('type-current').textContent).toContain('Lookup');
    expect(within(editor).getByTestId('convert-to-static').textContent).toContain('Number');
    await user.selectOptions(within(editor).getByLabelText('Show as'), 'average');
    await user.click(within(editor).getByTestId('lookup-save'));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodiesOf(fetchMock, 'PATCH', `/fields/${LOOKUP_ID}`)).toEqual([
      {
        options: {
          where: {
            op: 'and',
            items: [{ field: CUSTOMER.id, operator: 'has_any_of', value: { field_ref: '__id' } }],
          },
          aggregate: 'average',
        },
      },
    ]);
  });

  it('shows the chain of a reference cycle', async () => {
    const user = userEvent.setup();
    const { dialog } = await renderTools({ kind: 'create' }, [NAME], {
      [`POST /tables/${CUSTOMERS}/computed-preview`]: () =>
        new Response(
          JSON.stringify({
            type: 'https://cellhive.io/errors/FORMULA_CYCLE',
            title: 'FORMULA_CYCLE',
            status: 422,
            code: 'FORMULA_CYCLE',
            errors: [
              {
                path: 'options',
                code: 'CIRCULAR_REFERENCE',
                message: 'cycle',
                params: {
                  cycle: [
                    { id: LOOKUP_ID, name: 'Total', table_id: CUSTOMERS },
                    { id: AMOUNT.id, name: 'Amount', table_id: ORDERS },
                    { id: LOOKUP_ID, name: 'Total', table_id: CUSTOMERS },
                  ],
                  position: { start: 0, length: 0 },
                },
              },
            ],
          }),
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
    });
    await user.type(within(dialog).getByLabelText('Name'), 'Total');
    await user.selectOptions(within(dialog).getByLabelText('Field type'), 'lookup');
    const editor = await screen.findByTestId('lookup-editor');
    await user.selectOptions(
      await within(editor).findByLabelText('Shortcut: through a link field'),
      `in:${CUSTOMER.id}`,
    );
    await user.selectOptions(await within(editor).findByLabelText('Field to get'), AMOUNT.id);
    const cycle = await screen.findByTestId('lookup-cycle', {}, { timeout: 3000 });
    expect(within(cycle).getByText(/depend on itself/)).toBeTruthy();
    const steps = within(cycle)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(steps).toEqual(['Total · Customers', 'Amount · Orders', 'Total · Customers']);
    expect(screen.getByTestId('lookup-preview-error').textContent).toMatch(/cannot be computed/);
  });
});
