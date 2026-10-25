import { useEffect, useRef } from 'react';

import type { GridTree } from './types';

/**
 * Accessibility of a grid shown as a tree (T417, FRONTEND §9.2): glide's
 * hidden table becomes a `treegrid` and each record row carries
 * `aria-level` (1 = root) and, on a branch, `aria-expanded` — kept in sync
 * whenever glide re-renders the rows it lists (scrolling) or the tree
 * changes (`version`).
 */
export function useTreeGridA11y(
  container: HTMLElement | null,
  tree: GridTree | undefined,
  version: number,
): void {
  const latest = useRef(tree);
  useEffect(() => {
    latest.current = tree;
  });
  useEffect(() => {
    if (container === null || tree === undefined) return;
    const apply = () => {
      const current = latest.current;
      if (current === undefined) return;
      const table = container.querySelector('table[role="grid"], table[role="treegrid"]');
      if (table === null) return;
      if (table.getAttribute('role') !== 'treegrid') table.setAttribute('role', 'treegrid');
      for (const row of table.querySelectorAll('tbody > tr[aria-rowindex]')) {
        const index = Number(row.getAttribute('aria-rowindex')) - 2;
        const node = current.nodeAt(index);
        const level = node === undefined ? null : String(node.depth + 1);
        if (level !== null && row.getAttribute('aria-level') !== level) {
          row.setAttribute('aria-level', level);
        }
        const expanded = node === undefined || node.childCount === 0 ? null : String(node.expanded);
        if (expanded === null) row.removeAttribute('aria-expanded');
        else if (row.getAttribute('aria-expanded') !== expanded) {
          row.setAttribute('aria-expanded', expanded);
        }
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      // Back to glide's own table (the tree may be turned off); the next tree sets it again.
      const table = container.querySelector('table[role="treegrid"]');
      table?.setAttribute('role', 'grid');
      for (const row of container.querySelectorAll('tr[aria-level]')) {
        row.removeAttribute('aria-level');
        row.removeAttribute('aria-expanded');
      }
    };
  }, [container, tree, version]);
}
