import { datetimeFieldType } from '@cellhive/field-types';

import { EMPTY_CELL, textCell, type CellRenderer } from './common';

/**
 * `datetime` (CONTRACTS §2): ISO instant or `YYYY-MM-DD`, written in the
 * field's `style.format` and time zone (the user's zone when the field has
 * none), exactly as `cell_format=text`.
 */
export const renderDatetime: CellRenderer<'datetime'> = (value, config, ctx) => {
  if (typeof value !== 'string' || value === '') return EMPTY_CELL;
  return textCell(datetimeFieldType.formatText(value, config.options, ctx.locale));
};
