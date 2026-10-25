import { useEffect, useRef } from 'react';

import { stableQueryHash } from '../../../lib/query/keys';

import type { PaintedRule } from '../../../grid';

/** What decides which rule a record matches: everything but the color (a paint, client side). */
export function colorRulesKey(rules: readonly (PaintedRule & object)[] | undefined): string {
  return stableQueryHash(
    (rules ?? []).map((rule) => {
      // The color is left out: it only repaints.
      return { ...rule, color: null };
    }),
  );
}

/**
 * (T816) The rows' colors (`record.meta.color`) are computed by the server
 * with the view's **saved** rules: when they change (saved here, or in
 * another tab — `schema.changed` reloads the view), the rows on screen are
 * fetched again. A new color of the same rule only repaints.
 */
export function useColorRulesRefetch(
  savedRules: readonly PaintedRule[] | undefined,
  source: { refetchVisible: (clearNew?: boolean) => void },
): void {
  const key = colorRulesKey(savedRules);
  const seen = useRef(key);
  useEffect(() => {
    if (seen.current === key) return;
    seen.current = key;
    source.refetchVisible(false);
  }, [key, source]);
}
