import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import {
  FieldMapper,
  FieldMapperRow,
  SEARCH_THRESHOLD,
  TargetCombobox,
  type TargetGroup,
} from '../components/FieldMapper';

import type { i18n as I18n } from 'i18next';

const FEW: TargetGroup[] = [
  {
    key: 'fields',
    options: [
      { id: 'fld_name', label: 'Tên', type: 'text' },
      { id: 'fld_amount', label: 'Số tiền', type: 'number' },
      { id: 'fld_date', label: 'Ngày đặt', type: 'datetime' },
    ],
  },
  {
    key: 'files',
    label: 'Cannot be imported',
    options: [
      {
        id: 'fld_files',
        label: 'Ảnh (files cannot be imported)',
        type: 'attachment',
        disabled: true,
      },
    ],
  },
];

const NAMES = [
  'Email',
  'Điện thoại',
  'Số tiền',
  'Ngày đặt',
  'Trạng thái',
  'Đã giao',
  'Ghi chú',
  'Thành phố',
  'Tên khách hàng',
];
const MANY: TargetGroup[] = [
  {
    key: 'fields',
    options: NAMES.map((name, index) => ({
      id: `fld_${String(index)}`,
      label: name,
      type: 'text',
    })),
  },
];

let i18n: I18n;
beforeEach(async () => {
  i18n = await createTestI18n('en');
});

/** One row with its combobox, holding the chosen field like MappingStep does. */
function Harness({
  groups,
  initial = null,
  onChange = () => undefined,
}: {
  groups: TargetGroup[];
  initial?: string | null;
  onChange?: (value: string | null) => void;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <FieldMapper label="Columns of the file" warning={null}>
      <FieldMapperRow
        name="Họ tên"
        samples={['Nguyễn Văn Ánh', 'Trần Thị Bình']}
        state={value === null ? 'skipped' : 'mapped'}
        target={value ?? ''}
      >
        <TargetCombobox
          label="Field for column Họ tên"
          value={value}
          skipLabel="Do not import"
          groups={groups}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      </FieldMapperRow>
      <li>
        <button type="button">Next thing</button>
      </li>
    </FieldMapper>
  );
}

function renderHarness(props: Parameters<typeof Harness>[0]) {
  return render(
    <I18nextProvider i18n={i18n}>
      <Harness {...props} />
    </I18nextProvider>,
  );
}

const combobox = () => screen.getByRole('combobox', { name: 'Field for column Họ tên' });
const activeOption = () => {
  const id = combobox().getAttribute('aria-activedescendant');
  return id === null ? null : document.getElementById(id);
};

describe('FieldMapper row (Lucian #130)', () => {
  it('shows the column, its sample values and an arrow; the warning line is a status', () => {
    const { container } = renderHarness({ groups: FEW });
    const row = screen.getByTestId('import-column-row');
    expect(row).toHaveTextContent('Họ tên');
    expect(row).toHaveTextContent('Sample values: Nguyễn Văn Ánh · Trần Thị Bình');
    expect(row).toHaveAttribute('data-state', 'skipped');
    expect(container.querySelector('.link')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('region', { name: 'Columns of the file' })).toHaveAttribute(
      'tabindex',
      '0',
    );
  });

  it('nudges the arrow 4 px for 220 ms when the target changes, not with reduced motion', async () => {
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      value: animate,
      configurable: true,
      writable: true,
    });
    let reduced = false;
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('reduce') ? reduced : false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const user = userEvent.setup();
    const { container } = renderHarness({ groups: FEW });
    expect(animate).not.toHaveBeenCalled();
    await user.click(combobox());
    await user.click(screen.getByRole('option', { name: 'Số tiền' }));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(container.querySelector('.link'));
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translateX(-4px)' }, { transform: 'none' }],
      expect.objectContaining({ duration: 220 }),
    );
    // The same field again: nothing changed, no nudge.
    await user.click(combobox());
    await user.click(screen.getByRole('option', { name: 'Số tiền' }));
    expect(animate).toHaveBeenCalledTimes(1);
    reduced = true;
    await user.click(combobox());
    await user.click(screen.getByRole('option', { name: 'Tên' }));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('import-column-row')).toHaveAttribute('data-state', 'mapped');
    Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  });
});

describe('TargetCombobox (≤ 8 fields): the button keeps the focus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on ArrowDown at the current value, moves, skips disabled fields, picks with Enter', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = renderHarness({ groups: FEW, initial: 'fld_amount', onChange });
    expect(combobox()).toHaveTextContent('Số tiền');
    expect(combobox()).toHaveAttribute('aria-expanded', 'false');
    await user.tab();
    await user.tab();
    expect(combobox()).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(combobox()).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox', { name: 'Field for column Họ tên' });
    expect(combobox()).toHaveAttribute('aria-controls', list.id);
    expect(screen.queryByRole('combobox', { name: 'Search fields' })).toBeNull();
    expect(activeOption()).toHaveTextContent('Số tiền');
    expect(activeOption()).toHaveAttribute('aria-selected', 'true');
    expect(await axeViolations(container)).toEqual([]);
    await user.keyboard('{ArrowDown}');
    expect(activeOption()).toHaveTextContent('Ngày đặt');
    // The file field is disabled: the end of the list stays on the last field.
    await user.keyboard('{ArrowDown}');
    expect(activeOption()).toHaveTextContent('Ngày đặt');
    await user.keyboard('{End}');
    expect(activeOption()).toHaveTextContent('Ngày đặt');
    await user.keyboard('{Home}');
    expect(activeOption()).toHaveTextContent('Do not import');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('fld_name');
    expect(combobox()).toHaveAttribute('aria-expanded', 'false');
    expect(combobox()).toHaveFocus();
    expect(combobox()).toHaveTextContent('Tên');
  });

  it('finds a field by its first letters (accents ignored) and picks with Space', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderHarness({ groups: FEW, onChange });
    combobox().focus();
    await user.keyboard('n');
    expect(combobox()).toHaveAttribute('aria-expanded', 'true');
    expect(activeOption()).toHaveTextContent('Ngày đặt');
    await user.keyboard('{Home}so');
    expect(activeOption()).toHaveTextContent('Số tiền');
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith('fld_amount');
  });

  it('closes without a change on Escape, Tab and a click outside', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderHarness({ groups: FEW, onChange });
    await user.click(combobox());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(combobox()).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.tab();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Next thing' })).toHaveFocus();
    await user.click(combobox());
    await user.click(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    // A click on the button closes an open list too.
    await user.click(combobox());
    await user.click(combobox());
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('marks the chosen field and leaves a disabled one unchosen', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderHarness({ groups: FEW, initial: 'fld_date', onChange });
    await user.click(combobox());
    expect(screen.getByRole('option', { name: 'Ngày đặt' })).toHaveAttribute('data-current');
    const files = within(screen.getByRole('group', { name: 'Cannot be imported' })).getByRole(
      'option',
    );
    expect(files).toHaveAttribute('aria-disabled', 'true');
    await user.click(files);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});

describe(`TargetCombobox (> ${String(SEARCH_THRESHOLD)} fields): a search box`, () => {
  it('moves the focus to the search box, filters ignoring accents, picks with Enter', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = renderHarness({ groups: MANY, onChange });
    await user.click(combobox());
    const search = screen.getByRole('combobox', { name: 'Search fields' });
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
    expect(await axeViolations(container)).toEqual([]);
    await user.keyboard('tien');
    const options = screen.getAllByRole('option');
    // "Not imported" stays, then the match.
    expect(options.map((option) => option.textContent)).toEqual(['Do not import', 'Số tiền']);
    const active = document.getElementById(search.getAttribute('aria-activedescendant') ?? '');
    expect(active).toHaveTextContent('Số tiền');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('fld_2');
    expect(combobox()).toHaveFocus();
    expect(combobox()).toHaveTextContent('Số tiền');
  });

  it('says when nothing matches; Enter then does nothing; Escape gives the focus back', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderHarness({ groups: MANY, onChange });
    combobox().focus();
    // Typing on the button opens the search with that letter.
    await user.keyboard('x');
    const search = screen.getByRole('combobox', { name: 'Search fields' });
    expect(search).toHaveValue('x');
    await user.keyboard('yz');
    expect(screen.getByText('No field matches')).toBeInTheDocument();
    expect(search).not.toHaveAttribute('aria-activedescendant');
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(combobox()).toHaveFocus();
  });

  it('Shift+Tab goes back to the button; Tab leaves the list closed', async () => {
    const user = userEvent.setup();
    renderHarness({ groups: MANY });
    await user.click(combobox());
    await user.tab({ shift: true });
    expect(combobox()).toHaveFocus();
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('combobox', { name: 'Search fields' })).toHaveFocus();
    await user.tab();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Next thing' })).toHaveFocus();
  });
});
