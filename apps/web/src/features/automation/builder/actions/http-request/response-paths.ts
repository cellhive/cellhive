import { useSyncExternalStore } from 'react';

/**
 * Response values the author picked for later steps (BACKLOG T613: "choose
 * the `path` of the response"), by HTTP step id, for the page's lifetime.
 * Nothing about them is saved: the definition only stores the `{ step,
 * path }` values a later step uses, which the "+" menu lists again after a
 * reload (`httpStepPaths`). Step ids are unique (`act_…`), so one map
 * serves every automation opened in the tab.
 */

const picked = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly string[] = [];

function emit(): void {
  for (const listener of listeners) listener();
}

/** The paths picked for step `stepId` (a stable array until it changes). */
export function pickedResponsePaths(stepId: string): readonly string[] {
  return picked.get(stepId) ?? EMPTY;
}

export function pickResponsePath(stepId: string, path: string): void {
  const current = pickedResponsePaths(stepId);
  if (current.includes(path)) return;
  picked.set(stepId, [...current, path]);
  emit();
}

export function unpickResponsePath(stepId: string, path: string): void {
  const current = pickedResponsePaths(stepId);
  if (!current.includes(path)) return;
  picked.set(
    stepId,
    current.filter((item) => item !== path),
  );
  emit();
}

/** Test helper: forget everything. */
export function resetPickedResponsePaths(): void {
  picked.clear();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePickedResponsePaths(stepId: string): readonly string[] {
  return useSyncExternalStore(
    subscribe,
    () => pickedResponsePaths(stepId),
    () => pickedResponsePaths(stepId),
  );
}
