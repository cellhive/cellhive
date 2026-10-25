import { describe, expect, it } from 'vitest';

import { themeTokens } from '../../../test/tokens';
import { renderButton } from '../cellRenderers/button';
import { colorAt } from '../cellRenderers/common';
import { renderCell } from '../cellRenderers/index';
import { cellClipboardText } from '../clipboard';
import { defaultColumnWidth, headerIconOf } from '../columns';
import { buttonPillRect } from '../customCells/button';
import { tokensToAppearance } from '../theme';
import { toGridField, type CellRenderContext } from '../types';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-10-06T00:00:00.000Z';
const BUTTON: FieldDto = {
  id: 'fld_Approve000000001',
  table_id: 'tbl_Orders0000000001',
  name: 'Quick approve',
  type: 'button',
  options: { label: 'Approve', color: 5, confirm: null },
  is_primary: false,
  required: false,
  unique_values: false,
  description: null,
  position: 3,
  created_at: NOW,
  updated_at: NOW,
};

const palette = tokensToAppearance(themeTokens('light')).palette;
const ctx: CellRenderContext = {
  locale: { locale: 'en', timeZone: 'UTC' },
  palette,
  labels: {
    formerMember: 'Former member',
    buttonRunning: 'Running…',
    buttonStates: { ready: 'available', disabled: 'unavailable', running: 'Running…' },
  },
};

describe('button cells (T525, Quyết định S5 thiết kế #6)', () => {
  const field = toGridField(BUTTON);

  it('reads the button options into the column; never editable', () => {
    expect(field.button).toMatchObject({ label: 'Approve', color: 5, confirm: null });
    expect(field.config).toBeNull();
    expect(headerIconOf(field)).toBe('ob-button');
    expect(defaultColumnWidth(field)).toBe(160);
  });

  it.each([
    [
      'ready: the light background of its palette color, dark text',
      { state: 'ready', reason: null },
      false,
      { state: 'ready', text: 'Approve', bg: colorAt(5, palette.options).bg },
      'Approve, available',
    ],
    [
      'disabled: grey whatever the color',
      { state: 'disabled', reason: 'condition' },
      false,
      { state: 'disabled', text: 'Approve', bg: palette.sunken },
      'Approve, unavailable',
    ],
    [
      'running: "Running…" until the run ends',
      { state: 'ready', reason: null },
      true,
      { state: 'running', text: 'Running…', bg: colorAt(5, palette.options).bg },
      'Approve, Running…',
    ],
    [
      'an unknown value never runs',
      null,
      false,
      { state: 'disabled', text: 'Approve', bg: palette.sunken },
      'Approve, unavailable',
    ],
  ])('%s', (_name, value, running, drawn, announced) => {
    const cell =
      field.button === undefined ? undefined : renderButton(value, field.button, ctx, running);
    expect(cell?.readonly).toBe(true);
    expect(cell?.data).toMatchObject({
      kind: 'ob-button',
      state: drawn.state,
      text: drawn.text,
      colors: { bg: drawn.bg },
    });
    expect(cell?.copyData).toBe(announced);
  });

  it('goes through renderCell and copies its label (like exports)', () => {
    expect(renderCell(field, { state: 'ready', reason: null }, ctx)).toMatchObject({
      data: { kind: 'ob-button' },
    });
    expect(cellClipboardText(field, { state: 'ready', reason: null }, ctx.locale)).toBe('Approve');
    expect(cellClipboardText(field, undefined, ctx.locale)).toBe('Approve');
  });

  it('places the pill (the click target) left in the cell, at most its width', () => {
    expect(buttonPillRect({ x: 100, y: 10, width: 200, height: 34 }, 50, 8)).toEqual({
      x: 108,
      y: 15,
      width: 88,
      height: 24,
    });
    expect(buttonPillRect({ x: 0, y: 0, width: 60, height: 34 }, 300, 8).width).toBe(44);
  });
});
