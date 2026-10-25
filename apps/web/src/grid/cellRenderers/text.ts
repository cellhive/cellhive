import { isInvalidForTextStyle, textFieldType } from '@cellhive/field-types';
import { GridCellKind } from '@glideapps/glide-data-grid';

import { linkTarget } from '../display/text';

import { EMPTY_CELL, monoTheme, textCell, type CellRenderer } from './common';

export { linkTarget };

import type { CellRenderContext } from '../types';
import type { Theme, UriCell } from '@glideapps/glide-data-grid';

const invalidThemes = new WeakMap<object, Partial<Theme>>();

/** Text color of a value in the wrong format (one object per palette). */
function invalidTheme(ctx: CellRenderContext): Partial<Theme> {
  let theme = invalidThemes.get(ctx.palette);
  if (theme === undefined) {
    theme = { textDark: ctx.palette.danger };
    invalidThemes.set(ctx.palette, theme);
  }
  return theme;
}

/** Opens a link in a new tab without giving it access to this page (FRONTEND §12). */
export function openLink(href: string): void {
  window.open(href, '_blank', 'noopener,noreferrer');
}

/** `text` with styles plain, url, email, phone (links) and barcode (monospace). */
export const renderText: CellRenderer<'text'> = (value, config, ctx) => {
  const text = textFieldType.formatText(
    typeof value === 'string' ? value : null,
    config.options,
    ctx.locale,
  );
  if (text === '') return EMPTY_CELL;
  const style = config.options.style.type;
  if (style === 'barcode') return textCell(text, { themeOverride: monoTheme(ctx) });
  // T414 (SPEC §5.5 item 5): a value not matching the email/phone style is kept and
  // marked — a warning sign and the danger color, never rewritten; copy gives the value.
  if (isInvalidForTextStyle(text, style)) {
    return { ...textCell(text, { themeOverride: invalidTheme(ctx) }), displayData: `⚠ ${text}` };
  }
  const href = linkTarget(style, text);
  if (href === null) return textCell(text);
  const cell: UriCell = {
    kind: GridCellKind.Uri,
    data: text,
    displayData: text,
    allowOverlay: false,
    readonly: true,
    hoverEffect: true,
    copyData: text,
    onClickUri: (args) => {
      args.preventDefault();
      openLink(href);
    },
  };
  return cell;
};
