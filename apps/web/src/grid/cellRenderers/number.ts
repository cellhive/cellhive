import { numberFieldType, type NumberOptions } from '@cellhive/field-types';
import { GridCellKind } from '@glideapps/glide-data-grid';

import { EMPTY_CELL, type CellRenderer } from './common';

import type { ProgressCell, RatingCell } from '../customCells/meters';
import type { NumberCell } from '@glideapps/glide-data-grid';

/** `style.color` of progress is free text: only a hex color is used, else the accent. */
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

type RatingIcon = Extract<NumberOptions['style'], { type: 'rating' }>['icon'];

/**
 * Text symbols of the rating icons. FRONTEND §9.3 forbids emoji as icons, so
 * icons without a plain text glyph (fire, flash, thumbs up, smile) use a star.
 */
const RATING_SYMBOLS: Readonly<Record<RatingIcon, string>> = {
  star: '★',
  heart: '♥',
  flower: '✿',
  fire: '★',
  flash: '★',
  smile: '★',
  thumbs_up: '★',
};

/**
 * `number` (CONTRACTS §2): plain, percentage and currency as right-aligned
 * text formatted by `field-types` (same text as `cell_format=text`);
 * progress as a bar; rating as symbols.
 */
export const renderNumber: CellRenderer<'number'> = (value, config, ctx) => {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (number === null) return EMPTY_CELL;
  const text = numberFieldType.formatText(number, config.options, ctx.locale);
  const style = config.options.style;
  if (style.type === 'progress') {
    // Percentages are stored as fractions (20% = 0.2); plain progress runs 0–100.
    const fraction = style.percentage ? number : number / 100;
    const cell: ProgressCell = {
      kind: GridCellKind.Custom,
      allowOverlay: false,
      readonly: true,
      copyData: text,
      data: {
        kind: 'ob-progress',
        fraction: Math.min(Math.max(fraction, 0), 1),
        label: text,
        color:
          style.color !== undefined && HEX_COLOR.test(style.color)
            ? style.color
            : ctx.palette.accent,
        track: ctx.palette.track,
      },
    };
    return cell;
  }
  if (style.type === 'rating') {
    const cell: RatingCell = {
      kind: GridCellKind.Custom,
      allowOverlay: false,
      readonly: true,
      copyData: String(number),
      data: {
        kind: 'ob-rating',
        value: Math.min(Math.max(Math.round(number), 0), style.max),
        max: style.max,
        symbol: RATING_SYMBOLS[style.icon],
        color: ctx.palette.warning,
        empty: ctx.palette.track,
      },
    };
    return cell;
  }
  const cell: NumberCell = {
    kind: GridCellKind.Number,
    data: number,
    displayData: text,
    allowOverlay: false,
    readonly: true,
    contentAlign: 'right',
    copyData: text,
  };
  return cell;
};
