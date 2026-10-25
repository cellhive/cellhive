/**
 * Keys of a grid shown as a sub-record tree (T417, BACKLOG S4 design
 * decision 3, FRONTEND §6.2). Pure.
 *
 * - Ctrl/⌘+] indents (child of the row above), Ctrl/⌘+[ outdents — as in
 *   Smartsheet. On macOS ⌘+[ / ⌘+] are the browser's Back / Forward: they
 *   are taken (default prevented) **only** while the grid has the focus
 *   and no cell editor is open; anywhere else the browser keeps them.
 * - Alt+Shift+→ / Alt+Shift+← do the same (a fallback for keyboards where
 *   the brackets need a modifier).
 * - On the first column, → opens a closed branch and ← closes an open one
 *   (on a leaf or a closed branch ← goes to the parent row) — the treegrid
 *   pattern; elsewhere the arrows move between cells as always.
 * - Tab keeps moving to the next cell (it never indents).
 */

export type TreeKeyAction = 'indent' | 'outdent' | 'expand' | 'collapse' | 'parent';

export interface TreeKeyEvent {
  readonly key: string;
  /** `KeyboardEvent.code` when known: brackets typed through another layout. */
  readonly code?: string | undefined;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export interface TreeKeyContext {
  /** The grid itself has the keyboard focus (not the page, a menu or a field). */
  readonly gridFocused: boolean;
  /** A cell editor is open (the brackets are typed into it). */
  readonly editing: boolean;
  /** Column of the selected cell (0 = the primary field, where the tree is drawn). */
  readonly column: number | undefined;
  /** The selected row has children. */
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  /** The selected row is not a root. */
  readonly hasParent: boolean;
}

function isBracket(event: TreeKeyEvent, side: 'left' | 'right'): boolean {
  if (side === 'right') return event.code === 'BracketRight' || event.key === ']';
  return event.code === 'BracketLeft' || event.key === '[';
}

/**
 * The tree action of a key, `null` when the key is not the tree's (the
 * caller lets it through untouched — and so must not prevent the default).
 */
export function treeKeyAction(event: TreeKeyEvent, context: TreeKeyContext): TreeKeyAction | null {
  if (!context.gridFocused || context.editing) return null;
  const primary = event.ctrlKey || event.metaKey;
  if (primary && !event.altKey && !event.shiftKey) {
    if (isBracket(event, 'right')) return 'indent';
    if (isBracket(event, 'left')) return 'outdent';
    return null;
  }
  if (event.altKey && event.shiftKey && !primary) {
    if (event.key === 'ArrowRight') return 'indent';
    if (event.key === 'ArrowLeft') return 'outdent';
    return null;
  }
  if (primary || event.altKey || event.shiftKey || context.column !== 0) return null;
  if (event.key === 'ArrowRight') {
    return context.hasChildren && !context.expanded ? 'expand' : null;
  }
  if (event.key === 'ArrowLeft') {
    if (context.hasChildren && context.expanded) return 'collapse';
    return context.hasParent ? 'parent' : null;
  }
  return null;
}

/** Label of the indent / outdent shortcuts for menus and the shortcut list. */
export function treeShortcutLabel(action: 'indent' | 'outdent', apple: boolean): string {
  const bracket = action === 'indent' ? ']' : '[';
  return apple ? `⌘${bracket}` : `Ctrl+${bracket}`;
}
