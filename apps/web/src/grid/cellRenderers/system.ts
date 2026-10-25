import { createdAtFieldType, updatedAtFieldType } from '@cellhive/field-types';

import { EMPTY_CELL, textCell, type CellRenderer } from './common';
import { usersCell } from './user';

/** `created_at`: record creation time in the field format and zone. */
export const renderCreatedAt: CellRenderer<'created_at'> = (value, config, ctx) =>
  typeof value === 'string'
    ? textCell(createdAtFieldType.formatText(value, config.options, ctx.locale))
    : EMPTY_CELL;

/** `updated_at`: time of the last change in the field format and zone. */
export const renderUpdatedAt: CellRenderer<'updated_at'> = (value, config, ctx) =>
  typeof value === 'string'
    ? textCell(updatedAtFieldType.formatText(value, config.options, ctx.locale))
    : EMPTY_CELL;

/** `created_by`: the creator as avatar + name. */
export const renderCreatedBy: CellRenderer<'created_by'> = (value, _config, ctx) =>
  usersCell(value, ctx);

/** `updated_by`: the last editor as avatar + name. */
export const renderUpdatedBy: CellRenderer<'updated_by'> = (value, _config, ctx) =>
  usersCell(value, ctx);
