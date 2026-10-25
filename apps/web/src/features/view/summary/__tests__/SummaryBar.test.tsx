import { TooltipProvider } from '@cellhive/ui';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../../test/axe';
import { createTestI18n } from '../../../../../test/i18n';
import { ApiError } from '../../../../lib/api/client';
import { markSlivers, SummaryBar } from '../SummaryBar';

import type { SummaryBarProps } from '../../../../lib/views/summary/types';
import type { FieldDto } from '@cellhive/contracts';
import type { i18n as I18n } from 'i18next';

let vi_: I18n;
let en: I18n;
beforeAll(async () => {
  vi_ = await createTestI18n('vi');
  en = await createTestI18n('en');
});

const field = (id: string, name: string, type: string, options: unknown = {}): FieldDto =>
  ({
    id,
    table_id: 'tbl_0000000000000000',
    name,
    type,
    options,
    is_primary: id === 'fld_name000000000000',
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }) as FieldDto;

const NAME = field('fld_name000000000000', 'Tên khách hàng', 'text');
const EMAIL = field('fld_email00000000000', 'Email', 'text');
const REVENUE = field('fld_revenue000000000', 'Doanh thu', 'number', {
  style: { type: 'currency', currency_code: 'VND' },
});

function props(overrides: Partial<SummaryBarProps> = {}): SummaryBarProps {
  return {
    layout: {
      gutter: 40,
      columns: [
        { fieldId: NAME.id, width: 220 },
        { fieldId: EMAIL.id, width: 200 },
        { fieldId: REVENUE.id, width: 180 },
      ],
      frozen: 1,
      scroller: () => null,
    },
    fields: new Map([NAME, EMAIL, REVENUE].map((item) => [item.id, item])),
    config: { [NAME.id]: 'unique', [REVENUE.id]: 'sum' },
    result: {
      count: 48,
      summaries: {
        [NAME.id]: { fn: 'unique', value: 48 },
        [REVENUE.id]: { fn: 'sum', value: 1_284_500_000 },
      },
      group: [],
      groups: [],
      truncated: false,
    },
    busy: false,
    error: null,
    onRetry: vi.fn(),
    onChange: vi.fn(),
    locale: { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' },
    count: {
      short: '48',
      full: '48 bản ghi / 203 · khớp bộ lọc',
      status: <p role="status">48 bản ghi</p>,
    },
    ...overrides,
  };
}

function show(i18n: I18n, overrides: Partial<SummaryBarProps> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <SummaryBar {...props(overrides)} />
      </TooltipProvider>
    </I18nextProvider>,
  );
}

/** Keyboard focus (a key press first, so `:focus-visible` holds): the tooltip shows at once. */
function keyboardFocus(element: HTMLElement) {
  fireEvent.keyDown(document.body, { key: 'Tab' });
  act(() => {
    element.focus();
  });
}

/** The visible tooltip bubble. */
function bubble(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper] [data-state]');
}

describe('SummaryBar (T472)', () => {
  it('one cell per column, the count in the gutter; no axe violations', async () => {
    const { container } = show(vi_);
    expect(screen.getByTestId('summary-count')).toHaveAccessibleName(
      '48 bản ghi / 203 · khớp bộ lọc',
    );
    expect(screen.getByTestId(`summary-cell-${NAME.id}`)).toHaveAccessibleName(
      'Thống kê cột Tên khách hàng: Khác nhau 48',
    );
    expect(screen.getByTestId(`summary-cell-${REVENUE.id}`)).toHaveTextContent(
      'Tổng1.284.500.000 ₫',
    );
    // Not set: "Summary ▾" (visible on hover/focus), named for screen readers.
    expect(screen.getByTestId(`summary-cell-${EMAIL.id}`)).toHaveAccessibleName(
      'Thống kê cột Email',
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it('the menu lists the functions of the type, without previews; choosing one applies it', async () => {
    const onChange = vi.fn();
    show(en, { onChange });
    await userEvent.click(screen.getByTestId(`summary-cell-${EMAIL.id}`));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['None', 'All', 'Filled', 'Empty', 'Unique values', 'Filled', 'Empty']);
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Unique values' }));
    expect(onChange).toHaveBeenCalledWith(EMAIL.id, 'unique');
  });

  it('number columns add Sum…Range; None removes the summary', async () => {
    const onChange = vi.fn();
    show(en, { onChange });
    await userEvent.click(screen.getByTestId(`summary-cell-${REVENUE.id}`));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: 'Sum' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'None' }));
    expect(onChange).toHaveBeenCalledWith(REVENUE.id, null);
  });

  it('while loading the old numbers stay (busy); a timeout shows "—" and a retry', async () => {
    const { unmount } = show(vi_, { busy: true });
    expect(screen.getByTestId(`summary-cell-${REVENUE.id}`)).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId(`summary-cell-${REVENUE.id}`)).toHaveTextContent('1.284.500.000 ₫');
    unmount();
    const onRetry = vi.fn();
    show(en, {
      error: new ApiError({
        status: 504,
        code: 'QUERY_TIMEOUT',
        detail: 'The query took too long.',
        errors: [],
        request_id: 'req_1',
      }),
      onRetry,
    });
    expect(screen.getByTestId(`summary-cell-${REVENUE.id}`)).toHaveTextContent('Sum—');
    await userEvent.click(screen.getByTestId(`summary-cell-${REVENUE.id}`));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('375 px: a tap opens a bottom sheet with the same choices', async () => {
    const onChange = vi.fn();
    show(vi_, { narrow: true, onChange });
    await userEvent.click(screen.getByTestId(`summary-cell-${REVENUE.id}`));
    const sheet = await screen.findByRole('dialog', { name: 'Thống kê cột Doanh thu' });
    expect(sheet).toHaveTextContent('Hiện tại: Tổng 1.284.500.000 ₫');
    await userEvent.click(within(sheet).getByRole('radio', { name: 'Trung bình' }));
    expect(onChange).toHaveBeenCalledWith(REVENUE.id, 'avg');
  });

  it('read-only (a shared view): no menus on the cells, the full summary on focus', () => {
    show(en, { onChange: undefined });
    expect(screen.queryByTestId(`summary-cell-${REVENUE.id}`)).toBeNull();
    expect(screen.getByTestId('summary-bar')).toHaveTextContent('Sum1.284.500.000 ₫');
    const cells = screen.queryAllByRole('button', { name: /^Summary of/u });
    expect(cells.filter((cell) => cell.hasAttribute('aria-haspopup'))).toEqual([]);
    keyboardFocus(screen.getByRole('button', { name: /^Summary of Doanh thu/u }));
    expect(bubble()).toHaveTextContent('Sum 1.284.500.000 ₫');
  });

  it('M6: a column under 120 px shows the value without the label; the tooltip has both', () => {
    show(en, {
      layout: {
        gutter: 48,
        columns: [{ fieldId: REVENUE.id, width: 100 }],
        frozen: 0,
        scroller: () => null,
      },
    });
    const cell = screen.getByTestId(`summary-cell-${REVENUE.id}`);
    expect(cell).toHaveTextContent(/^1\.284\.500\.000 ₫$/u);
    expect(cell).toHaveAccessibleName(/Sum 1\.284\.500\.000 ₫/u);
    keyboardFocus(cell);
    expect(bubble()).toHaveTextContent('Sum 1.284.500.000 ₫');
  });
});

describe('markSlivers (T470: axe target-size under frozen columns or a panel)', () => {
  const rowOf = (boxes: readonly (readonly [number, number])[]) => {
    const row = document.createElement('div');
    for (const [left, width] of boxes) {
      const cell = document.createElement('button');
      cell.getBoundingClientRect = () =>
        ({ left, right: left + width, top: 0, bottom: 36, width, height: 36 }) as DOMRect;
      row.append(cell);
    }
    return row;
  };
  const inert = (row: HTMLElement) => [...row.children].map((cell) => cell.hasAttribute('inert'));

  it.each([
    { name: 'all shown', left: 0, right: 600, want: [false, false, false] },
    { name: 'a 20 px sliver on the left', left: 180, right: 600, want: [true, false, false] },
    { name: '30 px still shown on the left', left: 170, right: 600, want: [false, false, false] },
    {
      name: 'a sliver under a panel on the right',
      left: 0,
      right: 410,
      want: [false, false, true],
    },
    { name: 'hidden under the panel entirely', left: 0, right: 400, want: [false, false, true] },
  ])('$name', ({ left, right, want }) => {
    const row = rowOf([
      [0, 200],
      [200, 200],
      [400, 200],
    ]);
    markSlivers(row, left, right);
    expect(inert(row)).toEqual(want);
  });

  it('a cell shown again is not inert any more', () => {
    const row = rowOf([[0, 200]]);
    markSlivers(row, 190, 600);
    expect(inert(row)).toEqual([true]);
    markSlivers(row, 0, 600);
    expect(inert(row)).toEqual([false]);
  });
});
