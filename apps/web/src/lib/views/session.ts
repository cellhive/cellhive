import { api } from '../api';
import { isApiError } from '../api/client';
import {
  onPreferenceUserChange,
  preferenceUser,
  readPreference,
  viewDraftPreferenceKey,
  writePreference,
} from '../preferences';
import { keys } from '../query/keys';
import { expectOwnSchemaChange, retractOwnSchemaChange } from '../realtime/own-changes';
import { showErrorToast } from '../toast/toast';

import { replaceCachedView } from './cache';
import {
  isEmptyPatch,
  omitKeys,
  parseDraft,
  pickKeys,
  QUERY_KEYS,
  sameValue,
  serializeDraft,
  unreadableKeys,
  type EffectiveViewConfig,
  type ViewConfigKey,
  type ViewConfigPatch,
} from './config';

import type { ViewDto } from '@cellhive/contracts';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Client state of a view's config besides what the server has saved
 * (FRONTEND §3.2):
 * - `draft`: temporary changes, seen only by this user on this device
 *   (kept in localStorage under the user's id; in memory only while the
 *   user is unknown) until saved or discarded — changes of those who
 *   may not save the view, of a locked view, the migrated T207 layout, and
 *   (T311) filter/sort/group of the toolbar;
 * - `pending`: changes being saved (debounced `PATCH /views/:id`), shown at
 *   once and rolled back if the server refuses them.
 */
export interface ViewSession {
  readonly draft: ViewConfigPatch;
  readonly pending: ViewConfigPatch;
  /** A `PATCH` of this view is on its way. */
  readonly saving: boolean;
}

/** Where saves go: the query cache to update and the table of the view. */
export interface SaveTarget {
  readonly queryClient: QueryClient;
  readonly tableId: string;
}

/** Changes arriving within this delay are saved in one `PATCH` (resizing, several toggles). */
export const AUTOSAVE_DELAY_MS = 600;

const EMPTY: ViewSession = { draft: {}, pending: {}, saving: false };

const OWN_VIEW_CHANGE = { schema: 1, permission: 0 } as const;

/** `PATCH /views/:id { config }`, then the cached list gets the saved view. */
async function patchConfig(
  target: SaveTarget,
  viewId: string,
  config: ViewConfigPatch,
): Promise<ViewDto> {
  // The `schema.changed` this causes is ours: the cache is updated here (own-changes.ts).
  expectOwnSchemaChange(target.tableId, OWN_VIEW_CHANGE);
  let view: ViewDto;
  try {
    view = await api.views.update(viewId, { config });
  } catch (error) {
    retractOwnSchemaChange(target.tableId, OWN_VIEW_CHANGE);
    throw error;
  }
  // A list fetched before the save must not overwrite it.
  await target.queryClient.cancelQueries({ queryKey: keys.views(target.tableId) });
  replaceCachedView(target.queryClient, view);
  if (QUERY_KEYS.some((key) => key in config)) {
    // Rows fetched while the change was on its way were ordered by the old saved config.
    void target.queryClient.invalidateQueries({ queryKey: keys.recordBlocks(target.tableId) });
  }
  return view;
}

/** The server no longer lets this user save the view (rights changed, view locked meanwhile). */
function cannotSave(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.status === 403 ||
      (error.status === 422 && error.errors.some((item) => item.code === 'VIEW_LOCKED')))
  );
}

/**
 * The sessions of every view touched in this tab. A module singleton like
 * the undo stacks (FRONTEND §6.1): the view bar and the grid of the same
 * view read one state.
 */
export class ViewSessions {
  readonly #states = new Map<string, ViewSession>();
  readonly #listeners = new Set<() => void>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #targets = new Map<string, SaveTarget>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** State of a view; the signed-in user's stored draft is read on first use. */
  get(viewId: string): ViewSession {
    let state = this.#states.get(viewId);
    if (state === undefined) {
      const user = preferenceUser();
      const draft =
        user === null ? {} : parseDraft(readPreference(viewDraftPreferenceKey(user, viewId)));
      state = isEmptyPatch(draft) ? EMPTY : { ...EMPTY, draft };
      this.#states.set(viewId, state);
    }
    return state;
  }

  #set(viewId: string, change: (state: ViewSession) => ViewSession): void {
    const previous = this.get(viewId);
    const next = change(previous);
    if (next === previous) return;
    this.#states.set(viewId, next);
    const user = preferenceUser();
    if (next.draft !== previous.draft && user !== null) {
      writePreference(viewDraftPreferenceKey(user, viewId), serializeDraft(next.draft));
    }
    for (const listener of this.#listeners) listener();
  }

  /** Temporary changes: only on this device until saved (or discarded). */
  setTemporary(viewId: string, patch: ViewConfigPatch): void {
    if (isEmptyPatch(patch)) return;
    this.#set(viewId, (state) => ({ ...state, draft: { ...state.draft, ...patch } }));
  }

  /** Drops temporary changes (`keys`: only those). */
  discard(viewId: string, keys?: readonly ViewConfigKey[]): void {
    this.#set(viewId, (state) => {
      if (isEmptyPatch(state.draft)) return state;
      return { ...state, draft: keys === undefined ? {} : omitKeys(state.draft, keys) };
    });
  }

  /**
   * Temporary changes equal to the saved config are no longer changes
   * (someone saved the same, or the user put the value back).
   */
  settle(viewId: string, saved: EffectiveViewConfig): void {
    const state = this.get(viewId);
    const equal = (Object.keys(state.draft) as ViewConfigKey[]).filter((key) =>
      sameValue(state.draft[key], saved[key]),
    );
    if (equal.length > 0) this.discard(viewId, equal);
  }

  /**
   * Changes saved to the view: shown at once, sent after
   * {@link AUTOSAVE_DELAY_MS}; a temporary change of the same key is replaced.
   */
  autosave(viewId: string, patch: ViewConfigPatch, target: SaveTarget): void {
    if (isEmptyPatch(patch)) return;
    this.#targets.set(viewId, target);
    const changed = Object.keys(patch) as ViewConfigKey[];
    this.#set(viewId, (state) => ({
      ...state,
      draft: omitKeys(state.draft, changed),
      pending: { ...state.pending, ...patch },
    }));
    this.#schedule(viewId);
  }

  #schedule(viewId: string, delay = AUTOSAVE_DELAY_MS): void {
    const timer = this.#timers.get(viewId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.set(
      viewId,
      setTimeout(() => {
        this.#timers.delete(viewId);
        void this.flush(viewId);
      }, delay),
    );
  }

  /** Sends the pending changes now (one request at a time per view). */
  async flush(viewId: string): Promise<void> {
    const state = this.get(viewId);
    const target = this.#targets.get(viewId);
    if (state.saving || isEmptyPatch(state.pending) || target === undefined) return;
    const timer = this.#timers.get(viewId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(viewId);
    }
    const sent = state.pending;
    this.#set(viewId, (current) => ({ ...current, saving: true }));
    // Keys still holding what was sent (a newer change of a key is sent next).
    const unchanged = (pending: ViewConfigPatch) =>
      (Object.keys(sent) as ViewConfigKey[]).filter((key) => pending[key] === sent[key]);
    try {
      await patchConfig(target, viewId, sent);
      this.#set(viewId, (current) => ({
        ...current,
        pending: omitKeys(current.pending, unchanged(current.pending)),
        saving: false,
      }));
    } catch (error) {
      const done = unchanged(this.get(viewId).pending);
      const kept = cannotSave(error);
      this.#set(viewId, (current) => ({
        // No longer allowed: the change stays on this device as a temporary one.
        draft: kept ? { ...pickKeys(sent, done), ...current.draft } : current.draft,
        pending: omitKeys(current.pending, done),
        saving: false,
      }));
      showErrorToast(error);
      if (kept || (isApiError(error) && error.status === 404)) {
        void target.queryClient.invalidateQueries({ queryKey: keys.views(target.tableId) });
      }
    }
    if (!isEmptyPatch(this.get(viewId).pending)) this.#schedule(viewId, 0);
  }

  /**
   * Saves the temporary changes to the view (`keys`: only those). Resolves
   * `true` when saved; on failure the changes stay and a toast explains.
   */
  async save(
    viewId: string,
    target: SaveTarget,
    keys?: readonly ViewConfigKey[],
  ): Promise<boolean> {
    const draft = this.get(viewId).draft;
    const sent = keys === undefined ? draft : pickKeys(draft, keys);
    if (isEmptyPatch(sent)) return true;
    try {
      await patchConfig(target, viewId, sent);
    } catch (error) {
      showErrorToast(error);
      return false;
    }
    const saved = (Object.keys(sent) as ViewConfigKey[]).filter(
      (key) => this.get(viewId).draft[key] === sent[key],
    );
    this.discard(viewId, saved);
    return true;
  }

  /** The view was deleted: nothing of it is kept. */
  forget(viewId: string): void {
    const timer = this.#timers.get(viewId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(viewId);
    this.#targets.delete(viewId);
    this.#states.delete(viewId);
    const user = preferenceUser();
    if (user !== null) writePreference(viewDraftPreferenceKey(user, viewId), null);
    for (const listener of this.#listeners) listener();
  }

  /**
   * Drops temporary changes that name fields the user cannot read (any
   * longer): `readable` is the table's field list as the user reads it.
   */
  dropUnreadable(viewId: string, readable: ReadonlySet<string>): void {
    const stale = unreadableKeys(this.get(viewId).draft, readable);
    if (stale.length > 0) this.discard(viewId, stale);
  }

  /** Forgets everything held in memory (stored drafts stay): another user, or tests. */
  reset(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#targets.clear();
    this.#states.clear();
    for (const listener of this.#listeners) listener();
  }
}

export const viewSessions = new ViewSessions();

// Signed out, or another user signed in: nothing of the previous user's drafts stays in memory.
onPreferenceUserChange(() => {
  viewSessions.reset();
});
