import { fieldConfigSchema, type S1FieldConfig } from '@cellhive/field-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { CellEditor, editsInPlace, isEditableField } from '../index';

import type { EditorContext } from '../types';
import type { FieldDto } from '@cellhive/contracts';
import type { i18n as I18n } from 'i18next';

let i18n: I18n;

beforeAll(async () => {
  i18n = await createTestI18n('en');
  // jsdom does not lay out: the pickers scroll the active option into view.
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = '2026-09-24T00:00:00.000Z';
const ORG = 'org_0123456789ABCDEF';

function fieldOf(type: S1FieldConfig['type'], name: string, options: unknown = {}) {
  const dto: FieldDto = {
    id: `fld_${name.padEnd(16, '0').slice(0, 16)}`,
    table_id: 'tbl_Tickets000000001',
    name,
    type,
    options: options as FieldDto['options'],
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
  };
  return { dto, config: fieldConfigSchema.parse({ type, options }) as S1FieldConfig };
}

function setup(
  type: S1FieldConfig['type'],
  options: unknown,
  value: unknown,
  extra: { initialInput?: string; canCreate?: boolean; locale?: string } = {},
) {
  const { dto, config } = fieldOf(type, 'Field', options);
  const onDraft = vi.fn();
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const context: EditorContext = {
    locale: { locale: extra.locale ?? 'en-US', timeZone: 'UTC' },
    orgId: ORG,
    canCreateOption: () => extra.canCreate === true,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <CellEditor
          field={dto}
          config={config}
          value={value}
          initialInput={extra.initialInput}
          cellHeight={34}
          cellWidth={180}
          context={context}
          onDraft={onDraft}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, onDraft, onCommit, onCancel };
}

describe('editor registry', () => {
  it.each([
    ['text', true],
    ['number', true],
    ['select', true],
    ['datetime', true],
    ['checkbox', true],
    ['user', true],
    ['created_at', false],
    ['updated_by', false],
    ['auto_number', false],
  ] as const)('%s editable: %s', (type, editable) => {
    const { dto, config } = fieldOf(type, 'Field');
    expect(isEditableField({ field: dto, config })).toBe(editable);
  });

  it('a field without a readable config (S4 types) is not editable', () => {
    const { dto } = fieldOf('text', 'Field');
    expect(isEditableField({ field: { ...dto, type: 'link' }, config: null })).toBe(false);
  });

  it('check boxes toggle in place, without an overlay', () => {
    const { dto, config } = fieldOf('checkbox', 'Done');
    expect(editsInPlace({ field: dto, config })).toBe(true);
  });
});

describe('TextEditor', () => {
  it('commits with Enter (move down) and Tab (move right), cancels with Escape', async () => {
    const user = userEvent.setup();
    const { onCommit, onCancel, container } = setup('text', { style: { type: 'email' } }, 'a@x.vn');
    const input = screen.getByRole('textbox', { name: 'Field' });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('a@x.vn');
    await user.clear(input);
    await user.type(input, 'b@x.vn{Enter}');
    expect(onCommit).toHaveBeenLastCalledWith(
      { value: 'b@x.vn', display: 'b@x.vn', typecast: false },
      [0, 1],
    );
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(onCommit).toHaveBeenLastCalledWith(expect.anything(), [-1, 0]);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('plain text is multi-line: Shift+Enter adds a line, typing replaces the value', async () => {
    const user = userEvent.setup();
    const { onCommit } = setup('text', {}, 'old', { initialInput: 'N' });
    const area = screen.getByRole('textbox', { name: 'Field' });
    expect(area.tagName).toBe('TEXTAREA');
    expect(area).toHaveValue('N');
    await user.type(area, 'ew{Shift>}{Enter}{/Shift}line{Enter}');
    expect(onCommit).toHaveBeenCalledWith(
      { value: 'New\nline', display: 'New\nline', typecast: false },
      [0, 1],
    );
  });
});

describe('NumberEditor', () => {
  it('refuses letters with an inline error and sends nothing', async () => {
    const user = userEvent.setup();
    const { onCommit, onDraft, container } = setup('number', {}, 12);
    const input = screen.getByRole('textbox', { name: 'Field' });
    await user.clear(input);
    await user.type(input, 'abc{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Expected a number.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Expected a number.');
    // A click outside would write the draft: it carries the issue, not a value.
    expect(onDraft).toHaveBeenLastCalledWith({
      ok: false,
      issue: { code: 'EXPECTED_NUMBER', params: { locale: 'en-US' } },
    });
    expect(await axeViolations(container)).toEqual([]);
    await user.clear(input);
    await user.type(input, '1,234.5{Tab}');
    expect(onCommit).toHaveBeenCalledWith(
      { value: 1234.5, display: 1234.5, typecast: false },
      [1, 0],
    );
  });

  it('reads the user locale: 1.500.000 in Vietnamese', async () => {
    const user = userEvent.setup();
    const { onCommit } = setup(
      'number',
      { style: { type: 'currency', currency_code: 'VND' } },
      null,
      { initialInput: '1', locale: 'vi' },
    );
    await user.type(screen.getByRole('textbox', { name: 'Field' }), '.500.000{Enter}');
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ value: 1_500_000 }), [0, 1]);
  });
});

describe('SelectEditor', () => {
  const options = [
    { id: 'opt_New0000000000001', name: 'Mới', color: 1 },
    { id: 'opt_Doing00000000001', name: 'Đang xử lý', color: 3 },
    { id: 'opt_Done000000000001', name: 'Đã xong' },
  ];

  it('searches, moves with the arrows and picks with Enter', async () => {
    const user = userEvent.setup();
    const { onCommit, container } = setup('select', { options }, 'Mới');
    const listbox = screen.getByRole('listbox', { name: 'Field' });
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);
    expect(within(listbox).getByRole('option', { name: 'Mới' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.type(screen.getByRole('combobox', { name: 'Field' }), 'xu');
    expect(within(listbox).getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith(
      { value: 'Đang xử lý', display: 'Đang xử lý', typecast: false },
      [0, 1],
    );
  });

  it('offers a new option only to roles that edit the options', async () => {
    const user = userEvent.setup();
    const first = setup('select', { options }, null, { initialInput: 'Mớ' });
    await user.type(screen.getByRole('combobox'), 'i lạ');
    expect(screen.queryByRole('option', { name: /Add option/u })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(first.onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('This option does not exist.');
    first.unmount();

    const second = setup('select', { options }, null, { initialInput: 'M', canCreate: true });
    await user.type(screen.getByRole('combobox'), 'ới lạ');
    await user.click(screen.getByRole('option', { name: 'Add option “Mới lạ”' }));
    expect(second.onCommit).toHaveBeenCalledWith(
      { value: 'Mới lạ', display: 'Mới lạ', typecast: true },
      [0, 1],
    );
  });

  it('multiple: Enter toggles, Backspace drops the last value, Tab writes', async () => {
    const user = userEvent.setup();
    const { onCommit } = setup('select', { options, multiple: true }, ['Mới']);
    const combobox = screen.getByRole('combobox');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(screen.getByRole('option', { name: 'Đang xử lý' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(combobox).toHaveFocus();
    await user.keyboard('{Backspace}{Tab}');
    expect(onCommit).toHaveBeenCalledWith(
      { value: ['Mới'], display: ['Mới'], typecast: false },
      [1, 0],
    );
  });
});

describe('DatetimeEditor', () => {
  it('reads a typed date in the field format and picks days in the calendar', async () => {
    const user = userEvent.setup();
    const { onCommit, container } = setup(
      'datetime',
      { style: { format: 'dd/MM/yyyy' } },
      '2026-09-25',
    );
    const input = screen.getByRole('textbox', { name: 'Field' });
    expect(input).toHaveValue('25/09/2026');
    expect(await axeViolations(container)).toEqual([]);
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveValue('26/09/2026');
    await user.clear(input);
    await user.type(input, '31/02/2026{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Expected a date.');
    await user.click(screen.getByRole('button', { name: 'Thursday, October 1, 2026' }));
    // A date-only field writes the picked day at once.
    expect(onCommit).toHaveBeenCalledWith(
      { value: '2026-10-01', display: '2026-10-01', typecast: false },
      [0, 0],
    );
  });

  it('a date with time: typed in the field zone', async () => {
    const user = userEvent.setup();
    const { onCommit } = setup(
      'datetime',
      { style: { format: 'yyyy-MM-dd HH:mm' }, timezone: 'Asia/Ho_Chi_Minh' },
      null,
      { initialInput: '2' },
    );
    await user.type(screen.getByRole('textbox'), '026-09-25 09:30{Enter}');
    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({ value: '2026-09-25T02:30:00.000Z' }),
      [0, 1],
    );
  });
});

describe('UserEditor', () => {
  const members = {
    items: [
      {
        user: {
          id: 'usr_Lan0000000000001',
          email: 'lan@demo.test',
          display_name: 'Phạm Ngọc Lan',
          avatar_url: null,
        },
        role: 'member',
        joined_at: NOW,
      },
      {
        user: {
          id: 'usr_Huy0000000000001',
          email: 'huy@demo.test',
          display_name: 'Võ Đức Huy',
          avatar_url: null,
        },
        role: 'member',
        joined_at: NOW,
      },
    ],
    total: 2,
    offset: 0,
    limit: 1000,
  };

  it('lists the organization members, searches by name and writes ids', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(() =>
      Promise.resolve(
        new Response(JSON.stringify(members), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    const { onCommit, container } = setup('user', { multiple: false }, null);
    expect(await screen.findByRole('option', { name: /Võ Đức Huy/u })).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/orgs/${ORG}/members`);
    expect(await axeViolations(container)).toEqual([]);
    await user.type(screen.getByRole('combobox'), 'ngoc');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith(
      {
        value: [{ id: 'usr_Lan0000000000001' }],
        display: [{ id: 'usr_Lan0000000000001', name: 'Phạm Ngọc Lan', email: 'lan@demo.test' }],
        typecast: false,
      },
      [0, 1],
    );
  });
});
