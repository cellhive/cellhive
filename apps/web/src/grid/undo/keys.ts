import type { KeyboardEvent } from 'react';

/** Apple platforms show ⌘ for the primary modifier (FRONTEND §6.2). */
export function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad/u.test(navigator.platform);
}

type KeyEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>;

/** What a key of the page level does (FRONTEND §6.2); the grid handles the others itself. */
export type PageShortcut = 'undo' | 'redo' | 'shortcuts' | null;

/**
 * Ctrl/⌘+Z undo, Shift+Ctrl/⌘+Z and Ctrl+Y redo, `?` the shortcut list.
 * Keys typed into a text field keep their usual meaning (the caller checks
 * the target).
 */
export function pageShortcut(event: KeyEvent): PageShortcut {
  const primary = event.ctrlKey || event.metaKey;
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (primary && key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'y') return 'redo';
  if (!primary && event.key === '?') return 'shortcuts';
  return null;
}

/** Whether keys typed there belong to a text field (native undo, typing "?"). */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  if (target.tagName !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(
    type,
  );
}
