import { EMPTY_CELL, monoTheme, textCell, type CellRenderer } from './common';

/** `auto_number` (CONTRACTS §2): the generated code, in the monospace font. */
export const renderAutoNumber: CellRenderer<'auto_number'> = (value, _config, ctx) =>
  typeof value === 'string' && value !== ''
    ? textCell(value, { themeOverride: monoTheme(ctx) })
    : EMPTY_CELL;
