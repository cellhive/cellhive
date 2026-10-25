import { GridCellKind } from '@glideapps/glide-data-grid';

import type { CellRenderer } from './common';
import type { BooleanCell } from '@glideapps/glide-data-grid';

/**
 * `checkbox` (CONTRACTS §2): a centered check box. Glide fills a checked box
 * with `textMedium` (grey, like a disabled control) unless the cell is
 * selected; it is filled with the accent here, as in the record panel (S2 QA).
 */
export const renderCheckbox: CellRenderer<'checkbox'> = (value, _config, ctx) => {
  const checked = value === true;
  const cell: BooleanCell = {
    kind: GridCellKind.Boolean,
    data: checked,
    allowOverlay: false,
    readonly: true,
    contentAlign: 'center',
    copyData: checked ? '✓' : '',
    ...(checked ? { themeOverride: { textMedium: ctx.palette.accent } } : {}),
  };
  return cell;
};
