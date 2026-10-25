import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { fieldsQuery } from '../query/queries';

import {
  changedKeys,
  effectiveConfig,
  omitKeys,
  unreadableKeys,
  type EffectiveViewConfig,
  type ViewConfigKey,
  type ViewConfigPatch,
} from './config';
import { viewSessions } from './session';

import type { ViewDto } from '@cellhive/contracts';

export interface ChangeOptions {
  /**
   * Keep the change on this device only, even for someone who may save the
   * view (T311: filter, sort, group wait for "Save").
   */
  readonly temporary?: boolean;
}

export interface ViewConfigState {
  /** What the screen shows: saved config + changes being saved + temporary changes. */
  readonly config: EffectiveViewConfig;
  /**
   * The config saved on the server as this user reads it (parts on fields
   * they cannot read left out, CONTRACTS §15): what "changed" compares with.
   */
  readonly saved: EffectiveViewConfig;
  /** Keys with temporary changes that differ from the saved config ("unsaved" indicator). */
  readonly unsaved: readonly ViewConfigKey[];
  /** A save of this view is on its way. */
  readonly saving: boolean;
  /** Whether this user may save the view's config (rights, not locked). */
  readonly canSave: boolean;
  /** Saved (debounced) when allowed, else temporary. */
  readonly change: (patch: ViewConfigPatch, options?: ChangeOptions) => void;
  /** Saves the temporary changes to the view; `false` when refused (toast shown). */
  readonly save: () => Promise<boolean>;
  /** Drops the temporary changes. */
  readonly discard: () => void;
}

/**
 * The effective config of a view and how to change it (FRONTEND §3.2). The
 * view bar and the grid of the same view share one state (`viewSessions`).
 */
export function useViewConfig(view: ViewDto, canSave: boolean): ViewConfigState {
  const queryClient = useQueryClient();
  const viewId = view.id;
  const tableId = view.table_id;
  const session = useSyncExternalStore(viewSessions.subscribe, () => viewSessions.get(viewId));
  // The table's fields as this user reads them (loaded by the route): a
  // temporary change naming another field is not applied, and dropped.
  const { data: fields } = useQuery({ ...fieldsQuery(tableId), enabled: false });
  const readable = useMemo(
    () => (fields === undefined ? undefined : new Set(fields.items.map((field) => field.id))),
    [fields],
  );
  const draft = useMemo(() => {
    if (readable === undefined) return session.draft;
    const stale = unreadableKeys(session.draft, readable);
    return stale.length === 0 ? session.draft : omitKeys(session.draft, stale);
  }, [session.draft, readable]);
  useEffect(() => {
    if (readable !== undefined) viewSessions.dropUnreadable(viewId, readable);
  }, [viewId, readable, session.draft]);

  // A saved config catching up with a temporary change ends it.
  useEffect(() => {
    viewSessions.settle(viewId, view.config);
  }, [viewId, view.config]);

  const config = useMemo(
    () => effectiveConfig(view.config, session.pending, draft),
    [view.config, session.pending, draft],
  );
  const unsaved = useMemo(() => changedKeys(view.config, draft), [view.config, draft]);

  const change = useCallback(
    (patch: ViewConfigPatch, options: ChangeOptions = {}) => {
      if (canSave && options.temporary !== true) {
        viewSessions.autosave(viewId, patch, { queryClient, tableId });
      } else {
        viewSessions.setTemporary(viewId, patch);
      }
    },
    [canSave, viewId, tableId, queryClient],
  );
  const save = useCallback(
    () => viewSessions.save(viewId, { queryClient, tableId }),
    [viewId, tableId, queryClient],
  );
  const discard = useCallback(() => {
    viewSessions.discard(viewId);
  }, [viewId]);

  return {
    config,
    saved: view.config,
    unsaved,
    saving: session.saving,
    canSave,
    change,
    save,
    discard,
  };
}
