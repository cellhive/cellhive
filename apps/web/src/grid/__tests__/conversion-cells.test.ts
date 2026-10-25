import { GridCellKind } from '@glideapps/glide-data-grid';
import { describe, expect, it } from 'vitest';

import { themeTokens } from '../../../test/tokens';
import { renderCell } from '../cellRenderers/index';
import { convertingColumnTheme, headerIcon, toGridColumns } from '../columns';
import { tokensToAppearance } from '../theme';
import { toGridField, type CellRenderContext } from '../types';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-26T00:00:00.000Z';
const palette = tokensToAppearance(themeTokens('light')).palette;
const ctx: CellRenderContext = {
  locale: { locale: 'en', timeZone: 'UTC' },
  palette,
  labels: { formerMember: 'Former member' },
};

function field(overrides: Partial<FieldDto> = {}): FieldDto {
  return {
    id: 'fld_Contact000000001',
    table_id: 'tbl_Tickets000000001',
    name: 'Contact',
    type: 'text',
    options: { style: { type: 'email' } },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe('text in the wrong email/phone format (T414, SPEC §5.5 item 5)', () => {
  it('marks it, keeps the value to copy', () => {
    const cell = renderCell(toGridField(field()), 'an.phat@gmail', ctx);
    expect(cell.kind).toBe(GridCellKind.Text);
    expect(cell).toMatchObject({
      displayData: '⚠ an.phat@gmail',
      copyData: 'an.phat@gmail',
      themeOverride: { textDark: palette.danger },
    });
  });

  it.each([
    [{ style: { type: 'email' } }, 'an@example.test'],
    [{ style: { type: 'phone' } }, '0905 118 442'],
    [{ style: { type: 'plain' } }, 'anything'],
  ])('leaves a valid value alone (%j)', (options, value) => {
    const cell = renderCell(toGridField(field({ options })), value, ctx);
    expect(cell).not.toHaveProperty('displayData', `⚠ ${value}`);
  });

  it('marks a phone number that is not one', () => {
    const cell = renderCell(
      toGridField(field({ options: { style: { type: 'phone' } } })),
      'call me',
      ctx,
    );
    expect(cell).toMatchObject({ displayData: '⚠ call me' });
  });
});

describe('columns of fields being converted (T414)', () => {
  const conversion = {
    job_id: 'job_0000000000000001' as const,
    status: 'running' as const,
    from_type: 'text' as const,
    to_type: 'number' as const,
    revertible_until: '2026-10-03T00:00:00.000Z',
  };
  const converting = convertingColumnTheme(palette);

  it('lock the header and mute the cells', () => {
    const [column] = toGridColumns([toGridField(field({ conversion }))], {
      hasMenu: true,
      converting,
    });
    expect(column).toMatchObject({ icon: headerIcon('lock'), themeOverride: converting.cells });
    expect(converting.cells.textDark).toBe(palette.textMuted);
  });

  it('link conversions only mark the header (cells stay editable)', () => {
    const [column] = toGridColumns(
      [toGridField(field({ conversion: { ...conversion, link_change: 'to_two_way' } }))],
      { hasMenu: true, converting },
    );
    expect(column?.themeOverride).toBe(converting.header);
  });

  it('a finished conversion looks like any column', () => {
    const [column] = toGridColumns(
      [toGridField(field({ conversion: { ...conversion, status: 'succeeded' } }))],
      { hasMenu: true, converting },
    );
    expect(column).not.toHaveProperty('themeOverride');
    expect(convertingColumnTheme(palette)).toBe(converting);
  });
});
