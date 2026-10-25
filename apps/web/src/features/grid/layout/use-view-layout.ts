import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { gridLayoutPreferenceKey, readPreference, writePreference } from '../../../lib/preferences';
import { viewSessions } from '../../../lib/views/session';
import { useViewConfig, type ViewConfigState } from '../../../lib/views/use-view-config';

import {
  clampWidth,
  layoutOf,
  legacyLayoutPatch,
  moveInOrder,
  orderFields,
  rowHeightOf,
  setHidden,
  type ColumnLayout,
  type ColumnSort,
} from './column-layout';

import type { GridDensity, GridField } from '../../../grid';
import type { ViewDto } from '@cellhive/contracts';

export interface ColumnLayoutActions {
  readonly hide: (fieldId: string) => void;
  readonly show: (fieldId: string) => void;
  /** Shows every field, or hides every field but the primary one. */
  readonly setAllHidden: (hide: boolean, fieldIds: readonly string[]) => void;
  /** Freezes the visible columns up to and including the one at `visibleIndex`. */
  readonly freezeThrough: (visibleIndex: number) => void;
  /** Live width while dragging (`done = false`) and the final one (saved). */
  readonly resize: (fieldId: string, width: number, done: boolean) => void;
  /** One sort key from the header menu, or none. */
  readonly sortBy: (sort: ColumnSort | null) => void;
  /** Column drag: `fieldId` takes the place of `targetFieldId` in the view's `field_order`. */
  readonly move: (fieldId: string, targetFieldId: string) => void;
  readonly setDensity: (density: GridDensity) => void;
}

export interface ViewLayout {
  readonly layout: ColumnLayout;
  /** Every field (hidden ones too) in the view's column order. */
  readonly ordered: readonly GridField[];
  readonly actions: ColumnLayoutActions;
  readonly view: ViewConfigState;
}

/**
 * Moves the T207 device layout of the table (`cellhive.gridLayout.<tableId>`)
 * into temporary changes of the grid view being opened, once: the key is
 * deleted. Never saved silently — shared views change for everyone; the
 * user saves, saves as a personal view, or discards (view bar).
 */
export function migrateLegacyLayout(tableId: string, viewId: string): boolean {
  const key = gridLayoutPreferenceKey(tableId);
  const raw = readPreference(key);
  if (raw === null) return false;
  writePreference(key, null);
  const patch = legacyLayoutPatch(raw);
  if (patch === null) return false;
  viewSessions.setTemporary(viewId, patch);
  return true;
}

/**
 * Column layout of a grid view (FRONTEND §2, §3.2): read from the effective
 * view config; changes are saved to the view (debounced, optimistic) when
 * the user may, else kept on this device as unsaved changes. Sort and row
 * height are always temporary until saved (T311, like filter and group).
 */
export function useViewLayout(
  view: ViewDto,
  fields: readonly GridField[],
  canSave: boolean,
): ViewLayout {
  const state = useViewConfig(view, canSave);
  const { change } = state;

  const migrated = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (migrated.current === view.table_id || view.type !== 'grid') return;
    migrated.current = view.table_id;
    migrateLegacyLayout(view.table_id, view.id);
  }, [view.table_id, view.id, view.type]);

  const fieldIds = useMemo(() => new Set(fields.map((field) => field.field.id)), [fields]);
  const [liveWidth, setLiveWidth] = useState<{ fieldId: string; width: number } | null>(null);
  const saved = useMemo(() => layoutOf(state.config, fieldIds), [state.config, fieldIds]);
  const layout = useMemo(
    () =>
      liveWidth === null
        ? saved
        : { ...saved, widths: { ...saved.widths, [liveWidth.fieldId]: liveWidth.width } },
    [saved, liveWidth],
  );
  const ordered = useMemo(() => orderFields(fields, saved.order), [fields, saved.order]);

  // Latest values for the actions without re-creating them on every change.
  const current = useRef({ saved, ordered });
  useLayoutEffect(() => {
    current.current = { saved, ordered };
  });

  const resize = useCallback(
    (fieldId: string, width: number, done: boolean) => {
      const clamped = clampWidth(width);
      if (!done) {
        setLiveWidth({ fieldId, width: clamped });
        return;
      }
      setLiveWidth(null);
      change({ column_widths: { ...current.current.saved.widths, [fieldId]: clamped } });
    },
    [change],
  );

  const actions = useMemo<ColumnLayoutActions>(
    () => ({
      hide: (fieldId) => {
        change({ hidden_fields: setHidden(current.current.saved.hidden, fieldId, true) });
      },
      show: (fieldId) => {
        change({ hidden_fields: setHidden(current.current.saved.hidden, fieldId, false) });
      },
      setAllHidden: (hide, ids) => {
        change({ hidden_fields: hide ? [...ids] : [] });
      },
      freezeThrough: (visibleIndex) => {
        change({ frozen_count: Math.max(1, visibleIndex + 1) });
      },
      resize,
      sortBy: (sort) => {
        // Temporary until saved, like the toolbar's sort (T311).
        change(
          { sort: sort === null ? [] : [{ field: sort.field, direction: sort.direction }] },
          { temporary: true },
        );
      },
      move: (fieldId, targetFieldId) => {
        const ids = current.current.ordered
          .filter((field) => !field.field.is_primary)
          .map((field) => field.field.id);
        const next = moveInOrder(ids, fieldId, targetFieldId);
        change({ field_order: next });
      },
      setDensity: (density) => {
        change({ row_height: rowHeightOf(density) }, { temporary: true });
      },
    }),
    [change, resize],
  );

  return { layout, ordered, actions, view: state };
}
