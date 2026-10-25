import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, problem } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { readLinkRecents } from '../../../lib/links/recent';
import { LinkPicker } from '../components/LinkPicker';
import { DisplayLine } from '../components/parts';

import type { LinkPickerProps } from '../../../lib/links/picker';
import type { LinkRef } from '../../../lib/links/values';
import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-25T00:00:00.000Z';
const BASE = 'bse_Sales00000000001';
const ORG = 'org_Demo000000000001';
const USER = 'usr_Admin00000000001';
const ORDERS = 'tbl_Orders0000000001';
const CUSTOMERS = 'tbl_Customers0000001';
const FIELD = 'fld_Customer00000001';
const NAME = 'fld_Name000000000001';
const TIER = 'fld_Tier000000000001';
const ORDER = 'rec_Order00000000001';

/** A base admin: may add records to the linked table (CONTRACTS §5A). */
const ADMIN = {
  is_admin: true,
  tables: { [CUSTOMERS]: { perm: 'manage', operations: ['add', 'delete'], fields: {} } },
} as unknown as LinkPickerProps['access'];
const rec = (n: number) => `rec_${String(n).padStart(16, '0')}`;
const CUSTOMER_NAMES = [
  'Cửa hàng An Phát',
  'Siêu thị mini Hoà Bình',
  'Quán cà phê Lá Xanh',
  'Nhà thuốc Minh Châu',
];

function fieldDto(id: string, name: string, type: string, extra: Partial<FieldDto> = {}): FieldDto {
  return {
    id,
    table_id: CUSTOMERS,
    name,
    type: type as FieldDto['type'],
    options: {},
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  } as FieldDto;
}

const linkField = fieldDto(FIELD, 'Customer', 'link', {
  table_id: ORDERS,
  options: { link_table: CUSTOMERS },
});

interface Server {
  readonly candidates: { body: Record<string, unknown> }[];
  readonly created: unknown[];
}

function serve(options: { total?: number; required?: boolean } = {}): Server {
  const names =
    options.total === undefined
      ? CUSTOMER_NAMES
      : Array.from({ length: options.total }, (_, index) => `Lô ${String(index + 1)}`);
  const items = names.map((title, index) => ({
    id: rec(index + 1),
    title,
    fields: { [TIER]: index % 2 === 0 ? 'Vàng' : 'Bạc' },
    linked: false,
    full: false,
    selectable: true,
  }));
  const server: Server = { candidates: [], created: [] };
  const fold = (text: string) =>
    text
      .normalize('NFD')
      .replace(/\p{Mn}/gu, '')
      .toLowerCase();
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const path = new URL(input, 'http://localhost').pathname.replace('/api/v1', '');
    const key = `${init?.method ?? 'GET'} ${path}`;
    switch (key) {
      case `GET /bases/${BASE}/tables`:
        return Promise.resolve(
          json({
            items: [
              {
                id: CUSTOMERS,
                base_id: BASE,
                name: 'Customers',
                description: null,
                primary_field_id: NAME,
                position: 0,
                schema_state: 'ready',
                created_at: NOW,
                updated_at: NOW,
              },
            ],
            total: 1,
            offset: 0,
            limit: 1000,
          }),
        );
      case `GET /tables/${CUSTOMERS}/fields`: {
        const fields = [
          fieldDto(NAME, 'Name', 'text', { is_primary: true }),
          fieldDto(TIER, 'Tier', 'select', {
            options: {
              multiple: false,
              options: [
                { id: 'opt_Gold000000000001', name: 'Vàng' },
                { id: 'opt_Silver0000000001', name: 'Bạc' },
              ],
            },
          }),
          ...(options.required === true
            ? [fieldDto('fld_Phone00000000001', 'Phone', 'text', { required: true })]
            : []),
        ];
        return Promise.resolve(
          json({ items: fields, total: fields.length, offset: 0, limit: 1000 }),
        );
      }
      case `POST /fields/${FIELD}/link-candidates`: {
        const body = JSON.parse(init?.body as string) as {
          search?: string | null;
          ids?: string[] | null;
          offset?: number;
          limit?: number;
        };
        server.candidates.push({ body });
        let found = items;
        if (body.ids !== undefined && body.ids !== null) {
          found = body.ids.flatMap((id) => items.filter((item) => item.id === id));
        }
        if (body.search !== undefined && body.search !== null) {
          const needle = fold(body.search);
          found = found.filter((item) => fold(item.title).includes(needle));
        }
        const offset = body.offset ?? 0;
        const limit = body.limit ?? 50;
        return Promise.resolve(
          json({
            items: found.slice(offset, offset + limit),
            fields: [{ id: TIER, name: 'Tier', type: 'select' }],
            offset,
            limit,
            has_more: offset + limit < found.length,
            cell: null,
          }),
        );
      }
      case `POST /tables/${CUSTOMERS}/records`: {
        const body = JSON.parse(init?.body as string) as { records: { fields: object }[] };
        server.created.push(body);
        return Promise.resolve(
          json(
            {
              records: [
                {
                  id: 'rec_New0000000000001',
                  created_at: NOW,
                  updated_at: NOW,
                  version: 1,
                  fields: body.records[0]?.fields ?? {},
                },
              ],
            },
            201,
          ),
        );
      }
      default:
        return Promise.resolve(problem('NOT_FOUND', 404));
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return server;
}

async function renderPicker(overrides: Partial<LinkPickerProps> = {}) {
  const i18n = await createTestI18n('en');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onCommit = vi.fn<(value: readonly LinkRef[]) => void>();
  const onClose = vi.fn();
  const props: LinkPickerProps = {
    access: null,
    baseId: BASE,
    orgId: ORG,
    userId: USER,
    field: linkField,
    options: {
      link_table: CUSTOMERS,
      bidirectional: false,
      bidirectional_link_field_name: null,
      allow_multiple: true,
      record_filter: null,
      symmetric_field_id: null,
    },
    recordId: ORDER,
    recordLabel: 'DH-0001',
    value: [],
    anchor: null,
    fullScreen: false,
    locale: { locale: 'en', timeZone: 'UTC' },
    onCommit,
    onClose,
    ...overrides,
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <LinkPicker {...props} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, onCommit, onClose };
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

describe('the multi-link dialog (T413, decision #1)', () => {
  it('chooses with the keyboard, reorders nothing, saves once with "Save N links"', async () => {
    serve();
    const user = userEvent.setup();
    const { onCommit, onClose } = await renderPicker({ value: [{ id: rec(4), title: null }] });
    const dialog = await screen.findByRole('dialog', { name: 'Link Customers' });
    expect(
      within(dialog).getByText('DH-0001 · field Customer, several records'),
    ).toBeInTheDocument();
    const options = await within(dialog).findAllByRole('option');
    expect(options).toHaveLength(4);
    // The display field, formatted: the tier of the customer.
    expect(options[0]).toHaveTextContent('Vàng');
    const search = within(dialog).getByRole('combobox');
    expect(search).toHaveFocus();
    // Space types in the search box: the hint says where it selects (T421a).
    expect(within(dialog).getByText('Enter select (Space in the list)')).toBeInTheDocument();
    await user.type(search, 'hoa binh');
    await waitFor(() => {
      expect(within(dialog).getAllByRole('option')).toHaveLength(1);
    });
    expect(within(dialog).getByText('Hoà Bình', { selector: 'mark' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(within(dialog).getByTestId('link-selected-count')).toHaveTextContent('2 / 500');
    // The locked record (P20) stays, first: it was there before.
    expect(
      within(dialog)
        .getAllByTestId('link-selected')
        .map((row) => row.textContent),
    ).toEqual(['No access', 'Siêu thị mini Hoà Bình']);
    expect(await axeViolations(dialog)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Save 2 links' }));
    expect(onCommit).toHaveBeenCalledWith([
      { id: rec(4), title: null },
      { id: rec(2), title: 'Siêu thị mini Hoà Bình' },
    ]);
    expect(onClose).toHaveBeenCalled();
    // Only the record ids of the new links are remembered (decision #2).
    expect(readLinkRecents({ userId: USER, orgId: ORG, fieldId: FIELD })).toEqual([rec(2)]);
  });

  it('"Selected" lists only the chosen records; "Recent" comes first when not searching', async () => {
    const server = serve();
    window.localStorage.setItem(
      `cellhive.linkRecent.${USER}.${ORG}.${FIELD}`,
      JSON.stringify([rec(3), 'rec_Gone000000000001']),
    );
    const user = userEvent.setup();
    await renderPicker({ value: [{ id: rec(1), title: 'Cửa hàng An Phát' }] });
    const dialog = await screen.findByRole('dialog', { name: 'Link Customers' });
    const recent = await within(dialog).findByRole('group', { name: 'Recent' });
    expect(
      within(recent)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([expect.stringContaining('Quán cà phê Lá Xanh')]);
    // A recent record the API no longer returns is forgotten.
    await waitFor(() => {
      expect(readLinkRecents({ userId: USER, orgId: ORG, fieldId: FIELD })).toEqual([rec(3)]);
    });
    await user.click(within(dialog).getByRole('button', { name: 'Selected 1' }));
    await waitFor(() => {
      expect(within(dialog).getAllByRole('option')).toHaveLength(1);
    });
    expect(server.candidates.at(-1)?.body).toMatchObject({ ids: [rec(1)] });
  });

  it('"Selected 0" shows the empty state, not a skeleton (T421a)', async () => {
    serve();
    const user = userEvent.setup();
    await renderPicker();
    const dialog = await screen.findByRole('dialog', { name: 'Link Customers' });
    await within(dialog).findAllByRole('option');
    await user.click(within(dialog).getByRole('button', { name: 'Selected 0' }));
    expect(await within(dialog).findByText('Nothing selected yet')).toBeInTheDocument();
    expect(within(dialog).queryByText('Loading records')).not.toBeInTheDocument();
  });

  it(
    'a full cell blocks adding and says so; select all is only for a complete search',
    { timeout: 30_000 },
    async () => {
      serve({ total: 12 });
      const user = userEvent.setup();
      const value = Array.from({ length: 500 }, (_, index) => ({
        id: `rec_Full${String(index).padStart(12, '0')}`,
        title: `Full ${String(index)}`,
      }));
      const { onCommit } = await renderPicker({ value });
      const dialog = await screen.findByRole('dialog', { name: 'Link Customers' });
      expect(within(dialog).getByText('The cell holds 500 links.')).toBeInTheDocument();
      const first = (await within(dialog).findAllByRole('option'))[0];
      if (first === undefined) throw new Error('no option');
      expect(first).toHaveAttribute('aria-disabled', 'true');
      await user.click(first);
      expect(first).toHaveAttribute('aria-selected', 'false');
      expect(within(dialog).getByTestId('link-selected-count')).toHaveTextContent('500 / 500');
      // Select all of a complete search result, blocked past the limit.
      await user.type(within(dialog).getByRole('combobox'), 'Lô 1');
      // A text query: role queries over 500 selected rows are slow under a full parallel run.
      const selectAll = await within(dialog).findByText(/^Select all/u, {}, { timeout: 15_000 });
      await user.click(selectAll);
      expect(within(dialog).getByTestId('link-selected-count')).toHaveTextContent('500 / 500');
      await user.keyboard('{Escape}');
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it('creates a record from the search and selects it', async () => {
    const server = serve();
    const user = userEvent.setup();
    await renderPicker({ access: ADMIN });
    const dialog = await screen.findByRole('dialog', { name: 'Link Customers' });
    await user.type(within(dialog).getByRole('combobox'), 'Khách mới');
    await within(dialog).findByText('Nothing in Customers matches “Khách mới”');
    await user.click(within(dialog).getAllByTestId('link-create').at(-1) as HTMLElement);
    await waitFor(() => {
      expect(within(dialog).getByTestId('link-selected-count')).toHaveTextContent('1 / 500');
    });
    expect(server.created).toEqual([{ records: [{ fields: { [NAME]: 'Khách mới' } }] }]);
  });

  it('asks for the required fields of the linked table in a short form', async () => {
    serve({ required: true });
    const user = userEvent.setup();
    await renderPicker({ access: ADMIN });
    const dialog = await screen.findByRole('dialog', { name: 'Link Customers' });
    await within(dialog).findAllByRole('option');
    await user.type(within(dialog).getByRole('combobox'), 'Mới');
    await user.click(within(dialog).getAllByTestId('link-create').at(-1) as HTMLElement);
    const form = await within(dialog).findByRole('form', { name: 'New Customers' });
    expect(within(form).getByLabelText('Name')).toHaveValue('Mới');
    await user.click(within(form).getByRole('button', { name: 'Create and link' }));
    expect(within(form).getByText('Required')).toBeInTheDocument();
  });
});

/** The scrolling box around the records of a picker. */
function scrollerOf(container: HTMLElement): HTMLElement | null {
  return within(container).getByRole('listbox').parentElement;
}

describe('the single-link popover and the phone sheet', () => {
  const single = {
    link_table: CUSTOMERS,
    bidirectional: false,
    bidirectional_link_field_name: null,
    allow_multiple: false,
    record_filter: { field: TIER, operator: 'is', value: 'opt_Gold000000000001' },
    symmetric_field_id: null,
  } as const;

  it('opens under the cell with the typed text; Enter chooses and closes', async () => {
    serve();
    const user = userEvent.setup();
    const { onCommit, onClose } = await renderPicker({
      options: single,
      anchor: { x: 100, y: 100, width: 200, height: 34 },
      initialSearch: 'la',
    });
    const popover = await screen.findByRole('dialog', { name: 'Choose Customers' });
    expect(within(popover).getByRole('combobox')).toHaveValue('la');
    expect(within(popover).getByText(/matching the field’s conditions/u)).toBeInTheDocument();
    await waitFor(() => {
      expect(within(popover).getAllByRole('option')).toHaveLength(1);
    });
    // T421b (axe `scrollable-region-focusable`): the list scrolls with the keyboard too.
    expect(scrollerOf(popover)).toHaveAttribute('tabindex', '0');
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith([{ id: rec(3), title: 'Quán cà phê Lá Xanh' }]);
    expect(onClose).toHaveBeenCalled();
  });

  it('Enter writes nothing until a record is chosen (T421a); ↓ then Enter chooses', async () => {
    serve();
    const user = userEvent.setup();
    const { onCommit, onClose } = await renderPicker({
      options: single,
      anchor: { x: 100, y: 100, width: 200, height: 34 },
    });
    const popover = await screen.findByRole('dialog', { name: 'Choose Customers' });
    await within(popover).findAllByRole('option');
    const search = within(popover).getByRole('combobox');
    expect(search).toHaveFocus();
    expect(search).not.toHaveAttribute('aria-activedescendant');
    await user.keyboard('{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(popover).toBeInTheDocument();
    await user.keyboard('{ArrowDown}');
    const first = within(popover).getAllByRole('option')[0];
    expect(search).toHaveAttribute('aria-activedescendant', first?.id);
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith([{ id: rec(1), title: 'Cửa hàng An Phát' }]);
  });

  it('Enter while the search still debounces chooses nothing from the previous list', async () => {
    serve();
    const user = userEvent.setup();
    const { onCommit } = await renderPicker({
      options: single,
      anchor: { x: 100, y: 100, width: 200, height: 34 },
      initialSearch: 'a',
    });
    const popover = await screen.findByRole('dialog', { name: 'Choose Customers' });
    await within(popover).findAllByRole('option');
    await user.keyboard('x{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('"Expand" opens the dialog; Cancel closes without writing', async () => {
    serve();
    const user = userEvent.setup();
    const { onCommit, onClose } = await renderPicker({
      options: single,
      anchor: { x: 100, y: 100, width: 200, height: 34 },
    });
    const popover = await screen.findByRole('dialog', { name: 'Choose Customers' });
    await user.click(within(popover).getByRole('button', { name: 'Open the full picker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link Customers' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('covers the screen on phones with "Save (N)"', async () => {
    serve();
    const user = userEvent.setup();
    const { onCommit } = await renderPicker({ fullScreen: true });
    const sheet = await screen.findByTestId('link-picker-sheet');
    const option = (await within(sheet).findAllByRole('option'))[0];
    if (option === undefined) throw new Error('no option');
    expect(scrollerOf(sheet)).toHaveAttribute('tabindex', '0');
    await user.click(option);
    await user.click(within(sheet).getByRole('button', { name: 'Save (1)' }));
    expect(onCommit).toHaveBeenCalledWith([{ id: rec(1), title: 'Cửa hàng An Phát' }]);
  });
});

describe('DisplayLine (T421a)', () => {
  it('is one line "KH-1049 · Hà Nội": the first value is never cut on its own', () => {
    render(
      <DisplayLine
        values={[
          { fieldId: 'fld_Code000000000001', name: 'Code', text: 'KH-1049', code: true },
          { fieldId: 'fld_City000000000001', name: 'City', text: 'Hà Nội', code: false },
        ]}
      />,
    );
    const line = screen.getByTestId('link-display-line');
    expect(line).toHaveTextContent(/^KH-1049 · Hà Nội$/u);
    // One truncating box: the values flow inline instead of shrinking side by side.
    expect(line).toHaveClass('truncate');
    expect(line).not.toHaveClass('flex');
  });
});
