import { GridCellKind } from '@glideapps/glide-data-grid';

import { buttonViewOf, type ButtonColumn, type ButtonView } from '../../lib/buttons/model';
import { withAlphaHex } from '../theme';

import { colorAt } from './common';

import type { ButtonCanvasCell } from '../customCells/button';
import type { CellRenderContext } from '../types';

/**
 * `button` (T525, CONTRACTS §2): `{ state, reason }` computed by the server
 * for the reader; `running` while a click of the user runs (the page knows,
 * `GridViewProps.hooks.buttons`). Never editable; the reason of a disabled
 * cell is its tooltip (`GridView`). Screen readers get the label and the
 * state.
 */
export function renderButton(
  value: unknown,
  column: ButtonColumn,
  ctx: CellRenderContext,
  running = false,
): ButtonCanvasCell {
  const view: ButtonView = buttonViewOf(value, running);
  const palette = ctx.palette;
  const chip = colorAt(column.color, palette.options);
  const colors =
    view.state === 'disabled'
      ? { bg: palette.sunken, fg: palette.textSubtle, border: palette.border }
      : { bg: chip.bg, fg: chip.fg, border: withAlphaHex(chip.fg, 0.28) };
  const text = view.state === 'running' ? (ctx.labels.buttonRunning ?? column.label) : column.label;
  const state = ctx.labels.buttonStates?.[view.state];
  return {
    kind: GridCellKind.Custom,
    allowOverlay: false,
    readonly: true,
    copyData: state === undefined ? column.label : `${column.label}, ${state}`,
    data: { kind: 'ob-button', text, state: view.state, colors },
  };
}
