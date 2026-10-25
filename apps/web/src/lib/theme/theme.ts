import { useCallback, useSyncExternalStore } from 'react';

import { PREFERENCE_KEYS, readPreference, writePreference } from '../preferences';

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

function systemTheme(): ResolvedTheme {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
    ? 'dark'
    : 'light';
}

let preference: ThemePreference = 'system';
const listeners = new Set<() => void>();

function apply(): void {
  const resolved = preference === 'system' ? systemTheme() : preference;
  const root = document.documentElement;
  if (root.dataset['theme'] === resolved) return;
  // Switch every color at once: no element fades through unreadable
  // intermediate colors (see `data-theme-switching` in styles/index.css).
  root.dataset['themeSwitching'] = '';
  root.dataset['theme'] = resolved;
  // Reading a computed style applies the new colors before transitions return.
  window.getComputedStyle(root).getPropertyValue('color');
  window.requestAnimationFrame(() => {
    delete root.dataset['themeSwitching'];
  });
}

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Applies the stored theme (`data-theme` on <html>, FRONTEND §9.3) and
 * follows system changes while the preference is "system". Called once
 * before the first render.
 */
export function initTheme(): void {
  const stored = readPreference(PREFERENCE_KEYS.theme);
  preference = isThemePreference(stored) ? stored : 'system';
  apply();
  if (typeof window.matchMedia === 'function') {
    window.matchMedia(DARK_QUERY).addEventListener('change', () => {
      if (preference === 'system') {
        apply();
        emit();
      }
    });
  }
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  writePreference(PREFERENCE_KEYS.theme, next === 'system' ? null : next);
  apply();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
} {
  const current = useSyncExternalStore(subscribe, () => preference);
  const setPreference = useCallback((next: ThemePreference) => {
    setThemePreference(next);
  }, []);
  return { preference: current, setPreference };
}
