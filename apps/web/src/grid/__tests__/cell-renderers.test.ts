import { S1_FIELD_TYPES } from '@cellhive/field-types';
import { GridCellKind, type GridCell } from '@glideapps/glide-data-grid';
import { describe, expect, it, vi } from 'vitest';

import { themeTokens } from '../../../test/tokens';
import { CELL_RENDERERS, fallbackText, renderCell } from '../cellRenderers/index';
import { linkTarget } from '../cellRenderers/text';
import { initialsOf } from '../cellRenderers/user';
import { defaultColumnWidth, HEADER_ICONS, headerIconOf, toGridColumns } from '../columns';
import { tokensToAppearance } from '../theme';
import { orderGridFields, toGridField, type CellRenderContext } from '../types';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-24T00:00:00.000Z';
let position = 0;

function field(type: string, options: Record<string, unknown> = {}, name = type): FieldDto {
  position += 1;
  return {
    id: `fld_${type.replace(/_/gu, '').padEnd(16, '0').slice(0, 16)}`,
    table_id: 'tbl_Tickets000000001',
    name,
    type: type as FieldDto['type'],
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position,
    created_at: NOW,
    updated_at: NOW,
  };
}

const ctx: CellRenderContext = {
  locale: { locale: 'en', timeZone: 'Asia/Ho_Chi_Minh' },
  palette: tokensToAppearance(themeTokens('light')).palette,
  labels: { formerMember: 'Former member' },
};

const STATUS = {
  multiple: false,
  options: [
    { id: 'opt_New0000000000001', name: 'Mới' },
    { id: 'opt_Doing00000000001', name: 'Đang xử lý', color: 3 },
    { id: 'opt_Done000000000001', name: 'Đã xong', color: 13 },
  ],
};

const USER = { id: 'usr_Lan0000000000001', name: 'Phạm Ngọc Lan', email: 'lan@example.test' };

/** One case per S1 type and style: the value as `cell_format=json` returns it (CONTRACTS §2). */
const CASES: [string, FieldDto, unknown][] = [
  ['text plain', field('text'), 'Máy POS lỗi in'],
  ['text url', field('text', { style: { type: 'url' } }), 'cellhive.io/docs'],
  ['text email', field('text', { style: { type: 'email' } }), 'an@example.test'],
  ['text phone', field('text', { style: { type: 'phone' } }), '+84 90 123 4567'],
  ['text barcode', field('text', { style: { type: 'barcode' } }), '8934563138165'],
  [
    'number plain',
    field('number', { style: { type: 'plain', precision: 2, thousands_separator: true } }),
    1234.5,
  ],
  ['number percentage', field('number', { style: { type: 'plain', percentage: true } }), 0.2],
  [
    'number currency',
    field('number', { style: { type: 'currency', currency_code: 'VND' } }),
    1_500_000,
  ],
  ['number progress', field('number', { style: { type: 'progress' } }), 0.65],
  ['number rating', field('number', { style: { type: 'rating', max: 5 } }), 3],
  ['select single', field('select', STATUS), 'Đang xử lý'],
  ['select multiple', field('select', { ...STATUS, multiple: true }), ['Mới', 'Đã xong', 'Gone']],
  ['datetime date', field('datetime', { style: { format: 'dd/MM/yyyy' } }), '2026-09-25'],
  [
    'datetime time',
    field('datetime', { style: { format: 'dd/MM/yyyy HH:mm' } }),
    '2026-09-25T02:00:00.000Z',
  ],
  [
    'datetime field zone',
    field('datetime', { style: { format: 'yyyy-MM-dd HH:mm' }, timezone: 'UTC' }),
    '2026-09-25T02:00:00.000Z',
  ],
  ['checkbox on', field('checkbox'), true],
  ['checkbox off', field('checkbox'), false],
  ['user', field('user'), [USER, { id: 'usr_Gone000000000001' }]],
  ['created_at', field('created_at'), '2026-09-20T03:15:00.000Z'],
  [
    'updated_at',
    field('updated_at', { style: { format: 'dd/MM/yyyy' } }),
    '2026-09-20T18:15:00.000Z',
  ],
  ['created_by', field('created_by'), USER],
  ['updated_by', field('updated_by'), { id: 'usr_Gone000000000001' }],
  [
    'auto_number',
    field('auto_number', { style: { rules: [{ type: 'incremental_number', length: 4 }] } }),
    'TK-20260920-0042',
  ],
  ['link (S4, fallback)', field('link'), [{ id: 'rec_A1b2C3d4E5f6G7h8', title: 'An Phát' }]],
];

/** The cell without functions (URL click handlers), for the snapshot. */
function plain(cell: GridCell): unknown {
  return JSON.parse(JSON.stringify(cell)) as unknown;
}

describe('cell renderers (FRONTEND §1.3, §11.2 snapshot of GridCell)', () => {
  it('has a renderer for every S1 type and attachments (T418)', () => {
    expect(Object.keys(CELL_RENDERERS).sort()).toEqual([...S1_FIELD_TYPES, 'attachment'].sort());
  });

  it.each(CASES)('%s', (_name, dto, value) => {
    const gridField = toGridField(dto);
    const cell = renderCell(gridField, value, ctx);
    expect(plain(cell)).toMatchSnapshot();
    // Every cell is read-only until T203 and says something to screen readers
    // (an unchecked box is empty, as in `cell_format=text`).
    expect(cell.allowOverlay).toBe(false);
    if (value !== false) expect('copyData' in cell ? cell.copyData : '').not.toBe('');
  });

  it.each(CASES)('%s: null is an empty cell', (_name, dto) => {
    const cell = renderCell(toGridField(dto), null, ctx);
    if (dto.type === 'checkbox') {
      expect(cell).toMatchObject({ kind: GridCellKind.Boolean, data: false });
    } else {
      expect(cell).toMatchObject({ kind: GridCellKind.Text, data: '' });
    }
  });

  it('opens safe links in a new tab without opener', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const cell = renderCell(
      toGridField(field('text', { style: { type: 'url' } })),
      'example.com',
      ctx,
    );
    expect(cell.kind).toBe(GridCellKind.Uri);
    if (cell.kind !== GridCellKind.Uri) return;
    const preventDefault = vi.fn();
    cell.onClickUri?.({ preventDefault } as unknown as Parameters<
      NonNullable<typeof cell.onClickUri>
    >[0]);
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
    expect(preventDefault).toHaveBeenCalled();
  });

  it('shows unsafe links as plain text', () => {
    const cell = renderCell(
      toGridField(field('text', { style: { type: 'url' } })),
      'javascript:alert(1)',
      ctx,
    );
    expect(cell).toMatchObject({ kind: GridCellKind.Text, data: 'javascript:alert(1)' });
  });

  it('ignores a progress color that is not a hex color', () => {
    const dto = field('number', { style: { type: 'progress', color: 'url(x)' } });
    const cell = renderCell(toGridField(dto), 0.5, ctx);
    expect(cell).toMatchObject({ data: { kind: 'ob-progress', color: ctx.palette.accent } });
  });
});

describe('linkTarget (FRONTEND §12: http, https, mailto, tel only)', () => {
  it.each([
    ['url', 'https://cellhive.io/a?b=1', 'https://cellhive.io/a?b=1'],
    ['url', 'cellhive.io', 'https://cellhive.io/'],
    ['url', 'http://intranet.local', 'http://intranet.local/'],
    ['url', 'javascript:alert(1)', null],
    ['url', 'data:text/html,<b>x</b>', null],
    ['url', 'ftp://files.example', null],
    ['email', 'an@example.test', 'mailto:an@example.test'],
    ['email', 'not an email', null],
    ['phone', '+84 (90) 123-4567', 'tel:+84901234567'],
    ['phone', 'call me', null],
    ['plain', 'https://cellhive.io', null],
  ])('%s %s → %s', (style, value, expected) => {
    expect(linkTarget(style, value)).toBe(expected);
  });
});

describe('helpers', () => {
  it.each([
    ['Nguyễn Văn Ánh', 'NÁ'],
    ['An', 'A'],
    ['  trần   thu hà ', 'TH'],
    ['Nguyễn Văn An', 'NA'],
    ['Nguye\u0302\u0303n Tha\u0300nh', 'NT'],
    ['A\u0301nh', 'Á'],
    ['😀 Minh', '😀M'],
    ['👩‍💻', '👩‍💻'],
    ['', ''],
  ])('initials of %s are %s', (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });

  it.each([
    [null, ''],
    ['x', 'x'],
    [3, '3'],
    [[{ title: 'A' }, { name: 'B' }, {}], 'A, B'],
  ])('fallbackText(%j) is %j', (value, text) => {
    expect(fallbackText(value)).toBe(text);
  });
});

describe('columns', () => {
  it('orders the primary field first, then by position', () => {
    const primary = { ...field('text', {}, 'Title'), is_primary: true, position: 5 };
    const status = { ...field('select', STATUS, 'Status'), position: 1 };
    const amount = { ...field('number', {}, 'Amount'), position: 2 };
    expect(orderGridFields([amount, primary, status]).map((item) => item.field.name)).toEqual([
      'Title',
      'Status',
      'Amount',
    ]);
  });

  it.each([
    [field('text'), 'ob-text'],
    [field('text', { style: { type: 'email' } }), 'ob-email'],
    [field('select', STATUS), 'ob-select'],
    [field('select', { ...STATUS, multiple: true }), 'ob-multiSelect'],
    [field('user'), 'ob-user'],
    [field('updated_by'), 'ob-updatedBy'],
    [field('created_at'), 'ob-createdAt'],
    [field('auto_number'), 'ob-autoNumber'],
    [field('lookup'), 'ob-lookup'],
  ])('header icon of %#', (dto, icon) => {
    expect(headerIconOf(toGridField(dto))).toBe(icon);
  });

  it('draws header icons as stroke icons in the theme color (T322a)', () => {
    for (const [name, sprite] of Object.entries(HEADER_ICONS)) {
      const svg = sprite({ fgColor: '#ffffff', bgColor: '#646d79' });
      expect(svg, name).toContain('stroke="#646d79"');
      expect(svg, name).toContain('fill="none"');
      expect(svg, name).toContain('viewBox="0 0 24 24"');
    }
  });

  it('builds glide columns with id, title, icon, width and the menu flag', () => {
    const primary = toGridField({ ...field('text', {}, 'Title'), is_primary: true });
    const done = toGridField(field('checkbox', {}, 'Done'));
    expect(defaultColumnWidth(primary)).toBe(240);
    expect(
      toGridColumns([primary, done], { hasMenu: true, widths: { [done.field.id]: 120 } }),
    ).toEqual([
      { id: primary.field.id, title: 'Title', icon: 'ob-text', width: 240, hasMenu: true },
      { id: done.field.id, title: 'Done', icon: 'ob-checkbox', width: 120, hasMenu: true },
    ]);
  });
});
