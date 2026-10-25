import { GridCellKind } from '@glideapps/glide-data-grid';

import type { ChipColor } from '../theme';
import type { CellRenderContext, GridField } from '../types';
import type { FieldConfig } from '@cellhive/field-types';
import type { GridCell, LoadingCell, TextCell, Theme } from '@glideapps/glide-data-grid';

/**
 * Maps a json cell value (CONTRACTS §2, `cell_format=json`) of one field
 * type to a glide cell. `config` is the field's parsed `{ type, options }`.
 * Every cell is read-only until the editors of T203 arrive.
 */
export type CellRenderer<T extends FieldConfig['type'] = FieldConfig['type']> = (
  value: unknown,
  config: Extract<FieldConfig, { type: T }>,
  ctx: CellRenderContext,
  field: GridField,
) => GridCell;

export interface TextCellOptions {
  readonly align?: 'left' | 'right' | 'center';
  readonly themeOverride?: Partial<Theme>;
}

/** A read-only text cell; `copyData` is also what screen readers get. */
export function textCell(text: string, options: TextCellOptions = {}): TextCell {
  return {
    kind: GridCellKind.Text,
    data: text,
    displayData: text,
    allowOverlay: false,
    readonly: true,
    copyData: text,
    ...(options.align === undefined ? {} : { contentAlign: options.align }),
    ...(options.themeOverride === undefined ? {} : { themeOverride: options.themeOverride }),
  };
}

/** An empty cell of any type. */
export const EMPTY_CELL: TextCell = textCell('');

/** Skeleton of a row whose block is not loaded yet (FRONTEND §3.3). */
export function loadingCell(width = 72): LoadingCell {
  return {
    kind: GridCellKind.Loading,
    allowOverlay: false,
    skeletonWidth: width,
    skeletonHeight: 10,
    skeletonWidthVariability: 24,
  };
}

/** Deterministic color of an id (avatars): the same user always gets the same color. */
export function colorOfId(id: string, colors: readonly ChipColor[]): ChipColor {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return colors[Math.abs(hash) % colors.length] as ChipColor;
}

/** Option color index → palette entry (indexes wrap around the palette). */
export function colorAt(index: number, colors: readonly ChipColor[]): ChipColor {
  return colors[((index % colors.length) + colors.length) % colors.length] as ChipColor;
}

const monoThemes = new WeakMap<object, Partial<Theme>>();

/** Monospace override for codes (auto numbers, barcodes); one object per palette. */
export function monoTheme(ctx: CellRenderContext): Partial<Theme> {
  let theme = monoThemes.get(ctx.palette);
  if (theme === undefined) {
    theme = { fontFamily: ctx.palette.fontCode, baseFontStyle: '12px' };
    monoThemes.set(ctx.palette, theme);
  }
  return theme;
}
