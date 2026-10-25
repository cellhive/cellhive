import { colorAt } from '../cellRenderers/common';
import { cellClipboardText } from '../clipboard';

import type { Chip } from '../customCells/chips';
import type { CellRenderContext, GridField } from '../types';

/** How a group header shows its value: select values as chips, anything else as text. */
export interface GroupValueDisplay {
  readonly text: string;
  readonly chips: Chip[] | null;
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * The value of a group level (json cell format, as `records/group-counts`
 * returns it) for its header (T312): select options as chips in their
 * colors, users by name, other types in the cell's text format. `empty` is
 * the translated label of an empty value.
 */
export function groupValueDisplay(
  field: GridField | undefined,
  value: unknown,
  ctx: CellRenderContext,
  empty: string,
): GroupValueDisplay {
  if (isEmpty(value) || field === undefined) return { text: empty, chips: null };
  const config = field.config;
  if (config?.type === 'select') {
    const names = (Array.isArray(value) ? value : [value]).filter(
      (item): item is string => typeof item === 'string',
    );
    const options = config.options.options;
    const chips = names.map((name) => {
      const index = options.findIndex((option) => option.name === name);
      const color = index === -1 ? 0 : (options[index]?.color ?? index);
      return { label: name, color: colorAt(color, ctx.palette.options) };
    });
    return { text: names.join(', '), chips };
  }
  if (['user', 'created_by', 'updated_by'].includes(field.field.type)) {
    const users = (Array.isArray(value) ? value : [value]) as {
      name?: unknown;
      email?: unknown;
    }[];
    const names = users.map((user) =>
      typeof user.name === 'string'
        ? user.name
        : typeof user.email === 'string'
          ? user.email
          : ctx.labels.formerMember,
    );
    return { text: names.join(', '), chips: null };
  }
  const text = cellClipboardText(field, value, ctx.locale);
  return { text: text === '' ? empty : text, chips: null };
}
