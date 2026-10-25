import { renderAttachment } from './attachment';
import { renderAutoNumber } from './auto-number';
import { renderButton } from './button';
import { renderCheckbox } from './checkbox';
import { EMPTY_CELL, textCell, type CellRenderer } from './common';
import { renderComputed } from './computed';
import { renderDatetime } from './datetime';
import { renderLink } from './link';
import { renderNumber } from './number';
import { renderSelect } from './select';
import { renderCreatedAt, renderCreatedBy, renderUpdatedAt, renderUpdatedBy } from './system';
import { renderText } from './text';
import { renderUser } from './user';

import type { CellRenderContext, GridField, GridFieldType } from '../types';
import type { GridCell } from '@glideapps/glide-data-grid';

/** One renderer per field type the grid knows (SPEC §5.5; `attachment` from T418). */
export const CELL_RENDERERS: { readonly [T in GridFieldType]: CellRenderer<T> } = {
  text: renderText,
  number: renderNumber,
  select: renderSelect,
  datetime: renderDatetime,
  checkbox: renderCheckbox,
  user: renderUser,
  created_at: renderCreatedAt,
  updated_at: renderUpdatedAt,
  created_by: renderCreatedBy,
  updated_by: renderUpdatedBy,
  auto_number: renderAutoNumber,
  attachment: renderAttachment,
};

/**
 * Plain text for types without a renderer yet (link, parent, lookup, formula
 * arrive in S4): scalars as text, `{ title }`/`{ name }` objects by
 * their title or name.
 */
export function fallbackText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(fallbackText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const { title, name } = value as { title?: unknown; name?: unknown };
    if (typeof title === 'string') return title;
    if (typeof name === 'string') return name;
  }
  return '';
}

/** The glide cell of `value` in a column of `field`. */
export function renderCell(field: GridField, value: unknown, ctx: CellRenderContext): GridCell {
  // Link (T413): chips of the linked records' titles, locked chips without access.
  if (field.link !== undefined) return renderLink(value, ctx);
  // Formula / lookup (T468): by result type, read-only; locks, error tokens, progress.
  if (field.computed !== undefined) return renderComputed(value, field.computed, ctx, field);
  // Button (T525): the reader's state as the server computed it.
  if (field.button !== undefined) return renderButton(value, field.button, ctx);
  const config = field.config;
  if (config === null) {
    const text = fallbackText(value);
    return text === '' ? EMPTY_CELL : textCell(text);
  }
  const renderer = CELL_RENDERERS[config.type] as CellRenderer;
  return renderer(value, config, ctx, field);
}
