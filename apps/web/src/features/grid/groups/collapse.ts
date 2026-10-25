import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  groupCollapsePreferenceKey,
  readPreference,
  writePreference,
} from '../../../lib/preferences';

/**
 * Which groups of a grid are collapsed (T312): per user and view, on this
 * device (localStorage), never in the view config. "Collapse all" and
 * "Expand all" set the mode; headers toggled afterwards are the exceptions,
 * so groups that appear later follow the mode.
 */
export interface CollapseState {
  readonly mode: 'expanded' | 'collapsed';
  /** Group keys toggled against the mode. */
  readonly except: readonly string[];
}

/** Exceptions kept per view (oldest dropped first). */
export const MAX_COLLAPSE_EXCEPTIONS = 2_000;

export const EXPANDED: CollapseState = { mode: 'expanded', except: [] };

export function isCollapsed(state: CollapseState, key: string): boolean {
  return (state.mode === 'collapsed') !== state.except.includes(key);
}

export function toggleGroup(state: CollapseState, key: string): CollapseState {
  const except = state.except.includes(key)
    ? state.except.filter((item) => item !== key)
    : [...state.except, key].slice(-MAX_COLLAPSE_EXCEPTIONS);
  return { mode: state.mode, except };
}

/** Sets one group collapsed or expanded (no change when it already is). */
export function setGroupCollapsed(
  state: CollapseState,
  key: string,
  collapsed: boolean,
): CollapseState {
  return isCollapsed(state, key) === collapsed ? state : toggleGroup(state, key);
}

/** Sets several groups collapsed or expanded (the same state when none changes). */
export function setGroupsCollapsed(
  state: CollapseState,
  keys: readonly string[],
  collapsed: boolean,
): CollapseState {
  let next = state;
  for (const key of keys) next = setGroupCollapsed(next, key, collapsed);
  return next;
}

export function collapseAll(): CollapseState {
  return { mode: 'collapsed', except: [] };
}

export function expandAll(): CollapseState {
  return EXPANDED;
}

/** A stored state (untrusted: another app version, a user edit); anything invalid → all expanded. */
export function parseCollapse(raw: string | null): CollapseState {
  if (raw === null) return EXPANDED;
  try {
    const value = JSON.parse(raw) as { mode?: unknown; except?: unknown };
    const mode = value.mode === 'collapsed' ? 'collapsed' : 'expanded';
    const except = Array.isArray(value.except)
      ? value.except
          .filter((item): item is string => typeof item === 'string' && item.length <= 2_000)
          .slice(-MAX_COLLAPSE_EXCEPTIONS)
      : [];
    return { mode, except };
  } catch {
    return EXPANDED;
  }
}

export function serializeCollapse(state: CollapseState): string | null {
  return state.mode === 'expanded' && state.except.length === 0 ? null : JSON.stringify(state);
}

type Listener = () => void;

/** Where a state lives: always in memory, in localStorage when the user is known. */
interface StoreKey {
  readonly id: string;
  readonly stored: ReturnType<typeof groupCollapsePreferenceKey> | null;
}

/** Collapse states of this tab by storage key, read from localStorage once. */
class CollapseStore {
  readonly #states = new Map<string, CollapseState>();
  readonly #listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get(key: StoreKey): CollapseState {
    let state = this.#states.get(key.id);
    if (state === undefined) {
      state = key.stored === null ? EXPANDED : parseCollapse(readPreference(key.stored));
      this.#states.set(key.id, state);
    }
    return state;
  }

  set(key: StoreKey, state: CollapseState): void {
    this.#states.set(key.id, state);
    if (key.stored !== null) writePreference(key.stored, serializeCollapse(state));
    for (const listener of this.#listeners) listener();
  }

  /** Tests: forget what was read. */
  reset(): void {
    this.#states.clear();
  }
}

export const collapseStore = new CollapseStore();

/**
 * Whether some group of the view may be collapsed for this user (read
 * before the counts arrive): when none is, the first rows are the first
 * server rows and block 0 can load alongside the counts.
 */
export function mayHaveCollapsed(userId: string | null, viewId: string): boolean {
  const stored = userId === null ? null : groupCollapsePreferenceKey(userId, viewId);
  const state = collapseStore.get({ id: stored ?? `memory:${viewId}`, stored });
  return state.mode === 'collapsed' || state.except.length > 0;
}

export interface GroupCollapse {
  readonly state: CollapseState;
  readonly isCollapsed: (key: string) => boolean;
  readonly toggle: (key: string) => void;
  readonly setCollapsed: (key: string, collapsed: boolean) => void;
  /** Several groups at once (the subgroups of a group, T320a header menu). */
  readonly setManyCollapsed: (keys: readonly string[], collapsed: boolean) => void;
  readonly collapseAll: () => void;
  readonly expandAll: () => void;
}

/**
 * The collapsed groups of a view for the signed-in user (`userId` `null`
 * while unknown: kept for this page only).
 */
export function useGroupCollapse(userId: string | null, viewId: string): GroupCollapse {
  const key = useMemo<StoreKey>(() => {
    const stored = userId === null ? null : groupCollapsePreferenceKey(userId, viewId);
    return { id: stored ?? `memory:${viewId}`, stored };
  }, [userId, viewId]);
  const state = useSyncExternalStore(collapseStore.subscribe, () => collapseStore.get(key));
  const update = useCallback(
    (next: (current: CollapseState) => CollapseState) => {
      const current = collapseStore.get(key);
      const changed = next(current);
      if (changed !== current) collapseStore.set(key, changed);
    },
    [key],
  );
  return useMemo(() => {
    // A set: the model asks once per header (up to 30 000).
    const except = new Set(state.except);
    const collapsedByDefault = state.mode === 'collapsed';
    return {
      state,
      isCollapsed: (group: string) => collapsedByDefault !== except.has(group),
      toggle: (group: string) => {
        update((current) => toggleGroup(current, group));
      },
      setManyCollapsed: (groups: readonly string[], collapsed: boolean) => {
        update((current) => setGroupsCollapsed(current, groups, collapsed));
      },
      setCollapsed: (group: string, collapsed: boolean) => {
        update((current) => setGroupCollapsed(current, group, collapsed));
      },
      collapseAll: () => {
        update(() => collapseAll());
      },
      expandAll: () => {
        update(() => expandAll());
      },
    };
  }, [state, update]);
}
