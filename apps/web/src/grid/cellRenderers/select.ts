import { selectFieldType } from '@cellhive/field-types';
import { GridCellKind } from '@glideapps/glide-data-grid';

import { colorAt, EMPTY_CELL, type CellRenderer } from './common';

import type { Chip, ChipsCell } from '../customCells/chips';

/**
 * `select` (CONTRACTS §2): option names (single: a string, multiple: an
 * array) as chips in the option color. An option without `color` takes its
 * position in the option list, so neighbouring options differ.
 */
export const renderSelect: CellRenderer<'select'> = (value, config, ctx) => {
  const names = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
  if (names.length === 0) return EMPTY_CELL;
  const options = config.options.options;
  const chips: Chip[] = names.map((name) => {
    const index = options.findIndex((option) => option.name === name);
    const color = index === -1 ? 0 : (options[index]?.color ?? index);
    return { label: name, color: colorAt(color, ctx.palette.options) };
  });
  const cell: ChipsCell = {
    kind: GridCellKind.Custom,
    allowOverlay: false,
    readonly: true,
    copyData: selectFieldType.formatText(
      config.options.multiple ? names : (names[0] ?? null),
      config.options,
      ctx.locale,
    ),
    data: { kind: 'ob-chips', chips },
  };
  return cell;
};
