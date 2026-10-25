import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { GridEmptyState } from '../components/GridEmptyState';
import { GridFooter } from '../components/GridFooter';

import type { BlockSnapshot } from '../blocks/block-loader';
import type { i18n as I18n } from 'i18next';
import type { ReactNode } from 'react';

let en: I18n;
let vi_: I18n;

beforeAll(async () => {
  en = await createTestI18n('en');
  vi_ = await createTestI18n('vi');
});

function inLanguage(i18n: I18n, node: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
}

const snapshot = (rowCount: number, estimated = false) =>
  ({
    status: 'ready',
    rowCount,
    estimated,
    version: 1,
    error: null,
    newRows: 0,
    stale: false,
  }) as unknown as BlockSnapshot;

describe('grid footer (T320b)', () => {
  it.each<[string, Parameters<typeof GridFooter>[0], string]>([
    ['no filter', { snapshot: snapshot(2000) }, '2,000 records'],
    [
      'a filter, with the table count',
      { snapshot: snapshot(318), narrowedBy: 'filter', total: { count: 2000, estimated: false } },
      '318 records of 2,000 · match the filter',
    ],
    [
      'a search, estimated table count',
      {
        snapshot: snapshot(12),
        narrowedBy: 'search',
        total: { count: 150_000, estimated: true },
      },
      '12 records of ~150,000 · match the search',
    ],
    [
      'a tree (T421b): every record, and the rows shown',
      { snapshot: snapshot(5), tree: true, total: { count: 7, estimated: false } },
      '7 records 5 shown',
    ],
    [
      'a tree with every branch open',
      { snapshot: snapshot(7), tree: true, total: { count: 7, estimated: false } },
      '7 records',
    ],
    ['a tree before the table count arrives', { snapshot: snapshot(5), tree: true }, '5 records'],
    [
      'a filter before the table count arrives',
      { snapshot: snapshot(318), narrowedBy: 'filter' },
      '318 records',
    ],
  ])('%s', (_label, props, text) => {
    const { container } = inLanguage(en, <GridFooter {...props} />);
    const parts = [...container.querySelectorAll('footer p')].map((part) => part.textContent);
    expect(parts.join(' ')).toBe(text);
  });

  it('says how many rows are selected (vi like the design)', () => {
    inLanguage(
      vi_,
      <GridFooter
        snapshot={snapshot(318)}
        narrowedBy="filter"
        total={{ count: 2000, estimated: false }}
        selected={1}
      />,
    );
    // The live count stays "N bản ghi"; what it is out of follows it.
    expect(screen.getByRole('status')).toHaveTextContent(/^318 bản ghi$/u);
    expect(screen.getByTestId('footer-of')).toHaveTextContent('/ 2.000 · khớp bộ lọc');
    expect(screen.getByTestId('footer-selected')).toHaveTextContent('1 dòng đang chọn');
  });

  it('a tree counts every record, then the rows shown (vi, T421b)', () => {
    inLanguage(
      vi_,
      <GridFooter snapshot={snapshot(5)} tree total={{ count: 7, estimated: false }} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/^7 bản ghi$/u);
    expect(screen.getByTestId('footer-shown')).toHaveTextContent('5 đang hiện');
  });
});

describe('grid empty state (T320b)', () => {
  it('a filter to nothing: says so and clears it; no axe violations', async () => {
    const onClear = vi.fn();
    const { container } = inLanguage(vi_, <GridEmptyState narrowedBy="filter" onClear={onClear} />);
    expect(
      screen.getByRole('heading', { name: 'Chưa có bản ghi nào khớp bộ lọc' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Xoá bộ lọc' }));
    expect(onClear).toHaveBeenCalledOnce();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('an empty table: no clear button', () => {
    inLanguage(en, <GridEmptyState narrowedBy={null} />);
    expect(screen.getByRole('heading', { name: 'No records yet' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
