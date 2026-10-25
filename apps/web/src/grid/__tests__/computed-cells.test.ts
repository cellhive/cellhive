import { GridCellKind } from '@glideapps/glide-data-grid';
import { describe, expect, it } from 'vitest';

import { themeTokens } from '../../../test/tokens';
import { columnHeaderLabel } from '../a11y';
import { renderCell } from '../cellRenderers/index';
import { cellClipboardText } from '../clipboard';
import { headerBadgeBounds, hitsHeaderBadge, percentOf } from '../computed-header';
import { isComputedMarkCell } from '../customCells/computed';
import {
  computedCellShape,
  computedColumnOf,
  filterTypeOfResult,
  hyperlinkOf,
  isComputing,
} from '../display/computed';
import { isEditableField } from '../editors/index';
import { tokensToAppearance } from '../theme';
import { toGridField, type CellRenderContext } from '../types';

import type { FieldDto } from '@cellhive/contracts';
import type { TFunction } from 'i18next';

const NOW = '2026-09-28T00:00:00.000Z';

function computedField(
  extra: Partial<FieldDto> = {},
  options: Record<string, unknown> = {},
): FieldDto {
  return {
    id: 'fld_Total00000000001',
    table_id: 'tbl_Customers0000001',
    name: 'Total',
    type: 'formula',
    options: { expression: '[Amount] * 2', style: null, ...options },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 4,
    created_at: NOW,
    updated_at: NOW,
    result_type: { kind: 'number', list: false },
    compute_mode: 'stored',
    compute_state: 'ready',
    compute_error: null,
    ...extra,
  };
}

const ctx: CellRenderContext = {
  locale: { locale: 'vi', timeZone: 'UTC' },
  palette: tokensToAppearance(themeTokens('light')).palette,
  labels: {
    formerMember: 'Former member',
    noAccess: 'No access',
    linkCount: (count) => `${String(count)} links`,
    computed: { locked: 'Locked', error: 'Field error', pending: 'Computing' },
  },
};

const VND = { type: 'currency', currency_code: 'VND' };

describe('computed columns (T468)', () => {
  it('reads result type, style, state, error and lock from the field', () => {
    const column = computedColumnOf(computedField({}, { style: VND }));
    expect(column).toMatchObject({
      type: 'formula',
      resultType: { kind: 'number', list: false },
      state: 'ready',
      error: null,
      locked: false,
      expression: '[Amount] * 2',
    });
    expect(column?.style).toMatchObject({ type: 'currency', currency_code: 'VND' });
    expect(computedColumnOf({ ...computedField(), type: 'text' })).toBeUndefined();
    // Share links: the error code without refs.
    const shared = computedColumnOf(
      computedField(
        {
          result_type: { kind: 'text', list: false },
          compute_state: undefined,
          compute_error: { code: 'REF', refs: [] },
        },
        { expression: undefined },
      ),
    );
    expect(shared).toMatchObject({ resultType: { kind: 'text' }, state: 'error' });
  });

  it.each([
    [{ locked: true }, null, 'locked'],
    [
      { compute_error: { code: 'REF' as const, refs: [] }, compute_state: 'error' as const },
      null,
      'error',
    ],
    [{ compute_state: 'backfilling' as const }, null, 'pending'],
    [{ compute_state: 'backfilling' as const }, 3, 'value'],
    [{ compute_state: 'recomputing' as const }, 3, 'value'],
    [{}, null, 'value'],
  ])('cell shape of %j with %j is %s', (extra, value, kind) => {
    const column = computedColumnOf(computedField(extra));
    if (column === undefined) throw new Error('not computed');
    expect(computedCellShape(column, value).kind).toBe(kind);
  });

  it.each([
    ['REF', '#REF!'],
    ['CIRCLE', '#CIRCLE!'],
    ['TIMEOUT', '#TIMEOUT!'],
    ['INVALID_CONFIG', '#VALUE!'],
  ] as const)('%s draws the grey token %s; copy stays empty', (code, token) => {
    const field = toGridField(
      computedField({ compute_error: { code, refs: [] }, compute_state: 'error' }),
    );
    const cell = renderCell(field, null, ctx);
    if (!isComputedMarkCell(cell)) throw new Error('not a mark');
    expect(cell.data).toMatchObject({ mark: 'token', text: token });
    expect(cell.copyData).toBe(token);
    expect(cellClipboardText(field, null, ctx.locale)).toBe('');
  });

  it('a locked cell is a lock with its accessible text only', () => {
    const field = toGridField(computedField({ locked: true }));
    const cell = renderCell(field, null, ctx);
    if (!isComputedMarkCell(cell)) throw new Error('not a mark');
    expect(cell.data.mark).toBe('lock');
    expect(cell.copyData).toBe('Locked');
  });

  it('a new field being filled shows a dim "…"; a recomputed one keeps its value, dimmed', () => {
    const filling = toGridField(computedField({ compute_state: 'backfilling' }));
    const mark = renderCell(filling, null, ctx);
    expect(isComputedMarkCell(mark) && mark.data.mark).toBe('pending');
    const recomputing = toGridField(
      computedField({ compute_state: 'recomputing' }, { style: VND }),
    );
    const cell = renderCell(recomputing, 1500000, ctx);
    expect(cell.kind).toBe(GridCellKind.Number);
    expect(cell.themeOverride?.textDark).toMatch(/^rgba\(/u);
  });

  it('is read-only: no editor, paste skips it', () => {
    expect(isEditableField(toGridField(computedField()))).toBe(false);
  });

  it('numbers use the result style, right-aligned (a VND sum reads 1.500.000 ₫)', () => {
    const field = toGridField(computedField({}, { style: VND }));
    const cell = renderCell(field, 1500000, ctx);
    expect(cell).toMatchObject({ kind: GridCellKind.Number, contentAlign: 'right' });
    expect(cell.kind === GridCellKind.Number && cell.displayData).toBe('1.500.000 ₫');
    expect(cellClipboardText(field, 1500000, ctx.locale)).toBe('1.500.000 ₫');
  });

  it('booleans are a check box (decision #12)', () => {
    const field = toGridField(computedField({ result_type: { kind: 'boolean', list: false } }));
    expect(renderCell(field, true, ctx)).toMatchObject({ kind: GridCellKind.Boolean, data: true });
    expect(renderCell(field, false, ctx)).toMatchObject({
      kind: GridCellKind.Boolean,
      data: false,
    });
  });

  it('lists of values are chips; users and records use their renderers', () => {
    const list = toGridField(computedField({ result_type: { kind: 'text', list: true } }));
    const chips = renderCell(list, ['A', 'B'], ctx);
    expect(chips.kind === GridCellKind.Custom && chips.copyData).toBe('A, B');
    const records = toGridField(computedField({ result_type: { kind: 'record', list: true } }));
    const links = renderCell(records, [{ id: 'rec_AAAAAAAAAAAAAAAA', title: 'An' }], ctx);
    expect(
      (links.kind === GridCellKind.Custom && (links.data as { kind: string }).kind) || '',
    ).toBe('ob-links');
  });

  it.each([
    ['[Cellhive](https://cellhive.io)', { label: 'Cellhive', href: 'https://cellhive.io/' }],
    ['[Mail](mailto:a@b.vn)', { label: 'Mail', href: 'mailto:a@b.vn' }],
    ['[Bad](javascript:alert(1))', { label: 'Bad', href: null }],
    ['[Tel](tel:123)', { label: 'Tel', href: null }],
    ['plain text', null],
    ['[](https://x.y)', null],
  ])('HYPERLINK value %s', (text, expected) => {
    expect(hyperlinkOf(text)).toEqual(expected);
  });

  it('HYPERLINK: http(s)/mailto labels are links, other schemes plain text', () => {
    const field = toGridField(computedField({ result_type: { kind: 'text', list: false } }));
    expect(renderCell(field, '[Cellhive](https://cellhive.io)', ctx)).toMatchObject({
      kind: GridCellKind.Uri,
      displayData: 'Cellhive',
    });
    expect(renderCell(field, '[x](javascript:alert(1))', ctx)).toMatchObject({
      kind: GridCellKind.Text,
      displayData: 'x',
    });
  });

  it('maps result kinds to filter types like the server', () => {
    expect(filterTypeOfResult({ kind: 'boolean', list: false })).toBe('checkbox');
    expect(filterTypeOfResult({ kind: 'record', list: true })).toBe('link');
    expect(filterTypeOfResult({ kind: 'date', list: false })).toBe('datetime');
    expect(filterTypeOfResult({ kind: 'null', list: false })).toBeNull();
  });

  it('computing: backfilling or recomputing without an error', () => {
    expect(isComputing(computedColumnOf(computedField({ compute_state: 'recomputing' })))).toBe(
      true,
    );
    expect(isComputing(computedColumnOf(computedField()))).toBe(false);
    expect(isComputing(undefined)).toBe(false);
  });
});

describe('computed column headers (T468)', () => {
  const header = { width: 200, height: 36 };

  it('places the badge at the right end, left of the menu button when it shows', () => {
    const badge = { kind: 'error', open: false } as const;
    const plain = headerBadgeBounds(header, badge, false);
    const withMenu = headerBadgeBounds(header, badge, true);
    expect(plain.x + plain.width).toBe(192);
    expect(withMenu.x).toBeLessThan(plain.x);
    expect(hitsHeaderBadge(header, badge, plain.x + 4, 18)).toBe(true);
    expect(hitsHeaderBadge(header, badge, 20, 18)).toBe(false);
  });

  it('rounds and clamps the percentage', () => {
    expect(percentOf(0.404)).toBe(40);
    expect(percentOf(1.2)).toBe(100);
    expect(percentOf(-1)).toBe(0);
  });

  it('adds the state to the accessible name of the header', () => {
    const t = ((key: string, values: Record<string, unknown>) =>
      `${key}:${JSON.stringify(values)}`) as unknown as TFunction<'grid'>;
    const error = toGridField(
      computedField({ compute_error: { code: 'CIRCLE', refs: [] }, compute_state: 'error' }),
    );
    expect(columnHeaderLabel(error, t)).toContain('"token":"#CIRCLE!"');
    const computing = toGridField(computedField({ compute_state: 'recomputing' }));
    expect(columnHeaderLabel(computing, t, { kind: 'progress', progress: 0.4 })).toContain(
      '"percent":40',
    );
    expect(columnHeaderLabel(toGridField(computedField({ locked: true })), t)).toContain(
      'header.computedLocked',
    );
  });
});
