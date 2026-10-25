import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { readPreference, treeExpandPreferenceKey, writePreference } from '../../../lib/preferences';

/**
 * Which branches of a sub-record tree are open (T417, BACKLOG S4 design
 * decision 3): per user and view, on this device (localStorage), never in
 * the view config — like collapsed groups (T312). `levels` is how many
 * levels show by default ("Open N levels": 1 = the roots only, the
 * default); the records toggled afterwards are the exceptions, so records
 * loaded later follow `levels`.
 */
export interface ExpandState {
  /** 1…10: a record at depth `d` (0 = root) is open when `d < levels - 1`. */
  readonly levels: number;
  /** Record ids toggled against `levels`. */
  readonly except: readonly string[];
}

export const MIN_LEVELS = 1;
export const MAX_LEVELS = 10;
/** Exceptions kept per view (oldest dropped first). */
export const MAX_EXPAND_EXCEPTIONS = 2_000;

export const DEFAULT_EXPAND: ExpandState = { levels: MIN_LEVELS, except: [] };

function clampLevels(levels: number): number {
  return Math.min(MAX_LEVELS, Math.max(MIN_LEVELS, Math.round(levels)));
}

/** Whether a record at `depth` shows its children. */
export function isExpanded(state: ExpandState, recordId: string, depth: number): boolean {
  return depth < state.levels - 1 !== state.except.includes(recordId);
}

export function toggleExpanded(state: ExpandState, recordId: string): ExpandState {
  const except = state.except.includes(recordId)
    ? state.except.filter((item) => item !== recordId)
    : [...state.except, recordId].slice(-MAX_EXPAND_EXCEPTIONS);
  return { levels: state.levels, except };
}

/** Opens or closes one record (the same state when it already is). */
export function setExpanded(
  state: ExpandState,
  recordId: string,
  depth: number,
  expanded: boolean,
): ExpandState {
  return isExpanded(state, recordId, depth) === expanded ? state : toggleExpanded(state, recordId);
}

/** "Open N levels" (the toolbar): every exception is dropped. */
export function openLevels(levels: number): ExpandState {
  return { levels: clampLevels(levels), except: [] };
}

/** A stored state (untrusted: another app version, a user edit); anything invalid → the default. */
export function parseExpand(raw: string | null): ExpandState {
  if (raw === null) return DEFAULT_EXPAND;
  try {
    const value = JSON.parse(raw) as { levels?: unknown; except?: unknown };
    const levels =
      typeof value.levels === 'number' && Number.isFinite(value.levels)
        ? clampLevels(value.levels)
        : MIN_LEVELS;
    const except = Array.isArray(value.except)
      ? value.except
          .filter(
            (item): item is string => typeof item === 'string' && /^rec_\w{1,64}$/u.test(item),
          )
          .slice(-MAX_EXPAND_EXCEPTIONS)
      : [];
    return { levels, except };
  } catch {
    return DEFAULT_EXPAND;
  }
}

export function serializeExpand(state: ExpandState): string | null {
  return state.levels === MIN_LEVELS && state.except.length === 0 ? null : JSON.stringify(state);
}

type Listener = () => void;

interface StoreKey {
  readonly id: string;
  readonly stored: ReturnType<typeof treeExpandPreferenceKey> | null;
}

/** Expand states of this tab by storage key, read from localStorage once. */
class ExpandStore {
  readonly #states = new Map<string, ExpandState>();
  readonly #listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get(key: StoreKey): ExpandState {
    let state = this.#states.get(key.id);
    if (state === undefined) {
      state = key.stored === null ? DEFAULT_EXPAND : parseExpand(readPreference(key.stored));
      this.#states.set(key.id, state);
    }
    return state;
  }

  set(key: StoreKey, state: ExpandState): void {
    this.#states.set(key.id, state);
    if (key.stored !== null) writePreference(key.stored, serializeExpand(state));
    for (const listener of this.#listeners) listener();
  }

  /** Tests: forget what was read. */
  reset(): void {
    this.#states.clear();
  }
}

export const expandStore = new ExpandStore();

export interface TreeExpand {
  readonly state: ExpandState;
  /** `open`: the record opens by default whatever the levels (an ancestor of a filter match). */
  readonly isExpanded: (recordId: string, depth: number, open?: boolean) => boolean;
  readonly toggle: (recordId: string) => void;
  readonly setExpanded: (recordId: string, depth: number, expanded: boolean) => void;
  readonly openLevels: (levels: number) => void;
}

/** The open branches of a view's tree for the signed-in user (`null`: this page only). */
export function useTreeExpand(userId: string | null, viewId: string): TreeExpand {
  const key = useMemo<StoreKey>(() => {
    const stored = userId === null ? null : treeExpandPreferenceKey(userId, viewId);
    return { id: stored ?? `memory:${viewId}`, stored };
  }, [userId, viewId]);
  const state = useSyncExternalStore(expandStore.subscribe, () => expandStore.get(key));
  const update = useCallback(
    (next: (current: ExpandState) => ExpandState) => {
      const current = expandStore.get(key);
      const changed = next(current);
      if (changed !== current) expandStore.set(key, changed);
    },
    [key],
  );
  return useMemo(() => {
    // A set: the layout asks for every loaded record.
    const except = new Set(state.except);
    const levels = state.levels;
    return {
      state,
      isExpanded: (recordId: string, depth: number, open = false) =>
        (open || depth < levels - 1) !== except.has(recordId),
      toggle: (recordId: string) => {
        update((current) => toggleExpanded(current, recordId));
      },
      setExpanded: (recordId: string, depth: number, expanded: boolean) => {
        update((current) => setExpanded(current, recordId, depth, expanded));
      },
      openLevels: (next: number) => {
        update(() => openLevels(next));
      },
    };
  }, [state, update]);
}
