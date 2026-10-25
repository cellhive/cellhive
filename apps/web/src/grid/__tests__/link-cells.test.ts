import { GridCellKind } from '@glideapps/glide-data-grid';
import { describe, expect, it } from 'vitest';

import { themeTokens } from '../../../test/tokens';
import { renderCell } from '../cellRenderers/index';
import { cellClipboardText, clipboardKindOf, pastedDisplay, pastedWriteValue } from '../clipboard';
import {
  isLinksCell,
  layoutLinkChips,
  linkChipAt,
  LINK_CHIP_MAX_WIDTH,
  LINK_CHIP_MIN_WIDTH,
} from '../customCells/links';
import { editsWithPicker, isEditableField } from '../editors/index';
import { tokensToAppearance } from '../theme';
import { toGridField, type CellRenderContext } from '../types';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-25T00:00:00.000Z';
const CUSTOMERS = 'tbl_Customers0000001';

function linkField(
  options: Record<string, unknown>,
  id: FieldDto['id'] = 'fld_Customer00000001',
): FieldDto {
  return {
    id,
    table_id: 'tbl_Orders0000000001',
    name: 'Customer',
    type: 'link',
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 3,
    created_at: NOW,
    updated_at: NOW,
  };
}

const ctx: CellRenderContext = {
  locale: { locale: 'en', timeZone: 'UTC' },
  palette: tokensToAppearance(themeTokens('light')).palette,
  labels: {
    formerMember: 'Former member',
    noAccess: 'No access',
    linkCount: (count) => `${String(count)} links`,
  },
};

const A = { id: 'rec_AAAAAAAAAAAAAAAA', title: 'An Phát' };
const B = { id: 'rec_BBBBBBBBBBBBBBBB', title: 'Bình Minh' };
const LOCKED = { id: 'rec_CCCCCCCCCCCCCCCC', title: null };

describe('link fields in the grid (T413)', () => {
  const field = toGridField(linkField({ link_table: CUSTOMERS }));

  it('parses the options; the cell opens the picker, not an overlay editor', () => {
    expect(field.link).toMatchObject({ link_table: CUSTOMERS, allow_multiple: true });
    expect(field.config).toBeNull();
    expect(isEditableField(field)).toBe(true);
    expect(editsWithPicker(field)).toBe(true);
    expect(toGridField(linkField({ nope: true }, 'fld_Broken0000000001')).link).toBeUndefined();
  });

  it('draws chips; copies readable titles only', () => {
    const cell = renderCell(field, [A, LOCKED, B], ctx);
    expect(cell.kind).toBe(GridCellKind.Custom);
    if (!isLinksCell(cell)) throw new Error('not a links cell');
    expect(cell.data.chips).toEqual([A, LOCKED, B]);
    expect(cell.data.lockedLabel).toBe('No access');
    expect(cell.copyData).toBe('An Phát, Bình Minh');
    expect(cell.readonly).toBe(true);
  });

  it('a cell of unreadable records reads "N links" and leaks nothing (P20)', () => {
    const cell = renderCell(field, [LOCKED, { ...LOCKED, id: 'rec_DDDDDDDDDDDDDDDD' }], ctx);
    if (!isLinksCell(cell)) throw new Error('not a links cell');
    expect(cell.copyData).toBe('2 links');
    expect(cell.data.countLabel).toBe('2 links');
    expect(JSON.stringify(cell)).not.toContain('An Phát');
  });

  it('an empty cell is empty', () => {
    expect(renderCell(field, null, ctx)).toMatchObject({ kind: GridCellKind.Text, data: '' });
    expect(renderCell(field, [], ctx)).toMatchObject({ kind: GridCellKind.Text, data: '' });
  });

  it('clipboard: titles out, titles split by commas in', () => {
    expect(cellClipboardText(field, [A, LOCKED, B], ctx.locale)).toBe('An Phát, Bình Minh');
    expect(pastedWriteValue(field, 'An Phát, Bình Minh')).toEqual(['An Phát', 'Bình Minh']);
    expect(pastedWriteValue(field, '')).toBeNull();
    // The cell keeps its value until the server resolves the titles.
    expect(pastedDisplay(field, 'An Phát', ctx.locale)).toBeUndefined();
    expect(clipboardKindOf(field)).toBe(`link:${CUSTOMERS}`);
    const other = toGridField(
      linkField({ link_table: 'tbl_Products00000001' }, 'fld_Product000000001'),
    );
    expect(clipboardKindOf(other)).not.toBe(clipboardKindOf(field));
  });
});

describe('chip layout', () => {
  const more = (count: number) => 20 + String(count).length * 7;

  it.each([
    // widths, right edge → drawn chips, "+N"
    [[60, 60, 60], 300, [0, 1, 2], null],
    [[60, 60, 60], 150, [0], 2],
    [[60, 60, 60, 60], 170, [0, 1], 2],
    [[400], 200, [0], null],
  ])('%j in %i px', (widths, right, drawn, count) => {
    const layout = layoutLinkChips(widths, more, 0, right);
    expect(layout.slots.map((slot) => slot.index)).toEqual(drawn);
    expect(layout.more?.count ?? null).toBe(count);
    for (const slot of layout.slots) expect(slot.width).toBeLessThanOrEqual(LINK_CHIP_MAX_WIDTH);
  });

  it('a first chip too wide for the cell shrinks instead of leaving "+N" alone', () => {
    const layout = layoutLinkChips([170, 60], more, 0, 120);
    expect(layout.slots).toHaveLength(1);
    expect(layout.slots[0]?.width).toBeLessThan(120);
    expect(layout.slots[0]?.width).toBeGreaterThanOrEqual(LINK_CHIP_MIN_WIDTH);
    expect(layout.more?.count).toBe(1);
  });

  it('finds the chip under the pointer from the drawn hit areas', () => {
    const data = {
      kind: 'ob-links' as const,
      chips: [A, B],
      lockedLabel: '',
      countLabel: '',
      hits: [
        { start: 8, end: 70, index: 0 },
        { start: 74, end: 120, index: 1 },
        { start: 124, end: 150, index: -1 },
      ],
    };
    expect(linkChipAt(data, 10)).toBe(0);
    expect(linkChipAt(data, 100)).toBe(1);
    expect(linkChipAt(data, 130)).toBe(-1);
    expect(linkChipAt(data, 72)).toBeNull();
  });
});
