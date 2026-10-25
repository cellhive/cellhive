import { isId, MAX_FROZEN_COUNT } from '@cellhive/contracts';
import { z } from 'zod';

import type { GridDensity, GridField } from '../../../grid';
import type { EffectiveViewConfig, ViewConfigPatch } from '../../../lib/views/config';

/**
 * Column layout of a grid view (T207, saved in the view config since T310,
 * CONTRACTS §15): hidden fields, column order, frozen columns, widths, sort
 * and row height. Ids the caller cannot see (deleted, not readable) are
 * dropped when read.
 */
export interface ColumnLayout {
  /** Hidden field ids; the primary field is never hidden. */
  readonly hidden: readonly string[];
  /** Column order of the view (`field_order`); fields not listed follow their server place. */
  readonly order: readonly string[];
  /** Visible columns kept in place when scrolling sideways (≥ 1: the primary field). */
  readonly frozen: number;
  /** Resized widths by field id. */
  readonly widths: Readonly<Record<string, number>>;
  /** Sort keys of the view (the header menu sets one). */
  readonly sort: readonly ColumnSort[];
  readonly rowHeight: RowHeight;
}

export interface ColumnSort {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

export type RowHeight = EffectiveViewConfig['row_height'];

/** Glide's resize limits (`minColumnWidth` / `maxColumnWidth` defaults); the contract allows 40..2000. */
export const MIN_COLUMN_WIDTH = 50;
export const MAX_COLUMN_WIDTH = 500;

export function clampWidth(width: number): number {
  return Math.round(Math.min(Math.max(width, MIN_COLUMN_WIDTH), MAX_COLUMN_WIDTH));
}

/** The layout of a (effective) view config, restricted to the fields in `fieldIds`. */
export function layoutOf(config: EffectiveViewConfig, fieldIds: ReadonlySet<string>): ColumnLayout {
  const known = (id: string) => fieldIds.has(id);
  return {
    hidden: config.hidden_fields.filter(known),
    order: config.field_order.filter(known),
    frozen: config.frozen_count,
    widths: Object.fromEntries(
      Object.entries(config.column_widths)
        .filter(([id]) => known(id))
        .map(([id, width]) => [id, clampWidth(width)]),
    ),
    sort: config.sort.filter((key) => known(key.field)),
    rowHeight: config.row_height,
  };
}

export { orderFields } from '../../../grid';

/**
 * New `field_order` after dragging `fieldId` onto `targetId` (it takes the
 * target's place, the others shift). `ids`: every non-primary field in the
 * current column order, hidden ones included.
 */
export function moveInOrder(ids: readonly string[], fieldId: string, targetId: string): string[] {
  const from = ids.indexOf(fieldId);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, fieldId);
  return next;
}

/** Columns to draw: the fields in display order minus the hidden ones. */
export function visibleColumns(
  fields: readonly GridField[],
  hidden: readonly string[],
): GridField[] {
  if (hidden.length === 0) return [...fields];
  const hiddenSet = new Set(hidden);
  return fields.filter((field) => field.field.is_primary || !hiddenSet.has(field.field.id));
}

/** Frozen count within `1..visible` (0 without columns). */
export function frozenCount(layout: Pick<ColumnLayout, 'frozen'>, visible: number): number {
  return Math.max(Math.min(layout.frozen, visible), Math.min(visible, 1));
}

export function setHidden(hidden: readonly string[], fieldId: string, hide: boolean): string[] {
  const rest = hidden.filter((id) => id !== fieldId);
  return hide ? [...rest, fieldId] : rest;
}

/** The grid draws two row heights; taller view settings use the comfortable one. */
export function densityOf(rowHeight: RowHeight): GridDensity {
  return rowHeight === 'short' ? 'compact' : 'comfortable';
}

export function rowHeightOf(density: GridDensity): RowHeight {
  return density === 'compact' ? 'short' : 'medium';
}

const fieldIdSchema = z.string().refine((value) => isId('fld', value));

// The T207 device layout (`cellhive.gridLayout.<tableId>`): untrusted, each part on its own.
const legacyLayoutSchema = z.object({
  hidden: z.array(fieldIdSchema).max(1000).catch([]),
  frozen: z.int().min(1).max(1000).catch(1),
  widths: z.record(fieldIdSchema, z.number().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH)).catch({}),
  sort: z
    .object({ field: fieldIdSchema, direction: z.enum(['asc', 'desc']) })
    .nullable()
    .catch(null),
});

/**
 * The T207 device layout as a config patch (only the parts that were set),
 * or `null` when nothing usable was stored.
 */
export function legacyLayoutPatch(raw: string | null): ViewConfigPatch | null {
  if (raw === null) return null;
  let parsed: z.infer<typeof legacyLayoutSchema>;
  try {
    const result = legacyLayoutSchema.safeParse(JSON.parse(raw));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  const patch: ViewConfigPatch = {};
  if (parsed.hidden.length > 0) patch.hidden_fields = parsed.hidden;
  if (parsed.frozen !== 1) patch.frozen_count = Math.min(parsed.frozen, MAX_FROZEN_COUNT);
  if (Object.keys(parsed.widths).length > 0) {
    patch.column_widths = Object.fromEntries(
      Object.entries(parsed.widths).map(([id, width]) => [id, Math.round(width)]),
    );
  }
  if (parsed.sort !== null) patch.sort = [parsed.sort];
  return Object.keys(patch).length === 0 ? null : patch;
}
