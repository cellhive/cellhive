import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';

import type { ChartColors } from '../model/chart-model';
import type { ChartTheme } from '../model/chart-option';

export interface ResolvedChartTheme extends ChartTheme, ChartColors {}

const PALETTE_SIZE = 8;

/** Reads the chart tokens of the current theme (`tokens.css`, FRONTEND §9.3). */
export function readChartTheme(root: Element = document.documentElement): ResolvedChartTheme {
  const style = getComputedStyle(root);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    palette: Array.from({ length: PALETTE_SIZE }, (_, index) =>
      token(`--chart-${String(index)}`, '#2a78d6'),
    ),
    other: token('--chart-other', '#8b949f'),
    text: token('--text', '#16191d'),
    muted: token('--text-muted', '#5b6470'),
    line: token('--border', '#e1e4e8'),
    surface: token('--surface', '#ffffff'),
    font: token('--font-ui', 'sans-serif'),
  };
}

function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}

/**
 * (T812) The element whose tokens the charts read: the dashboard page root,
 * which carries the dashboard's own theme (`data-dashboard-theme`, palette
 * as `--chart-*`). Without one, `<html>`.
 */
export const ChartThemeRoot = createContext<HTMLElement | null>(null);

const OBSERVED = ['data-theme', 'data-dashboard-theme', 'class', 'style'];

/**
 * The chart theme, read again when the app theme changes (`data-theme` on
 * `<html>`), the dashboard's theme changes (its root element) or, without
 * a choice, when the system switches light/dark.
 */
export function useChartTheme(): ResolvedChartTheme {
  const root = useContext(ChartThemeRoot);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: OBSERVED });
      if (root !== null) observer.observe(root, { attributes: true, attributeFilter: OBSERVED });
      const media = darkQuery();
      media?.addEventListener('change', onChange);
      return () => {
        observer.disconnect();
        media?.removeEventListener('change', onChange);
      };
    },
    [root],
  );
  // A string snapshot: equal tokens give an equal snapshot, so no render loop.
  const snapshot = useSyncExternalStore(subscribe, () =>
    JSON.stringify(readChartTheme(root ?? document.documentElement)),
  );
  return useMemo(() => JSON.parse(snapshot) as ResolvedChartTheme, [snapshot]);
}

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
}

/** `prefers-reduced-motion: reduce` (charts then draw without animation, S7 decision #20). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = reducedMotionQuery();
      query?.addEventListener('change', onChange);
      return () => query?.removeEventListener('change', onChange);
    },
    () => reducedMotionQuery()?.matches ?? false,
  );
}
