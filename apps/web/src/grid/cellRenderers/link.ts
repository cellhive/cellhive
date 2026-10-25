import { GridCellKind } from '@glideapps/glide-data-grid';

import { linkRefsOf, linkText } from '../../lib/links/values';

import { EMPTY_CELL } from './common';

import type { LinksCell } from '../customCells/links';
import type { CellRenderContext } from '../types';
import type { GridCell } from '@glideapps/glide-data-grid';

/**
 * `link` (T413, CONTRACTS §2): chips of the linked records' titles; a record
 * the user cannot read (`title = null`, P20) is a locked chip. What is
 * copied (and read by screen readers) is the readable titles separated by
 * commas, like `cell_format=text` — never an id.
 */
export function renderLink(value: unknown, ctx: CellRenderContext): GridCell {
  const chips = linkRefsOf(value);
  if (chips.length === 0) return EMPTY_CELL;
  const count = ctx.labels.linkCount?.(chips.length) ?? String(chips.length);
  const text = linkText(chips);
  const cell: LinksCell = {
    kind: GridCellKind.Custom,
    allowOverlay: false,
    readonly: true,
    copyData: text === '' ? count : text,
    data: {
      kind: 'ob-links',
      chips,
      lockedLabel: ctx.labels.noAccess ?? '',
      countLabel: count,
      hits: [],
    },
  };
  return cell;
}
