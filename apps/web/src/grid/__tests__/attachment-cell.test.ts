import { GridCellKind } from '@glideapps/glide-data-grid';
import { describe, expect, it } from 'vitest';

import { themeTokens } from '../../../test/tokens';
import { renderCell } from '../cellRenderers/index';
import { defaultColumnWidth, headerIconOf } from '../columns';
import {
  MAX_TILES,
  tileSize,
  visibleTiles,
  type AttachmentsCell,
} from '../customCells/attachments';
import { tokensToAppearance } from '../theme';
import { toGridField, type CellRenderContext } from '../types';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-25T00:00:00.000Z';
const FIELD: FieldDto = {
  id: 'fld_Photos0000000001',
  table_id: 'tbl_Products00000001',
  name: 'Ảnh sản phẩm',
  type: 'attachment',
  options: { accept: ['image/png', 'image/jpeg'], max_files: 8 },
  is_primary: false,
  required: false,
  unique_values: false,
  description: null,
  position: 2,
  created_at: NOW,
  updated_at: NOW,
};

const palette = tokensToAppearance(themeTokens('light')).palette;

function context(canView: boolean): CellRenderContext {
  return {
    locale: { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' },
    palette,
    labels: { formerMember: 'Former member', uploadHint: 'Kéo thả hoặc bấm để tải lên' },
    files: { canView: () => canView },
  };
}

const PNG = {
  id: 'att_Front00000000001',
  name: 'mat-truoc.png',
  size: 412_000,
  mime: 'image/png',
  url: '/api/v1/files/att_Front00000000001',
  thumbnail_url: null,
};
const THUMBED = {
  ...PNG,
  id: 'att_Side000000000001',
  name: 'canh-ben.png',
  thumbnail_url: '/api/v1/files/att_Side000000000001/thumbnail',
};
const PDF = {
  id: 'att_Guide00000000001',
  name: 'huong-dan-lap-dat.pdf',
  size: 1_800_000,
  mime: 'application/pdf',
  url: '/api/v1/files/att_Guide00000000001',
  thumbnail_url: null,
};

function cellOf(value: unknown, canView = true): AttachmentsCell {
  const cell = renderCell(toGridField(FIELD), value, context(canView)) as AttachmentsCell;
  expect(cell.kind).toBe(GridCellKind.Custom);
  return cell;
}

describe('attachment cells (T418, board S4 "Ô tệp đính kèm")', () => {
  it('parses the field for the grid (no plain-text fallback any more)', () => {
    const gridField = toGridField(FIELD);
    expect(gridField.config).toMatchObject({
      type: 'attachment',
      options: { max_files: 8, accept: ['image/png', 'image/jpeg'] },
    });
    expect(headerIconOf(gridField)).toBe('ob-attachment');
    expect(defaultColumnWidth(gridField)).toBe(180);
  });

  it('draws raster images as thumbnails (thumbnail_url first) and other files as badges', () => {
    const cell = cellOf([PNG, THUMBED, PDF]);
    expect(cell.data.tiles).toEqual([
      { type: 'image', url: PNG.url, name: PNG.name },
      { type: 'image', url: THUMBED.thumbnail_url, name: THUMBED.name },
      { type: 'badge', label: 'PDF', color: palette.options[4], name: PDF.name, picture: false },
    ]);
    // Screen readers and copy get the names (as `cell_format=text`).
    expect(cell.copyData).toBe('mat-truoc.png, canh-ben.png, huong-dan-lap-dat.pdf');
  });

  it('without the right to download, loads thumbnails only (T407), never the file itself', () => {
    expect(cellOf([PNG]).data.tiles[0]?.type).toBe('image');
    // No thumbnail: the API would answer 403 to the file itself.
    expect(cellOf([PNG], false).data.tiles).toEqual([
      expect.objectContaining({ type: 'badge', picture: true, name: PNG.name }),
    ]);
    // A thumbnail only needs read permission.
    expect(cellOf([THUMBED], false).data.tiles).toEqual([
      { type: 'image', url: THUMBED.thumbnail_url, name: THUMBED.name },
    ]);
  });

  it('never loads SVG or HTML as an image', () => {
    const svg = { ...PNG, name: 'logo.svg', mime: 'image/svg+xml' };
    const html = { ...PDF, name: 'page.html', mime: 'text/html' };
    expect(cellOf([svg, html]).data.tiles.map((tile) => tile.type)).toEqual(['badge', 'badge']);
  });

  it('an empty cell holds the upload hint (drawn only while selected and editable)', () => {
    const cell = cellOf(null);
    expect(cell.data.tiles).toEqual([]);
    expect(cell.data.hint).toBe('Kéo thả hoặc bấm để tải lên');
    expect(cell.copyData).toBe('');
  });

  it.each([
    [34, 24],
    [44, 28],
  ])('rows of %i px get %i px tiles', (row, size) => {
    expect(tileSize(row)).toBe(size);
  });

  it.each([
    // files, width → tiles shown (then "+N" for the rest)
    [1, 164, 1],
    [4, 164, 4],
    [6, 164, 4],
    [6, 100, 2],
    [2, 20, 0],
  ])('%i files in %i px: %i tiles', (count, width, shown) => {
    expect(visibleTiles(count, width, 24, () => 26)).toBe(shown);
    expect(shown).toBeLessThanOrEqual(MAX_TILES);
  });
});
